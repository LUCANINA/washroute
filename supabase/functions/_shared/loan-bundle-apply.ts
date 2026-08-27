// _shared/loan-bundle-apply.ts — the judgements the APPLY step makes, with no I/O.
//
// applyBundle holds the service role and writes six tables, and none of that can be
// exercised from a test runner. What CAN be exercised is the part that decides, and
// every decision below is one an audit reproduced as a defect first:
//
//   * which approve-list is admissible, and — the one that mattered — whether the
//     plan under the claim is still the plan that was reviewed
//   * what a finding upsert is allowed to overwrite, and what its fingerprint is
//     allowed to depend on
//   * what the receipt says after a SECOND run over the same bundle
//   * whether a document should be inserted or adopted
//   * which document a term may be marked applied against
//   * which source a balance-writing action is allowed to claim, and whether a
//     balance may be filed at all — the one place where refusing to repair a bad
//     payload is the feature rather than the limitation
//   * whether a balance is a new row, a row already there, or a disagreement that
//     must fail rather than overwrite
//
// It is pure so tests/apply-bundle.test.mts pins the shipped code rather than a copy
// of it — a test that agrees with its own transcription is the failure mode
// tests/queue-hygiene.test.mts was rewritten to remove.

import type { BundlePlan } from './loan-bundle-plan.ts'

// ─────────────────────────────────────────────────────────────────────────────
// The approve-list, and the plan it is approved against
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Key-sorted JSON, so two readings of the SAME jsonb column compare equal.
 * Postgres does not promise key order out of jsonb, and a comparison that failed
 * on key order alone would 409 honest applies until nobody believed the guard.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

export interface ApproveProblem {
  code: 'unknown_actions' | 'blocked_actions'
  ids: string[]
  message: string
  status: number
}

/**
 * Every approved id is in the plan, and none of them is blocked.
 *
 * Run twice on purpose: once before the claim, so a bad approve-list cannot brick
 * the row into 'applying' with nothing able to re-claim it, and once against the
 * row actually claimed, because that is the copy that gets executed.
 */
export function checkApproveList(plan: BundlePlan | null | undefined, approve: string[]): ApproveProblem | null {
  const byId = new Map((plan?.actions || []).map(a => [a.id, a]))
  const unknown = approve.filter(id => !byId.has(id))
  if (unknown.length) {
    return { code: 'unknown_actions', ids: unknown, status: 400,
             message: `These actions are not part of this plan: ${unknown.join(', ')}.` }
  }
  const blocked = approve.filter(id => byId.get(id)!.blocked_reason)
  if (blocked.length) {
    return { code: 'blocked_actions', ids: blocked, status: 409,
             message: `These actions cannot be applied: ${blocked.map(id => `${id} (${byId.get(id)!.blocked_reason})`).join('; ')}` }
  }
  return null
}

/**
 * Which approved actions are NOT byte-for-byte what the pre-claim read validated.
 *
 * The plan is read twice — once to validate, once out of the claim — and only ids
 * were ever compared. Ids are the stable half: an action keeps `basis-1` while its
 * payload is amended underneath it. Demonstrated with set_carrying_basis, where
 * 'net_principal' was validated and 'gross_payback' would have executed; on Stripe
 * Capital that is the $20,875 phantom liability this whole module exists to have
 * caught once already. Compare the whole action, payload included.
 */
export function divergedActions(
  validated: BundlePlan | null | undefined,
  claimed: BundlePlan | null | undefined,
  approve: string[],
): string[] {
  const before = new Map((validated?.actions || []).map(a => [a.id, canonicalJson(a)]))
  const after = new Map((claimed?.actions || []).map(a => [a.id, canonicalJson(a)]))
  return approve.filter(id => before.get(id) !== after.get(id))
}

// ─────────────────────────────────────────────────────────────────────────────
// Findings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fields a finding may key itself on, in preference order. All of them describe
 * the THING the finding is about; none of them is "now".
 */
export const FINDING_DISCRIMINATORS = ['book_date', 'date', 'anchor_date', 'statement_date'] as const

/**
 * The identity of an intake finding.
 *
 * There is deliberately no fallback to today's date. A fingerprint containing the
 * date the bundle was APPLIED mints a fresh row on every apply, so the same single
 * problem stacks up one unclearable Needs Attention item per day and dismissing
 * them never ends. A finding with no stable discriminator simply omits the segment
 * — one row per (check, loan), re-found rather than re-raised.
 */
export function findingFingerprint(checkKey: string, loanId: string, detail: unknown): string {
  const d = (detail && typeof detail === 'object') ? detail as Record<string, unknown> : {}
  for (const k of FINDING_DISCRIMINATORS) {
    const v = d[k]
    if (typeof v === 'string' && v) return `intake:${checkKey}:${loanId}:${v}`
  }
  return `intake:${checkKey}:${loanId}`
}

export interface PriorFinding {
  status?: string | null
  pinned_note?: string | null
  title?: string | null
  plain_english?: string | null
}

export interface FindingInput {
  fingerprint: string
  loanId: string
  checkKey: string
  severity: string
  title: string
  plainEnglish: string
  detail: unknown
  now: string
}

export type FindingWrite =
  | { verdict: 'leave_suppressed' }
  | { verdict: 'upsert'; keptHumanText: boolean; row: Record<string, unknown> }

/**
 * What to write for a raise_finding action, given the row already at that
 * fingerprint. Mirrors reconciliation-run/index.ts:1449 deliberately — the two
 * subsystems share this table and must not disagree about who owns the text:
 *
 *   * `suppressed` means a person dismissed it. It stays dismissed. An upsert with
 *     status:'open' hard-coded silently reverses that dismissal, and the person who
 *     dismissed it is told nothing.
 *   * a `pinned_note` means a person hand-wrote the diagnosis on this row. Their
 *     title and plain_english are the ONLY copy; overwriting them with the intake
 *     template destroys the work outright, so those two keys are omitted from the
 *     payload and Postgres leaves the columns alone.
 *   * resolved_at / resolved_run_id are cleared, because a row being marked `open`
 *     while still carrying the timestamp of its resolution reads as both at once.
 */
export function buildFindingWrite(prev: PriorFinding | null | undefined, input: FindingInput): FindingWrite {
  if (prev?.status === 'suppressed') return { verdict: 'leave_suppressed' }
  const pinned = !!prev?.pinned_note
  return {
    verdict: 'upsert',
    keptHumanText: pinned,
    row: {
      fingerprint: input.fingerprint, loan_account_id: input.loanId, check_key: input.checkKey,
      severity: input.severity,
      ...(pinned ? {} : { title: input.title, plain_english: input.plainEnglish }),
      detail: input.detail, status: 'open', source: 'intake',
      last_seen_at: input.now,
      resolved_at: null, resolved_run_id: null,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The receipt
// ─────────────────────────────────────────────────────────────────────────────

export interface AppliedEntry { id: string; [k: string]: unknown }
export interface FailedEntry { id: string; [k: string]: unknown }
export interface Receipt { applied: AppliedEntry[]; failed: FailedEntry[] }

/**
 * The receipt after a run, across ALL runs.
 *
 * `applied` was already carried forward; `failed` was not, so it was REPLACED by
 * whatever the latest run happened to fail. The cheapest way to lose a failure was
 * also the most likely one: retry with the failed boxes unticked, `todo` is empty,
 * the loop never runs, and an empty `failed` overwrites the record of what went
 * wrong. A failure leaves the receipt only by succeeding — never by not being
 * attempted again.
 */
export function mergeReceipt(prior: Receipt, current: Receipt): Receipt {
  const applied = [...(prior.applied || []), ...(current.applied || [])]
  const appliedIds = new Set(applied.map(a => String(a.id)))
  const retried = new Set((current.failed || []).map(f => String(f.id)))
  const carried = (prior.failed || []).filter(f => !appliedIds.has(String(f.id)) && !retried.has(String(f.id)))
  return { applied, failed: [...carried, ...(current.failed || [])] }
}

export interface DecisionRun { approve: string[]; by: string | null; at: string | null }
export interface Decisions { approve: string[]; runs: DecisionRun[] }

/**
 * What the human ticked, over the life of the bundle.
 *
 * `decisions: { approve }` was overwritten on every run, so a retry that ticked one
 * box erased the record of the eight ticked the first time — in the column whose
 * whole job is to say what was agreed to. `approve` is now the union (still a list
 * of action ids, so existing readers keep working) and `runs` holds each submission
 * with who sent it and when.
 */
export function mergeDecisions(prior: unknown, approve: string[], who: string | null, at: string | null): Decisions {
  const p = (prior && typeof prior === 'object') ? prior as Record<string, unknown> : {}
  const priorRuns: DecisionRun[] = Array.isArray(p.runs)
    ? (p.runs as DecisionRun[])
    // A bundle written before `runs` existed still has its one approve-list; keep it.
    : (Array.isArray(p.approve) ? [{ approve: (p.approve as unknown[]).map(String), by: null, at: null }] : [])
  const runs: DecisionRun[] = [...priorRuns, { approve: approve.map(String), by: who, at }]
  const union: string[] = []
  for (const r of runs) for (const id of (r?.approve || [])) if (!union.includes(String(id))) union.push(String(id))
  return { approve: union, runs }
}

/**
 * Where to release a claimed bundle when the run ends without finishing.
 * priorApplied counts: work from an earlier run is still on the loan, and a screen
 * that says 'planned' says nothing was ever filed.
 */
export function releaseStatus(appliedThisRun: readonly unknown[], priorApplied: readonly unknown[]): 'partially_applied' | 'planned' {
  return (appliedThisRun.length || priorApplied.length) ? 'partially_applied' : 'planned'
}

/**
 * The bundle's state once a run closes, judged on the WHOLE receipt rather than on
 * the latest run's luck. An outstanding failure from run one means this bundle is
 * not 'applied', however cleanly run two went.
 */
export function closingStatus(allApplied: readonly unknown[], allFailed: readonly unknown[]): 'applied' | 'partially_applied' | 'planned' {
  if (!allFailed.length) return 'applied'
  return allApplied.length ? 'partially_applied' : 'planned'
}

// ─────────────────────────────────────────────────────────────────────────────
// Documents and terms
// ─────────────────────────────────────────────────────────────────────────────

export type AttachPlan = { mode: 'adopt'; document_id: string } | { mode: 'insert' }

/**
 * Insert this file against the loan, or adopt the row that is already there.
 *
 * `alreadyDone` is built from `applied` only, so an INSERT that committed and lost
 * its reply lands in `failed`, and "Apply the rest" re-runs a bare INSERT: two
 * loan_documents rows for one file. The unique index that would have caught it
 * could not be created — one loan already carries the same screenshot three times —
 * so the sha lookup IS the backstop, not a nicety on top of one.
 */
export function documentAttachPlan(sha: unknown, docIdBySha: ReadonlyMap<string, string>): AttachPlan {
  if (sha === null || sha === undefined || sha === '') return { mode: 'insert' }
  const existing = docIdBySha.get(String(sha))
  return existing ? { mode: 'adopt', document_id: existing } : { mode: 'insert' }
}

export type TermScope =
  | { scope: 'document'; document_id: string }
  | { scope: 'unsourced' }
  | { scope: 'unresolved' }

/**
 * Which loan_contract_terms rows may be marked applied for this action.
 *
 * The scope is mandatory. Two documents may legitimately state the same term with
 * different values — that is what the table is for — and the previous code added
 * `.eq('source_document_id', …)` only when the id happened to resolve, so an
 * unresolved source marked EVERY non-superseded row for the key applied, including
 * one from another document stating a contradicting figure.
 *
 *   document   — the plan named a source and it resolved: mark exactly its row
 *   unsourced  — the plan named no source at all, so the sibling record_contract_terms
 *                wrote source_document_id NULL; under NULLS NOT DISTINCT that is one
 *                single slot, so `.is(null)` is still an exact scope, not a widening
 *   unresolved — the plan named a source we could not find. Mark nothing.
 */
export function termMarkScope(sourceSha: unknown, docIdBySha: ReadonlyMap<string, string>): TermScope {
  if (sourceSha === null || sourceSha === undefined || sourceSha === '') return { scope: 'unsourced' }
  const id = docIdBySha.get(String(sourceSha))
  return id ? { scope: 'document', document_id: id } : { scope: 'unresolved' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Balances
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ONE source each balance-writing action may write, and nothing else.
 *
 * The same reasoning as APPLYABLE in loan-bundle/index.ts, and a sharper case for
 * it. The payload comes out of `intake_bundles.plan`, a jsonb column any admin or
 * manager can INSERT through PostgREST, and applyBundle holds the service role. A
 * hand-made plan row naming `source: 'lender_statement'` would mint a row that
 * every surface in the system treats as a document the LENDER sent — the exact
 * distinction _VARIANCE_REAL_ANCHORS (dashboard) and REAL_ANCHOR_SOURCES
 * (reconciliation-run) exist to hold. Not a privilege escalation today, since the
 * same person could write the row directly; but "a planner bug reaches the same
 * place with no adversary at all" is as true here as it is there, and here the
 * result is a fabricated lender anchor rather than a wrong date on a loan record.
 */
export const STATEMENT_SOURCE_BY_KIND: Readonly<Record<string, string>> = {
  open_at_origination: 'contract_origination',
  record_lender_balance: 'portal_manual_pull',
}

/** loan_statements.balance_basis is CHECK-constrained to exactly these four. */
export const STATEMENT_BASES = ['principal_only', 'total_payback', 'payoff_quote', 'unknown']

export interface StatementRow {
  statement_date: string
  principal_balance: number
  balance_basis: string
  source: string
}

export type StatementPayloadCheck =
  | { ok: true; row: StatementRow }
  | { ok: false; error: string }

/**
 * Read a balance-writing action's payload, or refuse it.
 *
 * Refusing is the point. Every field below is taken VERBATIM from the stored plan
 * — nothing is recomputed from contract terms or re-read off a screenshot at apply
 * time, because a figure derived twice is a figure that can differ between the
 * screen somebody approved and the row that got written, with no audit trail
 * showing which they got. The cost of that rule is that a malformed payload has to
 * be caught rather than repaired, and a `null` statement_date in particular must
 * never become "today": that is precisely the guessed lender-anchor date section
 * 5b refuses to invent, arriving through the back door.
 */
export function checkStatementPayload(kind: string, payload: unknown): StatementPayloadCheck {
  const want = STATEMENT_SOURCE_BY_KIND[kind]
  if (!want) return { ok: false, error: `'${kind}' is not an action allowed to write a balance` }
  const p = (payload && typeof payload === 'object') ? payload as Record<string, unknown> : {}

  const src = String(p.source ?? '')
  if (src !== want) {
    return { ok: false, error: `this action may only file a '${want}' balance, and the plan asked for '${src || '(none)'}'` }
  }
  const date = String(p.statement_date ?? '')
  // ISO calendar-date shape AND a real date. '2026-02-31' matches the regex and is
  // not a day; Postgres would reject it, but with a message about a date literal
  // rather than about the screenshot that failed to state one.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) {
    return { ok: false, error: `there is no usable date on this action (${date || 'none'}), so there is nothing to file the balance against` }
  }
  const bal = typeof p.principal_balance === 'number' ? p.principal_balance : NaN
  if (!Number.isFinite(bal)) {
    return { ok: false, error: `this action carries no balance to file` }
  }
  const basis = String(p.balance_basis ?? '')
  // Not defaulted to 'unknown'. An unlabelled balance is quietly dropped from the
  // lender-comparison checks, so silently substituting one turns a plan defect into
  // a row that looks fine and is examined by nothing.
  if (!STATEMENT_BASES.includes(basis)) {
    return { ok: false, error: `'${basis || '(none)'}' is not a balance basis this table accepts` }
  }
  return { ok: true, row: { statement_date: date, principal_balance: bal, balance_basis: basis, source: src } }
}

export interface ExistingStatement { principal_balance: number | string; balance_basis?: string | null }

export type StatementWrite =
  | { verdict: 'insert' }
  | { verdict: 'already_filed'; message: string }
  | { verdict: 'conflict'; message: string }

/**
 * File this balance, adopt the row already there, or refuse — given every row that
 * already exists at the same (loan, date, source).
 *
 * IDEMPOTENCE. `alreadyDone` is built from the receipt's `applied` list only, so an
 * INSERT that committed and then lost its reply lands in `failed`, and "Apply the
 * rest" re-runs a bare insert. On loan_documents that produced two rows for one
 * file (see documentAttachPlan); here it would produce two balances for one day,
 * and _rankByAuthority would then pick between them by accident of ordering. The
 * lookup IS the backstop.
 *
 * AND NEVER AN OVERWRITE. A row already carrying a different figure is not a stale
 * copy to correct, it is somebody else's evidence: the whole reason
 * correct_statement_basis carries `.eq('balance_basis','unknown')` is that this
 * module does not get to win a disagreement by writing last. So a different value
 * fails the action, loudly and with both figures named, rather than replacing a
 * balance whose provenance nothing here knows.
 */
export function statementRowWrite(
  existing: readonly ExistingStatement[] | null | undefined,
  row: StatementRow,
): StatementWrite {
  const rows = (existing || []).filter(r => r && Number.isFinite(Number(r.principal_balance)))
  if (!rows.length) return { verdict: 'insert' }
  const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const same = rows.find(r => Math.abs(Number(r.principal_balance) - row.principal_balance) <= 0.005)
  if (same) {
    return {
      verdict: 'already_filed',
      message: `${money(row.principal_balance)} was already on file for ${row.statement_date} from the same place — kept the row already there rather than filing a second one`,
    }
  }
  return {
    verdict: 'conflict',
    message:
      `a balance is already on file for ${row.statement_date} from the same place, and it is not this one ` +
      `(${rows.map(r => money(Number(r.principal_balance))).join(', ')} on file, ${money(row.principal_balance)} proposed). ` +
      `Nothing was changed: overwriting it would destroy the evidence for whichever figure is right.`,
  }
}
