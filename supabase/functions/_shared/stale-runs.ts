// ─────────────────────────────────────────────────────────────────────────────
// stale-runs.ts — which `running` rows describe a process that is not running?
//
// Session 268. `reconciliation_runs` had EIGHT rows sitting in `running` with no
// `finished_at`, the oldest from 2026-08-27 — a week older than the three the
// notes recorded, because the note counted what was on one screen. They are the
// corpses of runs whose function died mid-flight: the never-booting v64, and
// whatever killed the two on 2026-09-01. Nothing has ever reaped them.
//
// "running" is a lie about a process that is not, and it is not a harmless one:
// the rate limiter reads the newest row and refuses a fresh check for ten
// minutes unless that row says `failed`, so a dead run blocks its own retry.
//
// WHY A TIME LIMIT IS THE RIGHT TEST, and why it is safe:
// the longest run that ever COMPLETED took 77 seconds (measured across all 81
// complete rows, 2026-08-15 to 2026-09-03). A Supabase edge function is killed
// by its own wall-clock limit long before fifteen minutes. So a row still
// `running` after STALE_RUN_MS cannot be a live run — there is no execution
// left for it to belong to — and the reaper cannot race one.
//
// The reaper lives at the START of a run, not at the end of one: a function
// that dies cannot clean up after itself, so the next boot does it. That is
// also why this only works if something boots — which, until the cron added in
// this session, was "when someone pressed Check".
// ─────────────────────────────────────────────────────────────────────────────

/** Fifteen minutes. Eleven times the longest run ever recorded. */
export const STALE_RUN_MS = 15 * 60 * 1000

export type RunRow = {
  id?: string | null
  status?: string | null
  started_at?: string | null
  finished_at?: string | null
}

/**
 * The ids of rows that claim to be running and cannot be.
 *
 * Deliberately narrow. It will not touch:
 *   - anything whose status is not exactly 'running' (a complete or failed row
 *     is already settled, and re-settling it would rewrite history),
 *   - a row that already carries a `finished_at` (it finished; the status is a
 *     different bug and this is not the place to guess at it),
 *   - a row with an absent or unparseable `started_at` — with no start there is
 *     no age, and a reaper that cannot measure age must not reap. Failing open
 *     here leaves one stale row; failing closed could kill a live run.
 */
export function staleRunIds(rows: RunRow[] | null | undefined, nowMs: number, limitMs = STALE_RUN_MS): string[] {
  const out: string[] = []
  for (const r of rows ?? []) {
    if (!r || r.status !== 'running') continue
    if (r.finished_at) continue
    if (!r.id) continue
    const started = r.started_at ? Date.parse(r.started_at) : NaN
    if (!Number.isFinite(started)) continue
    if (nowMs - started > limitMs) out.push(r.id)
  }
  return out
}
