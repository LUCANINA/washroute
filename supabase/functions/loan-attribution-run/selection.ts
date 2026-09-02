// =============================================================================
// loan-attribution-run — THE PURE HALF
// =============================================================================
//
// Everything in this file is a pure function, for one reason: session 245 found the
// test suite full of TRANSCRIPTIONS — copies of shipped functions asserting that a copy
// agreed with itself. The way to make that impossible is to give the real decisions
// somewhere to live that a test can import directly. `index.ts` does I/O and nothing a
// test would want to check; this file decides things and touches nothing.
//
// WHY THE TYPES COME FROM XERO AND NOT FROM THE WALK (session 259 cont. 14, option b)
// ----------------------------------------------------------------------------------
// `attributionFromWalk` needs each BankTransaction's `Type` to verify a claim's
// direction. Two ways to supply it. Patching `loan-find-difference`'s `entryView` to
// emit `txn_type` is one line — but then the walk supplies BOTH the effect the gate is
// checking and the type it checks it WITH, so the gate re-derives from inputs that
// share a source. That is not vacuous, but it is weaker, and this module exists
// because of what happened the last time a check's inputs shared a source (session
// 246: a variance that was zero by construction, printed beside a loan whose books
// disagreed by $1,835.75).
//
// So the types are fetched fresh from Xero by id. One extra call, genuinely
// independent. That is what makes the gate's re-derivation a real check.

/** A `reconciliation_findings` row, as much of it as this module reads. */
export type FindingRow = {
  id: string
  loan_account_id: string
  check_key?: string | null
  status?: string | null
  severity?: string | null
  last_seen_at?: string | null
}

export type Selected = { loan_account_id: string; finding_id: string }

/**
 * WHICH LOANS THE JOB RUNS.
 *
 * Materiality is READ from the engine's own severity, never recomputed here. The
 * reconciliation engine already decided whether a gap clears the materiality floor,
 * and a second threshold in a second file is how two numbers on one screen start
 * disagreeing — this module's oldest failure shape. `info` is the engine saying
 * "immaterial"; today that is EIDL's −$5.00 and nothing else.
 *
 * Newest `last_seen_at` wins when a loan somehow carries two open findings, so the
 * choice is deterministic rather than dependent on row order.
 */
export function selectLoans(rows: FindingRow[]): Selected[] {
  const best = new Map<string, FindingRow>()
  for (const r of rows ?? []) {
    if (!r || !r.loan_account_id || !r.id) continue
    if (r.check_key !== 'balance_vs_lender') continue
    if (r.status !== 'open') continue
    if (r.severity === 'info') continue          // the engine called it immaterial
    const prev = best.get(r.loan_account_id)
    if (!prev || String(r.last_seen_at ?? '') > String(prev.last_seen_at ?? '')) {
      best.set(r.loan_account_id, r)
    }
  }
  return [...best.values()]
    .map(r => ({ loan_account_id: r.loan_account_id, finding_id: r.id }))
    .sort((a, b) => a.loan_account_id.localeCompare(b.loan_account_id))
}

/**
 * Every BANK TRANSACTION id the walk points a finger at.
 *
 * Three places carry one and all three matter:
 *   periods[].culprit.entry   the accused entry
 *   periods[].culprit.twin    the other half of a duplicate_suspected pair — omit it
 *                             and that claim refuses for want of a type, which reads
 *                             as "we could not tell" rather than "we did not ask"
 *   cpa_exception.entry       the accountant's own entry
 *
 * ManualJournals are deliberately EXCLUDED. Their direction is in the line signs, so
 * the gate needs nothing from us; and a ManualJournalID sent to a BankTransactionID
 * query matches nothing, which spends a Xero call to learn that.
 */
export function bankEntryIds(walk: unknown): string[] {
  const out = new Set<string>()
  const add = (e: unknown) => {
    const v = e as { src_type?: string; id?: unknown } | null | undefined
    if (!v || v.src_type !== 'BankTransaction') return
    const id = String(v.id ?? '').trim()
    if (id) out.add(id)
  }
  const w = walk as { periods?: Array<{ culprit?: { entry?: unknown; twin?: unknown } | null }> | null
                      cpa_exception?: { entry?: unknown } | null } | null | undefined
  for (const p of w?.periods ?? []) {
    add(p?.culprit?.entry)
    add(p?.culprit?.twin)
  }
  add(w?.cpa_exception?.entry)
  return [...out]
}

/** Xero ids are GUIDs. Anything else never reaches a query string. */
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function isGuid(s: unknown): boolean {
  return typeof s === 'string' && GUID.test(s)
}

/**
 * Xero's `where` has no parameter binding — the clause is string-concatenated into a
 * URL. So the ids are VALIDATED against the GUID shape rather than escaped: an id that
 * is not a GUID cannot be made safe by quoting, and it cannot be a real Xero entry
 * either, so the only correct thing to do with it is refuse it. Rejects are returned,
 * not dropped silently: an id we declined to ask about is a hole in the answer and the
 * run report has to be able to say so.
 *
 * Chunked because a `where` clause is a URL, and 6 loans x an unbounded culprit list is
 * not a length anyone has measured.
 */
export const IDS_PER_CALL = 30

export function xeroIdWhereChunks(
  ids: string[],
  perCall: number = IDS_PER_CALL,
): { chunks: string[]; rejected: string[] } {
  const good: string[] = []
  const rejected: string[] = []
  for (const id of ids ?? []) {
    if (isGuid(id)) good.push(id)
    else rejected.push(String(id))
  }
  const chunks: string[] = []
  for (let i = 0; i < good.length; i += Math.max(1, perCall)) {
    chunks.push(
      good.slice(i, i + Math.max(1, perCall))
        .map(id => `BankTransactionID==Guid("${id}")`)
        .join('||'),
    )
  }
  return { chunks, rejected }
}

export type XeroTypeRow = { id?: unknown; type?: unknown }

/**
 * Build the map `attributionFromWalk` reads.
 *
 * KEYED BY THE WALK'S OWN SPELLING OF THE ID, matched case-insensitively. This is not
 * fussiness. `toLedgerEntry` looks the id up with `txnTypeById.get(String(v.id))` — an
 * exact-string `Map.get`. Xero is not consistent about GUID case between endpoints, and
 * a case mismatch there does not throw: the lookup misses, the type is undefined, and
 * every claim on that entry refuses with `entry_direction_unknown`. The job would
 * report "we could not determine the direction" for a fetch that succeeded completely.
 * A silent miss that produces a plausible refusal is exactly the class of defect this
 * pipeline exists to catch, so it is handled here rather than hoped about.
 *
 * An id Xero did not return is OMITTED, never mapped to null: absent means "Xero did
 * not tell us", and the caller counts those. Mapping it to null would look the same to
 * the gate but lose the count.
 */
export function typeMapFromRows(
  rows: XeroTypeRow[],
  walkIds: string[],
): { map: Map<string, string | null>; missing: string[] } {
  const byLower = new Map<string, string | null>()
  for (const r of rows ?? []) {
    const id = String(r?.id ?? '').trim()
    if (!id) continue
    const t = r?.type == null ? null : String(r.type)
    byLower.set(id.toLowerCase(), t)
  }
  const map = new Map<string, string | null>()
  const missing: string[] = []
  for (const id of walkIds ?? []) {
    const key = String(id)
    if (byLower.has(key.toLowerCase())) map.set(key, byLower.get(key.toLowerCase()) ?? null)
    else missing.push(key)
  }
  return { map, missing }
}

export type StoredRow = { loan_account_id?: unknown; generated_at?: unknown }

/**
 * OLDEST ANSWER FIRST.
 *
 * The job carries a wall-clock budget, so a pass can end with loans unvisited. Under any
 * fixed order — by id, by size, by the query's own — the SAME loans are the ones that
 * never get reached, every night, forever. Nobody would see that: the table would carry
 * a row for them from whenever it last fit, looking exactly like a fresh one.
 *
 * So the loan whose stored answer is oldest goes first, and a loan with no stored answer
 * at all goes before any that has one. Starvation becomes rotation, and the run report's
 * `not_attempted` names who waits. Ties break on loan id so two runs over identical data
 * produce identical order.
 */
export function orderByStaleness(selected: Selected[], stored: StoredRow[]): Selected[] {
  const at = new Map<string, string>()
  for (const r of stored ?? []) {
    const id = String(r?.loan_account_id ?? '')
    if (id) at.set(id, String(r?.generated_at ?? ''))
  }
  return [...(selected ?? [])].sort((a, b) => {
    const sa = at.get(a.loan_account_id), sb = at.get(b.loan_account_id)
    // never-computed sorts before every computed one, whatever its date
    if (sa === undefined && sb !== undefined) return -1
    if (sb === undefined && sa !== undefined) return 1
    if (sa !== undefined && sb !== undefined && sa !== sb) return sa < sb ? -1 : 1
    return a.loan_account_id.localeCompare(b.loan_account_id)
  })
}
