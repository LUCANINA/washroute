// ─────────────────────────────────────────────────────────────────────────────
// xero-meter.ts — what a Xero call costs, recorded rather than estimated
//
// Session 265. Eleven edge functions share one tenant-wide Xero budget, measured
// on 2026-09-01 at 1,000 calls/day (NOT the 5,000 the docs quote), enforced as a
// ROLLING window. Until this file existed, nothing in the project counted a single
// call, so "what spent the day's budget?" could only ever be answered by
// multiplying invocation counts by a hand-read estimate of calls-per-invocation.
// This module makes it a reading.
//
// TWO NUMBERS, FROM TWO SOURCES, AND THAT IS THE POINT.
//
//   calls_made     counted here, in process. Exact for this invocation.
//   remaining_day  Xero's own X-DayLimit-Remaining header. Independent of us.
//
// Either alone is satisfied by a meter that counts nothing: a counter with no
// outside check agrees with itself, and a header we merely echo tells us nothing
// about who spent it. Together they cross-check — if calls_made climbs while
// remaining_day does not fall, one of the two is lying and we can see it. This is
// the same discipline as the rollforward's independent opening (session 246): a
// check whose inputs share a source cannot fail.
//
// WHAT COUNTS. Only api.xero.com. The OAuth token endpoint is identity.xero.com
// and is NOT billed against the accounting limit, so counting it would overstate
// every caller by one and make the meter disagree with Xero's own header for a
// reason that is our fault. Requests to any other host are tallied separately as
// `auxiliaryCalls` and never enter calls_made.
//
// RETRIES COUNT. A 429 that we retry cost a call, and the whole reason this file
// exists is that retries against an exhausted budget are how a day gets burned.
// Anything that reaches the wire increments.
//
// FLUSHING NEVER FAILS THE CALLER. Telemetry that can break the thing it measures
// is worse than no telemetry. flush() swallows its own errors and reports them on
// the return value for a caller that wants to log them.
// ─────────────────────────────────────────────────────────────────────────────

export const XERO_API_HOST = 'api.xero.com'

/** Minimal shape of the Supabase client this needs, so tests need no client. */
export interface MeterSink {
  from(table: string): {
    insert(rows: Record<string, unknown>): Promise<{ error: { message: string } | null }>
  }
}

export type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>

export interface FlushResult {
  written: boolean
  error: string | null
  row: Record<string, unknown>
}

export interface XeroMeter {
  /** Wraps fetch. Counts the call, reads Xero's counters off the response. */
  fetch: FetchLike
  /** api.xero.com calls made so far. The number the daily budget is spent in. */
  readonly calls: number
  /** Calls to other Xero hosts (identity.xero.com). Not billed, not in `calls`. */
  readonly auxiliaryCalls: number
  /** X-DayLimit-Remaining as last seen. null = never sent, which is NOT zero. */
  readonly remainingDay: number | null
  readonly remainingMinute: number | null
  /** True if any response was a 429. */
  readonly rateLimited: boolean
  /** Distinct HTTP statuses seen from api.xero.com, in first-seen order. */
  readonly statuses: number[]
  /** Writes one xero_api_usage row. Never throws. */
  flush(sink: MeterSink | null | undefined): Promise<FlushResult>
  /**
   * Names the mode after the fact. The meter is created before the request body
   * is parsed — deliberately, so that a call made on an error path is still
   * counted — and the mode only becomes known afterwards.
   */
  setMode(mode: string | null | undefined): void
  /** The row flush() would write, without writing it. For tests and dry runs. */
  snapshot(): Record<string, unknown>
}

/**
 * A header value that is present but not a number is NOT a zero. Xero has been
 * observed to send an empty string; parsing that as 0 would report a exhausted
 * budget on a perfectly healthy call, which is the single most misleading thing
 * this file could do.
 */
function parseCounter(raw: string | null): number | null {
  if (raw === null || raw === undefined) return null
  const trimmed = String(raw).trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch (_) {
    // A relative or malformed URL is not api.xero.com, and a meter is not the
    // place to raise about it — the fetch below will fail on its own terms.
    return ''
  }
}

export function createXeroMeter(
  caller: string,
  opts?: { mode?: string | null; fetchImpl?: FetchLike; now?: () => Date },
): XeroMeter {
  const fetchImpl: FetchLike = opts?.fetchImpl ?? ((u, i) => fetch(u, i as RequestInit))
  const now = opts?.now ?? (() => new Date())
  const startedAt = now().toISOString()

  let calls = 0
  let auxiliaryCalls = 0
  let remainingDay: number | null = null
  let remainingMinute: number | null = null
  let rateLimited = false
  let mode: string | null = opts?.mode ?? null
  const statuses: number[] = []

  const wrapped: FetchLike = async (input, init) => {
    const billed = hostOf(String(input)) === XERO_API_HOST
    if (billed) calls++
    else auxiliaryCalls++

    const res = await fetchImpl(input, init)

    if (!billed) return res

    if (!statuses.includes(res.status)) statuses.push(res.status)
    if (res.status === 429) rateLimited = true

    // Never overwrite a real reading with a null one. Some endpoints omit the
    // counters; a later silent response does not mean the budget became unknown.
    const day = parseCounter(res.headers?.get?.('X-DayLimit-Remaining') ?? null)
    const minute = parseCounter(res.headers?.get?.('X-MinLimit-Remaining') ?? null)
    if (day !== null) remainingDay = day
    if (minute !== null) remainingMinute = minute

    return res
  }

  function snapshot(): Record<string, unknown> {
    return {
      caller,
      mode,
      calls_made: calls,
      remaining_day: remainingDay,
      remaining_minute: remainingMinute,
      rate_limited: rateLimited,
      http_statuses: statuses,
      started_at: startedAt,
      finished_at: now().toISOString(),
    }
  }

  return {
    fetch: wrapped,
    get calls() { return calls },
    get auxiliaryCalls() { return auxiliaryCalls },
    get remainingDay() { return remainingDay },
    get remainingMinute() { return remainingMinute },
    get rateLimited() { return rateLimited },
    get statuses() { return statuses.slice() },
    setMode(m) { mode = m === undefined || m === '' ? null : m },
    snapshot,
    async flush(sink) {
      const row = snapshot()
      // An invocation that made no billed call has nothing to say about the
      // budget, and a table full of zero rows makes the real ones harder to see.
      if (calls === 0) return { written: false, error: null, row }
      if (!sink) return { written: false, error: 'no sink', row }
      try {
        const { error } = await sink.from('xero_api_usage').insert(row)
        return { written: !error, error: error ? error.message : null, row }
      } catch (e) {
        return { written: false, error: String((e as Error)?.message ?? e), row }
      }
    },
  }
}
