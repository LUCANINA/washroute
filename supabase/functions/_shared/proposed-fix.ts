// _shared/proposed-fix.ts — KEEP WHAT THE WALK ALREADY PROPOSES (session 309)
//
// `loan-attribution-run` calls `loan-find-difference` every six hours and stores the
// CAUSE it finds. The same response carries the JOURNAL the engine prepared to fix it —
// `proposal`, `writeoff`, `cpa_exception`, `recorded_entry` — and until this module the
// job threw that away. This turns the response into a bounded, deterministic payload the
// Loans close row can show without spending a Xero call.
//
// Spec: docs/bookkeeping/DESIGN-PROPOSED-FIX.md.
//
// TWO RULES, AND THEY ARE THE WHOLE MODULE
//
//  1. AN ALLOWLIST DECIDES WHAT IS A FIX. Only the kinds named in FIX_KINDS carry a
//     journal a person can approve from the row. Anything else the engine returns —
//     including a kind added next month — is `none` with the engine's own `why`, never
//     a postable card. Same instinct as `_bkSplitKind` (s262): a new source fails safe.
//
//  2. THE DASHBOARD DECIDES THE SHAPE, NOT THIS FILE. Whether a row ASKS for a statement
//     is a fact about the loan's anchors that `_VARIANCE_REAL_ANCHORS` and the close
//     band already compute; re-deriving it here would be the second-derivation bug of
//     sessions 214–217. This file stores what the ENGINE knows: a fix, an accountant's
//     question, or nothing (and why). `_bkLoanFix()` combines that with the row's own
//     anchor state to pick fix / ask / accountant / recheck.
//
// `version` is the staleness key: the latest timestamp of anything that changes the
// books this walk read. The dashboard recomputes it from rows it already loads; a
// mismatch renders Re-check and hides the journal. Any write makes a new key by
// construction — nothing has to remember to invalidate.

export const PROPOSED_FIX_SCHEMA = 1

/** Proposal kinds whose `journal` is complete and postable through the existing
 *  preview → confirm path. `recorded_cause_adjustment` is deliberately ABSENT: its
 *  offset account is chosen by a human, so it has no complete journal to show. */
export const FIX_KINDS = new Set([
  'interest_reallocation_journal',
  'stale_split_trueup',
  'unexplained_difference_writeoff',
  'cpa_exception',
])

export type JournalLine = { LineAmount: number; AccountCode: string; Description?: string; AccountName?: string | null }
export type Journal = { Narration: string; Date: string; JournalLines: JournalLine[] }

export type ProposedFix =
  | {
      schema: number
      state: 'fix'
      kind: string
      /** Which `loan-find-difference` flag posts it. The dashboard never guesses. */
      post_flag: 'post_fix' | 'post_writeoff' | 'post_exception'
      amount: number
      dated_into: string
      dated_because: string | null
      /** The one sentence that would have failed if the fix were wrong. */
      check: string
      journal: Journal
      token: string
      version: string | null
      working: Array<{ label: string; text: string }>
    }
  | {
      schema: number
      state: 'accountant'
      /** The narrow question, in the engine's words. */
      question: string
      version: string | null
      working: Array<{ label: string; text: string }>
    }
  | {
      schema: number
      state: 'none'
      /** Why nothing is proposed — the engine's own refusal, never invented here. */
      why: string | null
      version: string | null
    }

const r2 = (n: number) => Math.round(n * 100) / 100

function firstSentence(s: unknown): string {
  const t = String(s ?? '').trim()
  if (!t) return ''
  const m = t.match(/^.*?[.!?](?=\s|$)/)
  return (m ? m[0] : t).trim()
}

function cleanJournal(j: any): Journal | null {
  if (!j || !Array.isArray(j.JournalLines) || !j.Date || !j.Narration) return null
  const lines: JournalLine[] = []
  for (const l of j.JournalLines) {
    const amt = Number(l?.LineAmount)
    if (!Number.isFinite(amt) || !l?.AccountCode) return null
    lines.push({ LineAmount: r2(amt), AccountCode: String(l.AccountCode), Description: l.Description ?? undefined, AccountName: l.AccountName ?? null })
  }
  if (lines.length < 2) return null
  // Double entry or nothing. A journal that does not foot is not a fix.
  if (Math.abs(lines.reduce((s, l) => s + l.LineAmount, 0)) > 0.005) return null
  return { Narration: String(j.Narration), Date: String(j.Date), JournalLines: lines }
}

/**
 * The staleness key: the latest timestamp among the loan's statements, its splits'
 * state changes and the last finished reconciliation run. ISO strings compare
 * lexically, so `max` is a string compare. Null when nothing is on file.
 *
 * The dashboard computes the same key from the same tables — see `_bkLoanFixVersion`.
 * Keep the two lists of columns identical or the row will read Re-check forever
 * (or, worse, never).
 */
export function versionKey(o: {
  statements?: Array<{ created_at?: string | null }> | null
  splits?: Array<{ computed_at?: string | null; xero_posted_at?: string | null; voided_at?: string | null; staged_at?: string | null }> | null
  runs?: Array<{ finished_at?: string | null }> | null
}): string | null {
  let v: string | null = null
  const bump = (t: unknown) => { const s = t ? String(t) : ''; if (s && (!v || s > v)) v = s }
  for (const s of o.statements ?? []) bump(s?.created_at)
  for (const s of o.splits ?? []) { bump(s?.computed_at); bump(s?.xero_posted_at); bump(s?.voided_at); bump(s?.staged_at) }
  for (const r of o.runs ?? []) bump(r?.finished_at)
  return v
}

/**
 * The walk's analyze response → the stored fix. Pure; same input, same bytes.
 * Precedence mirrors the engine's own: a cause-built proposal outranks a write-off,
 * and a CPA exception's prepared entry is a fix in its own right.
 */
export function fixFromWalk(walk: any, version: string | null): ProposedFix {
  const W: Array<{ label: string; text: string }> = []
  const push = (label: string, text: unknown) => { const t = String(text ?? '').trim(); if (t) W.push({ label, text: t }) }
  const none = (why: unknown): ProposedFix => ({ schema: PROPOSED_FIX_SCHEMA, state: 'none', why: why ? String(why) : null, version })

  if (!walk || walk.ok !== true) return none('the analysis did not run')
  if (walk.verdict === 'not_enough_history') return none(walk.narrative || 'not enough lender statements to walk')

  const p = walk.proposal
  if (p && typeof p.kind === 'string') {
    const j = cleanJournal(p.journal)
    if (FIX_KINDS.has(p.kind) && j && p.token) {
      push('Based on', p.based_on)
      push('Dated', p.dated_because)
      if (p.period) push('Period', p.period)
      return {
        schema: PROPOSED_FIX_SCHEMA, state: 'fix', kind: p.kind, post_flag: 'post_fix',
        amount: r2(Number(p.amount)), dated_into: String(p.dated_into || j.Date), dated_because: p.dated_because ?? null,
        check: firstSentence(p.based_on), journal: j, token: String(p.token), version, working: W,
      }
    }
    return none(`the analysis proposed "${p.kind}", which the row cannot show`)
  }

  // `cpa_exception` (s232/236): a payment the accountant worked herself. With a
  // prepared `proposed_entry` it is a fix; without one its `note` IS the decision
  // and belongs to her, so the row states it and offers nothing to click.
  const ce = walk.cpa_exception
  if (ce) {
    const pe = ce.proposed_entry
    const j = pe ? cleanJournal(pe) : null
    if (j && ce.token) {
      push('Decision', ce.note)
      push('Dated', pe.dated_because)
      return {
        schema: PROPOSED_FIX_SCHEMA, state: 'fix', kind: 'cpa_exception', post_flag: 'post_exception',
        amount: r2(Math.abs(Number(pe.amount))), dated_into: j.Date, dated_because: pe.dated_because ?? null,
        check: firstSentence(ce.note) || 'Prepared from an entry your accountant worked.',
        journal: j, token: String(ce.token), version, working: W,
      }
    }
    const q = firstSentence(ce.note)
    if (q) {
      push('In full', ce.note)
      return { schema: PROPOSED_FIX_SCHEMA, state: 'accountant', question: q, version, working: W }
    }
  }

  const wo = walk.writeoff
  if (wo && wo.eligible === true) {
    const j = cleanJournal(wo.journal)
    if (j && wo.token) {
      push('Searched', Array.isArray(wo.searched) ? wo.searched.join('; ') : wo.searched)
      push('Dated', wo.dated_because)
      push('Result', wo.result_sentence)
      return {
        schema: PROPOSED_FIX_SCHEMA, state: 'fix', kind: 'unexplained_difference_writeoff', post_flag: 'post_writeoff',
        amount: r2(Number(wo.amount)), dated_into: String(wo.dated_into || j.Date), dated_because: wo.dated_because ?? null,
        check: 'No entry of this amount exists in Xero and the walk attributed nothing — written off as immaterial.',
        journal: j, token: String(wo.token), version, working: W,
      }
    }
  }

  // Nothing postable. Say why in the engine's words, most specific first.
  const why = wo?.why || walk.trueup?.why || walk.recorded_entry?.why || walk.no_action_detail || null
  return none(why)
}
