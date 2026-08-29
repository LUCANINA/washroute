// tests/apply-bundle.test.mts — the five defects the apply-step audit found.
//
// Run:  npx tsx tests/apply-bundle.test.mts
//
// WHAT THIS FILE CAN AND CANNOT REACH
// applyBundle holds the service role and writes six tables. Nothing here can call
// Supabase, and a test that mocked PostgREST would be asserting that a mock agrees
// with itself — the failure mode tests/queue-hygiene.test.mts was rewritten to
// remove. So the judgements were EXTRACTED into _shared/loan-bundle-apply.ts, which
// is pure and which loan-bundle/index.ts now calls, and this file exercises that
// shipped module rather than a transcription of it.
//
// The last section is different in kind and deliberately so: it reads
// loan-bundle/index.ts as text, to check that the fixes are actually WIRED IN. A
// pure module that decides correctly and a caller that ignores it is exactly as
// broken as no fix at all, and nothing else here would notice. Those regexes are
// assertions: one that stops matching is a failure, not a skip.
//
// The five, in order of severity:
//   1  the plan was read twice and the copy that was VALIDATED was not the copy
//      that was EXECUTED — payloads could be swapped between the two reads
//   2  raise_finding re-opened dismissed findings, destroyed pinned notes, and
//      minted a new row every day it was applied
//   3  the receipt overwrote its own `failed` list, so a retry erased what failed
//   4  attach_document had no idempotency at all on the retry path
//   5  the applied_to_loan_account marking silently WIDENED when the source
//      document could not be resolved

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canonicalJson, checkApproveList, divergedActions,
  findingFingerprint, buildFindingWrite,
  mergeReceipt, mergeDecisions, releaseStatus, closingStatus,
  documentAttachPlan, termMarkScope, statementRowWrite,
} from '../supabase/functions/_shared/loan-bundle-apply.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

const planOf = (...actions: any[]): any => ({ actions, documents: [], summary: '' })
const act = (id: string, kind: string, payload: any, extra: any = {}): any =>
  ({ id, kind, title: id, plain_english: '', payload, default_checked: true, ...extra })

// ─────────────────────────────────────────────────────────────────────────────
section('1 — validate the copy you execute, not the copy you read first')
// ─────────────────────────────────────────────────────────────────────────────
{
  // THE CASE THAT MATTERED. Same action id, same kind, amended payload — the plan
  // row edited between the peek and the claim. Ids matched, so the old code ran it.
  // On Stripe Capital the two values below are the $20,875 phantom liability: a
  // gross_payback loan booked as net_principal splits every payment and leaves the
  // fee owing after the lender says paid in full.
  const reviewed = planOf(act('basis-1', 'set_carrying_basis', { carrying_basis: 'net_principal', evidence: 'the portal total' }))
  const amended = planOf(act('basis-1', 'set_carrying_basis', { carrying_basis: 'gross_payback', evidence: 'the portal total' }))

  ok('the approve-id checks alone see nothing wrong',
     checkApproveList(reviewed, ['basis-1']) === null && checkApproveList(amended, ['basis-1']) === null,
     'which is the whole reason a payload comparison had to exist')
  ok('the swapped payload IS caught',
     divergedActions(reviewed, amended, ['basis-1']).join() === 'basis-1')

  // An unchanged plan must not 409 honest applies, or the guard gets removed.
  ok('an unchanged plan diverges on nothing',
     divergedActions(reviewed, JSON.parse(JSON.stringify(reviewed)), ['basis-1']).length === 0)

  // jsonb does not promise key order; a comparison that fired on re-ordering
  // would be indistinguishable from the real thing and would be turned off.
  const reordered = planOf({ payload: { evidence: 'the portal total', carrying_basis: 'net_principal' },
                             default_checked: true, plain_english: '', title: 'basis-1',
                             kind: 'set_carrying_basis', id: 'basis-1' })
  ok('key order alone is not a divergence',
     divergedActions(reviewed, reordered, ['basis-1']).length === 0,
     canonicalJson(reordered.actions[0]))

  // Scope: only what was ticked gates the run. An untouched action changing is
  // somebody else's problem, not grounds to refuse this apply.
  const alsoOther = planOf(reviewed.actions[0], act('doc-1', 'attach_document', { sha256: 'aaa' }))
  const otherMoved = planOf(reviewed.actions[0], act('doc-1', 'attach_document', { sha256: 'bbb' }))
  ok('an action nobody approved is not compared',
     divergedActions(alsoOther, otherMoved, ['basis-1']).length === 0)
  ok('...but it is compared the moment it is approved',
     divergedActions(alsoOther, otherMoved, ['basis-1', 'doc-1']).join() === 'doc-1')

  // An action DELETED from the claimed plan is a divergence, not a crash.
  ok('an action that vanished between the reads is caught',
     divergedActions(alsoOther, planOf(reviewed.actions[0]), ['doc-1']).join() === 'doc-1')

  // And a blocked_reason appearing after the peek is the same class of problem:
  // the pre-claim check passed, the post-claim check must not.
  const blockedLate = planOf(act('basis-1', 'set_carrying_basis', { carrying_basis: 'net_principal', evidence: 'the portal total' },
                                 { blocked_reason: 'the carrying basis was not established' }))
  const late = checkApproveList(blockedLate, ['basis-1'])
  ok('a blocked_reason added after the peek is refused', late?.code === 'blocked_actions', String(late?.code))
  ok('...with a 409, not a 400', late?.status === 409, String(late?.status))
  ok('...and names the reason', /the carrying basis was not established/.test(late?.message || ''))

  const unknown = checkApproveList(reviewed, ['basis-1', 'ghost-9'])
  ok('an id that is not in the plan is a 400', unknown?.status === 400 && unknown?.ids.join() === 'ghost-9')
  ok('an empty plan refuses everything rather than approving it',
     checkApproveList(null, ['basis-1'])?.code === 'unknown_actions')
}

// ─────────────────────────────────────────────────────────────────────────────
section('2 — a finding upsert must not undo a person')
// ─────────────────────────────────────────────────────────────────────────────
{
  const input = {
    fingerprint: 'intake:balance_vs_lender:loan-1:2026-07-31', loanId: 'loan-1',
    checkKey: 'balance_vs_lender', severity: 'error',
    title: 'Stripe Capital: books and lender disagree by $1,204.00',
    plainEnglish: 'The lender says … Raising it puts it in Needs Attention.',
    detail: { book_date: '2026-07-31', difference: 1204 }, now: '2026-08-27T12:00:00.000Z',
  }

  // A dismissal is a decision. Applying a bundle must not quietly reverse it.
  const supp = buildFindingWrite({ status: 'suppressed', pinned_note: null }, input)
  ok('a suppressed finding is left dismissed', supp.verdict === 'leave_suppressed')

  // ...and it is not a FAILURE either — the run should record it and move on,
  // otherwise every apply of this bundle reports an error nobody can clear.
  ok('leave_suppressed is a verdict, not an error', !('error' in (supp as any)))

  // The pinned note is the only copy of a hand-written diagnosis.
  const pinned = buildFindingWrite({ status: 'open', pinned_note: 'CPA: this is the June journal, see WR-441' }, input)
  ok('a pinned row still gets upserted', pinned.verdict === 'upsert')
  const prow = (pinned as any).row
  ok('...but its title is not in the payload at all', !('title' in prow),
     'Postgres only leaves a column alone if the key is absent; sending the old value back would still race a concurrent edit')
  ok('...nor its plain_english', !('plain_english' in prow))
  ok('...and the run says so out loud', (pinned as any).keptHumanText === true)
  ok('the machine-owned fields are still written', prow.severity === 'error' && prow.detail === input.detail)

  const fresh = buildFindingWrite(null, input)
  const frow = (fresh as any).row
  ok('an unpinned finding does get the intake wording', frow.title === input.title && frow.plain_english === input.plainEnglish)
  ok('...and is not flagged as pinned', (fresh as any).keptHumanText === false)

  // A row marked open while still carrying the timestamp of its resolution reads
  // as both at once, and the resolved list on screen is built from that column.
  const wasResolved = buildFindingWrite({ status: 'resolved', pinned_note: null }, input)
  const rrow = (wasResolved as any).row
  ok('re-raising clears resolved_at', rrow.status === 'open' && rrow.resolved_at === null)
  ok('...and resolved_run_id with it', rrow.resolved_run_id === null)
  ok('the row still declares itself intake-owned', rrow.source === 'intake',
     "the engine's resolve sweep is scoped to source='engine' and must keep missing this row")

  // ── the fingerprint ──
  // The old key ended in `|| todayPacific()`, so a bundle applied on three days
  // minted three rows for one problem and the queue could never be cleared.
  const d1 = findingFingerprint('balance_vs_lender', 'loan-1', { book_date: '2026-07-31' })
  ok('a stable discriminator is used', d1 === 'intake:balance_vs_lender:loan-1:2026-07-31')
  const n1 = findingFingerprint('balance_vs_lender', 'loan-1', { difference: 1204 })
  const n2 = findingFingerprint('balance_vs_lender', 'loan-1', {})
  ok('no discriminator means the segment is OMITTED, not filled with today',
     n1 === 'intake:balance_vs_lender:loan-1' && n1 === n2, `${n1} / ${n2}`)
  ok('...so applying the same bundle twice hits the same row',
     findingFingerprint('c', 'l', null) === findingFingerprint('c', 'l', undefined))
  ok('no date-shaped segment survives when there is no date',
     !/\d{4}-\d{2}-\d{2}/.test(n1))
  ok('a non-string discriminator is not trusted into the key',
     findingFingerprint('c', 'l', { book_date: 20260731 }) === 'intake:c:l')
  ok('two different loans never share a fingerprint',
     findingFingerprint('c', 'loan-1', {}) !== findingFingerprint('c', 'loan-2', {}))
}

// ─────────────────────────────────────────────────────────────────────────────
section('3 — the receipt is the whole history, not the last run')
// ─────────────────────────────────────────────────────────────────────────────
{
  const A = { id: 'doc-1', kind: 'attach_document', result: 'filed agreement.pdf' }
  const B = { id: 'terms-1', kind: 'record_contract_terms', result: 'recorded 9 terms' }
  const C = { id: 'basis-1', kind: 'set_carrying_basis', error: 'permission denied for loan_accounts' }

  // Run one: two land, one fails.
  const r1 = mergeReceipt({ applied: [], failed: [] }, { applied: [A, B], failed: [C] })
  ok('run one records both halves', r1.applied.length === 2 && r1.failed.length === 1)
  ok('...and the bundle is partially applied', closingStatus(r1.applied, r1.failed) === 'partially_applied')

  // Run two: the person unticks the failed box and presses Apply the rest. `todo`
  // is empty, the loop never runs, and the old code stamped the empty array over
  // the top: status 'applied', ok true, HTTP 200, failed [].
  const r2 = mergeReceipt({ applied: r1.applied, failed: r1.failed }, { applied: [], failed: [] })
  ok('a second run with nothing to do does not erase the failure',
     r2.failed.length === 1 && r2.failed[0].id === 'basis-1')
  ok('...and the bundle is still not "applied"', closingStatus(r2.applied, r2.failed) === 'partially_applied',
     'an outstanding failure from run one outlives a clean run two')
  ok('...while what was applied is still carried', r2.applied.map(a => a.id).join() === 'doc-1,terms-1')

  // Run three: they re-tick it and it works. NOW it leaves the list.
  const C2 = { id: 'basis-1', kind: 'set_carrying_basis', result: 'carrying basis set to gross_payback' }
  const r3 = mergeReceipt({ applied: r2.applied, failed: r2.failed }, { applied: [C2], failed: [] })
  ok('a failure leaves the receipt by succeeding', r3.failed.length === 0)
  ok('...and only then is the bundle applied', closingStatus(r3.applied, r3.failed) === 'applied')
  ok('...with all three runs in `applied`', r3.applied.map(a => a.id).join() === 'doc-1,terms-1,basis-1')

  // Re-failing replaces the stale error rather than stacking a second copy.
  const C3 = { id: 'basis-1', kind: 'set_carrying_basis', error: 'still denied' }
  const rx = mergeReceipt({ applied: r1.applied, failed: r1.failed }, { applied: [], failed: [C3] })
  ok('a retried failure is recorded once, with the newest error',
     rx.failed.length === 1 && rx.failed[0].error === 'still denied')

  // Nothing applied and nothing carried is still a plain 'planned'.
  ok('a run that achieves nothing at all is planned, not partially_applied',
     closingStatus([], [C]) === 'planned')
  ok('a clean run with nothing to do is applied', closingStatus([], []) === 'applied')

  // ── the decisions column ──
  const d1 = mergeDecisions(null, ['doc-1', 'terms-1', 'basis-1'], 'david@…', '2026-08-27T10:00:00Z')
  const d2 = mergeDecisions(d1, ['basis-1'], 'david@…', '2026-08-27T11:00:00Z')
  ok('what was ticked first is not erased by what was ticked second',
     d2.approve.join() === 'doc-1,terms-1,basis-1')
  ok('...and each submission is kept separately', d2.runs.length === 2 && d2.runs[1].approve.join() === 'basis-1')
  ok('...with who and when on it', d2.runs[1].by === 'david@…' && d2.runs[1].at === '2026-08-27T11:00:00Z')
  const legacy = mergeDecisions({ approve: ['doc-1'] }, ['terms-1'], 'x', 't')
  ok('a bundle written before `runs` existed keeps its one approve-list',
     legacy.approve.join() === 'doc-1,terms-1' && legacy.runs.length === 2)
  ok('`approve` is still a flat list of ids, so existing readers keep working',
     Array.isArray(d2.approve) && d2.approve.every(x => typeof x === 'string'))

  // ── the ~956 release ──
  // The known-documents read failing is not "nothing was applied" when an earlier
  // run already put documents on the loan.
  ok('a first-run failure releases to planned', releaseStatus([], []) === 'planned')
  ok('a failure with prior work releases to partially_applied',
     releaseStatus([], [A]) === 'partially_applied',
     "'planned' would show a screen saying nothing was ever filed while the rows sit on the loan")
  ok('this run having applied something counts too', releaseStatus([A], []) === 'partially_applied')
}

// ─────────────────────────────────────────────────────────────────────────────
section('4 — the same file is filed once')
// ─────────────────────────────────────────────────────────────────────────────
{
  const seeded = new Map<string, string>([['sha-agreement', 'doc-11']])

  // The retry path: the INSERT committed, the reply was lost, the action landed in
  // `failed`, and `alreadyDone` — built from `applied` only — did not know. A bare
  // re-insert is a second loan_documents row for one file, and the unique index
  // that would have caught it could not be created.
  const again = documentAttachPlan('sha-agreement', seeded)
  ok('a file already on the loan is adopted, not inserted', again.mode === 'adopt')
  ok('...and the adopted id is the one a term will point at',
     (again as any).document_id === 'doc-11')

  const first = documentAttachPlan('sha-screenshot', seeded)
  ok('a genuinely new file is still inserted', first.mode === 'insert')

  // Defensive: a plan action with no sha cannot adopt an arbitrary row.
  ok('a missing sha never adopts', documentAttachPlan(null, seeded).mode === 'insert')
  ok('an empty sha never adopts', documentAttachPlan('', seeded).mode === 'insert')
  ok('adoption is by exact sha', documentAttachPlan('sha-agreemen', seeded).mode === 'insert')
}

// ─────────────────────────────────────────────────────────────────────────────
section('5 — a term is never marked applied against an unknown document')
// ─────────────────────────────────────────────────────────────────────────────
{
  const known = new Map<string, string>([['sha-agreement', 'doc-11']])

  const good = termMarkScope('sha-agreement', known)
  ok('a resolved source scopes the marking to its own row',
     good.scope === 'document' && (good as any).document_id === 'doc-11')

  // THE DEFECT. `if (termSrc) markQ = markQ.eq(...)` dropped the filter in exactly
  // the case it was written for, marking every non-superseded row for the key —
  // including a term from another document stating a contradicting figure.
  ok('an UNRESOLVED source does not widen the filter — it marks nothing',
     termMarkScope('sha-missing', known).scope === 'unresolved')

  // A plan that names no source at all is a different thing from one that names a
  // source we cannot find: record_contract_terms wrote NULL, and under
  // NULLS NOT DISTINCT that is one single slot, so this is an exact scope.
  ok('no source named at all is scoped to the NULL slot',
     termMarkScope(null, known).scope === 'unsourced')
  ok('...and an empty string counts as no source', termMarkScope('', known).scope === 'unsourced')
  ok('...and undefined does too', termMarkScope(undefined, known).scope === 'unsourced')

  // The one thing that must never come back: a scope that means "every row".
  const scopes = ['sha-agreement', 'sha-missing', null, undefined, ''].map(s => termMarkScope(s, known).scope)
  ok('there is no branch that means "all documents"',
     scopes.every(s => s === 'document' || s === 'unsourced' || s === 'unresolved'), scopes.join())
}

// ─────────────────────────────────────────────────────────────────────────────
section('the fixes are wired into the function that ships')
// ─────────────────────────────────────────────────────────────────────────────
// Read as text, because these are the parts inseparable from a PostgREST call.
// Everything above proves the decision is right; this proves applyBundle asks.
{
  const HERE = path.dirname(fileURLToPath(import.meta.url))
  const SRC = path.join(HERE, '..', 'supabase', 'functions', 'loan-bundle', 'index.ts')
  const src = fs.readFileSync(SRC, 'utf8')
  const applySrc = src.slice(src.indexOf('async function applyBundle'))
  if (!applySrc) throw new Error(`applyBundle is no longer in ${SRC} — this section cannot check anything`)

  ok('the claimed plan is what gets validated',
     /const claimedPlan = bundle\.plan as BundlePlan/.test(applySrc) &&
     /checkApproveList\(claimedPlan, approve\)/.test(applySrc) &&
     /divergedActions\(peekPlan, claimedPlan, approve\)/.test(applySrc))
  ok('...and it is what gets executed, by identity',
     /const plan = claimedPlan/.test(applySrc),
     'a third read of bundle.plan here would reopen the whole defect')
  ok('...and a refusal releases the claim rather than bricking the row',
     /if \(late \|\| moved\.length\) \{[\s\S]{0,400}?intake_bundles'\)\.update\(\{ status: back \}\)/.test(applySrc))

  ok('raise_finding reads the existing row before it writes',
     /reconciliation_findings'\)[\s\S]{0,120}?\.select\('status, pinned_note'\)[\s\S]{0,80}?\.eq\('fingerprint', fp\)/.test(applySrc))
  ok('...and routes the write through buildFindingWrite',
     /buildFindingWrite\(prevF,/.test(applySrc) && /upsert\(write\.row, \{ onConflict: 'fingerprint' \}\)/.test(applySrc))
  ok('...and the todayPacific fallback is gone from the fingerprint',
     !/intake:\$\{p\.check_key\}/.test(applySrc) && /findingFingerprint\(/.test(applySrc))

  ok('the closing update writes the merged receipt, not this run\'s failed list',
     /applied_actions: receipt,/.test(applySrc) && !/applied_actions: \{ applied: allApplied, failed \}/.test(applySrc))
  ok('...and the decisions column is merged, not replaced',
     /decisions: mergeDecisions\(bundle\.decisions, approve, who, now\)/.test(applySrc))
  ok('...and the fatal handler carries the earlier failures too',
     /mergeReceipt\(\{ applied: priorApplied, failed: priorFailed \}, \{ applied, failed \}\)/.test(applySrc))
  ok('the known-documents read failure releases on prior work',
     /const back = releaseStatus\(\[\], priorApplied\)[\s\S]{0,600}?Could not check which of these documents/.test(applySrc))
  ok('...and stops saying "nothing was applied" when something was',
     /priorApplied\.length[\s\S]{0,200}?still on the loan/.test(applySrc))

  ok('attach_document consults the seeded map before inserting',
     /documentAttachPlan\(p\.sha256, docIdBySha\)/.test(applySrc) &&
     applySrc.indexOf('documentAttachPlan(') < applySrc.indexOf("from('loan_documents').insert("))
  ok('...and reports an adoption as an adoption',
     /already on file/.test(applySrc))
  ok('...from the query already being made, not a second one',
     (applySrc.match(/from\('loan_documents'\)\s*\n?\s*\.select/g) || []).length === 1)
  ok('the known-documents query is deterministically ordered',
     /\.order\('created_at', \{ ascending: true \}\)/.test(applySrc))

  ok('the term marking always carries a source scope',
     /termMarkScope\(p\.source_sha256, docIdBySha\)/.test(applySrc) &&
     /\.eq\('source_document_id', src\.document_id\)/.test(applySrc) &&
     /\.is\('source_document_id', null\)/.test(applySrc))
  ok('...and the old conditional widening is gone',
     !/if \(termSrc\) markQ = markQ\.eq\('source_document_id', termSrc\)/.test(applySrc))

  // The things that were already right. They are load-bearing for everything
  // above, and a well-meaning tidy-up is the likeliest way to lose them.
  ok('the atomic claim is intact',
     /\.update\(\{ status: 'applying'[\s\S]{0,200}?\.in\('status', \['planned', 'partially_applied'\]\)/.test(applySrc))
  ok('the APPLYABLE whitelist is intact',
     /const APPLYABLE = new Set\(\['maturity_date', 'original_date', 'original_amount'\]\)/.test(applySrc))
  ok('correct_statement_basis still refuses to overwrite an established basis',
     /\.eq\('balance_basis', 'unknown'\)/.test(applySrc))
  ok('ok is still the failure count of THIS request, at 207',
     /ok: failed\.length === 0/.test(applySrc) && /failed\.length \? 207 : 200/.test(applySrc))
}

section('one balance per loan, per day, per source (session 251)')
{
  // THE ORIGINAL FAILURE (session 246). loan_statements carried
  // UNIQUE (loan_account_id, statement_date) — not (loan, date, source), which
  // this module had assumed by inference rather than by reading the schema. The
  // lookup asked only about its own source, found nothing, returned 'insert',
  // and Postgres raised the duplicate at David:
  //   duplicate key value violates unique constraint
  //   "loan_statements_loan_account_id_statement_date_key"
  //
  // THE FIX (session 251). The constraint is now (loan, date, source), so a
  // genuine lender figure can be filed on a day our own sweep already wrote —
  // this is the exact Stripe Capital pair from 2026-08-26 that motivated the
  // change: books $125,257.71 (xero_balance_snapshot), lender $123,091.66
  // (portal_manual_pull). Both now belong on file at once; that pair IS the
  // Variance the rollforward needs.
  const lender = { statement_date: '2026-08-26', principal_balance: 123091.66,
                   balance_basis: 'total_payback', source: 'portal_manual_pull' } as any
  const booksRow = [{ principal_balance: '125257.71', balance_basis: 'total_payback',
                      source: 'xero_balance_snapshot' }]

  const filed = statementRowWrite(booksRow, lender)
  ok('a day owned by another source now inserts alongside it, not refused',
     filed.verdict === 'insert', filed.verdict)

  // The ordinary paths must not have moved.
  ok('an empty day still inserts', statementRowWrite([], lender).verdict === 'insert')
  const mine = [{ principal_balance: '123091.66', balance_basis: 'total_payback', source: 'portal_manual_pull' }]
  ok('our own row with the same figure is adopted',
     statementRowWrite(mine, lender).verdict === 'already_filed')
  const disagree = [{ principal_balance: '120000.00', balance_basis: 'total_payback', source: 'portal_manual_pull' }]
  ok('our own row with a DIFFERENT figure is still a conflict',
     statementRowWrite(disagree, lender).verdict === 'conflict')
  ok('...and quotes only the row from our own source, not the whole day',
     /120,000\.00/.test((statementRowWrite([...disagree, ...booksRow], lender) as any).message) &&
     !/125,257\.71/.test((statementRowWrite([...disagree, ...booksRow], lender) as any).message))
  // A row with no source recorded is treated as possibly ours — refusing to file
  // beside it is the safe direction when we cannot tell whose day it is.
  ok('a source-less row on the day is not assumed to belong to someone else',
     statementRowWrite([{ principal_balance: '125257.71' }], lender).verdict === 'conflict')
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
