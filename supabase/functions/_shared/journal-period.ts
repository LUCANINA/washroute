// supabase/functions/_shared/journal-period.ts
//
// ONE RULE, ONE PLACE. Two callers ask the same question from opposite ends of the
// same event: `loan-xero-post` asks it of the POST response, the moment the journal
// is created; `reconciliation-run` asks it of every journal already in the books.
// Written twice they would drift on the only thing that matters — what counts as
// "the wrong month" — so it is written once, here.
//
// Neither the Finding type nor the loan/split shapes are imported: this file takes
// the three fields it needs and returns plain objects, so it can be unit-tested
// without a Deno runtime or a Xero token.

export type JournalMismatch = {
  fingerprint: string
  check_key: 'journal_period_mismatch'
  severity: 'error'
  loan_account_id: string
  title: string
  plain_english: string
  detail: Record<string, unknown>
}

// ═══════════════════════════════════════════════════════════════════════════
//  s318 — DID XERO STORE THE DATE WE SENT IT?
// ═══════════════════════════════════════════════════════════════════════════
//
// THE ONE FIELD THIS FUNCTION AUTHORS IS THE ONE FIELD NOBODY CHECKED. Everywhere
// else a date appears in this file it is echoed back from a Xero DateString we just
// read. The reallocation journals are the exception: they carry `Date:
// split.period_label`, a date WE choose — and the POST response's own
// `ManualJournals[0].Date` was read for its ID and discarded.
//
// Rapid Credit Line, August 2026 is what that cost: journal 71ed82b2 sent as
// 2026-08-31, stored by Xero as 2026-09-01, $457.14 moved out of the month being
// closed, and the close band reporting a variance with no way to see why.
//
// ⚠️ THIS WARNS, IT DOES NOT FAIL. By the time we can see the response the journal
// EXISTS in Xero. Returning an error here would leave a real journal behind an error
// message — the exact "Xero is ahead of us" shape xeroAheadOfUs() exists to prevent
// people walking into. The split is still marked posted, because it IS posted.
//
// ⚠️ AND IT DOES NOT WRITE A FINDING. `checkJournalPeriodMismatch` in
// reconciliation-run owns that claim, raises it for journals posted before this guard
// existed, and — the part that matters — RESOLVES it when the date is corrected.
// A second writer here would be the same claim from two sources, one of which could
// never clear itself. One writer per claim.
export function journalDateWarning(sent: string | null | undefined, journal: any) {
  const got = String(journal?.Date ?? journal?.DateString ?? '').slice(0, 10)
  const want = String(sent ?? '').slice(0, 10)
  if (!got || !want || got === want) return null
  const sameMonth = got.slice(0, 7) === want.slice(0, 7)
  return {
    sent: want,
    stored: got,
    crosses_month: !sameMonth,
    // A day out inside the month moves no month-end balance; a month out moves money
    // between two closes. Both are reported — this is the operator looking straight at
    // it — but only one of them is a problem, and the words say which.
    message: sameMonth
      ? `Xero stored this journal as ${got}, not the ${want} we sent. Same month, so no month-end balance moves — worth knowing, nothing to do.`
      : `⚠️ Xero stored this journal as ${got}, not the ${want} we sent — a DIFFERENT MONTH. ${want.slice(0, 7)} is now missing what it moves and ${got.slice(0, 7)} is carrying it. Change the date on journal ${journal?.ManualJournalID ?? ''} in Xero to ${want}.`,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  s318 — A JOURNAL WE POSTED, SITTING IN THE WRONG MONTH
// ═══════════════════════════════════════════════════════════════════════════
//
// THE CASE THIS EXISTS FOR, AND IT IS LIVE. Rapid Credit Line, August 2026: Xero's
// own Trial Balance for account 247 reads 51,071.88 at 31 Aug while the lender says
// 51,529.02. The entire $457.14 is ONE journal — 71ed82b2, our own interest
// reallocation for split 45ee2abd — which we sent as `Date: 2026-08-31` and which
// XERO STORED AS 2026-09-01. The journal is otherwise perfect: right lines, right
// accounts, right amounts, total $0.00. One field is wrong, and it moved $457.14
// out of the month being closed.
//
// ⚠️ NOTHING IN THE PRODUCT COMPARED THOSE TWO DATES. `loan-xero-post` originates
// this date (`Date: split.period_label` — the only place it does not echo a Xero
// DateString back), and the POST response carries `ManualJournals[0].Date`, which
// was read for its ID and nothing else. So the one field we author was the one
// field nobody checked.
//
// WHY THE CHECK LIVES HERE AND NOT ONLY AT POST TIME. A post-time guard catches the
// NEXT one; this catches the ones already sitting in the books, including Rapid's.
// It also self-resolves: the fingerprint stops being raised the moment the journal
// is re-dated, so the "clears automatically once a check confirms it's fixed"
// promise holds without anyone ticking anything off.
//
// NO EXTRA XERO CALLS. `allEntries` already carries every ManualJournal in the
// window with its `srcId` and the date Xero holds (see `norm` at the top of this
// file). The join is against `loan_splits.xero_manual_journal_id`, which is the id
// we stored when we posted it. Postgres lowercases uuids and Xero returns mixed-case
// GUIDs, so both sides are lowercased — the same trap checkUnexplainedLedgerAdjustment
// documents two functions below.
//
// ⚠️ ONLY A MONTH BOUNDARY IS A FINDING, AND THAT IS DELIBERATE. This module closes
// MONTHS. A journal landing a day out inside its own month moves no month-end
// balance and is nobody's problem; reporting it would be a nag on a correct book,
// and nags are what people learn to skip (s262). A journal landing in a different
// month moves money between two closes, which is the whole failure. A split labelled
// 'YYYY-MM' rather than 'YYYY-MM-DD' names no day at all, so for those the month
// comparison is the ONLY comparison available — which is the same answer, arrived at
// for a different reason.
export function checkJournalPeriodMismatch(loan: any, allEntries: any[], splits: any[]): JournalMismatch[] {
  const byId = new Map<string, any>()
  for (const r of allEntries) {
    if (r.srcType !== 'ManualJournal' || !r.srcId) continue
    byId.set(String(r.srcId).toLowerCase(), r)
  }
  const out: JournalMismatch[] = []
  for (const sp of splits) {
    const jid = sp.xero_manual_journal_id ? String(sp.xero_manual_journal_id).toLowerCase() : null
    if (!jid) continue                                  // not a journal we posted
    const label = String(sp.period_label || '')
    if (!/^\d{4}-\d{2}/.test(label)) continue           // no period to compare against
    const entry = byId.get(jid)
    // Not in the window, or not pulled this run. A MISSING journal is not evidence
    // that it is misdated — §247, a null is not a zero — and checkVoidedSinceLastRun
    // is what owns "it is not there any more".
    if (!entry || !entry.date) continue
    const ourMonth = label.slice(0, 7)
    const xeroMonth = String(entry.date).slice(0, 7)
    if (ourMonth === xeroMonth) continue
    out.push({
      fingerprint: `journal_period_mismatch:${jid}`,
      check_key: 'journal_period_mismatch',
      severity: 'error',
      loan_account_id: loan.id,
      title: `${loan.xero_account_name} — a journal for ${ourMonth} is dated ${entry.date} in Xero`,
      plain_english: `We posted this journal for ${label} and Xero stored it as ${entry.date} — a different month. `
        + `Everything else about it is right; only the date is wrong. While it sits there, ${ourMonth} is missing `
        + `whatever it moves and ${xeroMonth} is carrying it, so the loan will not tie to the lender in either month. `
        + `Change the date on journal ${entry.srcId} in Xero to ${label} and it will clear on the next check.`,
      detail: {
        date: entry.date,                 // the resolve sweep reads `detail.date`
        journal_id: entry.srcId,
        our_period: label,
        xero_date: entry.date,
        our_month: ourMonth,
        xero_month: xeroMonth,
        narration: entry.narration ?? null,
        split_id: sp.id ?? null,
      },
    })
  }
  return out
}
