import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { getXeroAuth } from '../_shared/xero-auth.ts'

// Role check: 'cpa' accounts may dry-run (preview) but never post/write.
// admin/manager may do both. Anything else is rejected outright.
async function callerRole(req: Request) {
  const authHeader = req.headers.get('Authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!)
  const { data: { user } } = await anon.auth.getUser(token)
  if (!user) return null
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).single()
  return profile?.role || null
}

// Matches a computed loan_splits row to its Xero bank-feed transaction, then --
// only when confirm=true -- posts a Manual Journal that reallocates the interest
// portion out of the loan liability account and into Interest Expense (800), and
// (statement-sourced splits only) attaches the source CSV as a permanent record.
//
// v7 (session 205): generalized to handle BOTH split sources, not just Ford-Pro-style
// statement_delta splits -- schedule-only lenders (e.g. Dexter) have no loan_statements
// row at all (current_statement_id is null), so `stmt.*` access on that path used to
// throw. Now branches on `split.source`:
//   - 'statement_delta': unchanged from v6 -- anchors the bank-transaction search on the
//     PRIOR statement's due date, attaches the pulled CSV to the posted journal.
//   - 'amortization_schedule': anchors the search on the matched amortization row's
//     row_date instead, and skips the attachment step (no per-period file exists --
//     the full schedule is already the permanent record in Storage from ingestion).
//
// IMPORTANT (discovered session 205, live against real data): Xero rejects any
// attempt to edit a bank transaction's own line items once it has been reconciled
// with a bank statement. This function never edits the original bank transaction --
// it leaves it exactly as-is and posts a separate Manual Journal instead. Works
// regardless of reconciliation status.
//
// Body: { loan_split_id: string, confirm?: boolean, revert?: boolean, bank_transaction_id?: string, posted_by?: string }
// Default is a dry run (confirm !== true): returns the matched candidate(s) and the
// proposed journal without writing anything to Xero. If more than one bank transaction
// matches, none are auto-selected -- pass bank_transaction_id explicitly to disambiguate.
// revert=true undoes an already-posted split -- see the v26 note below.
//
// v8 (session 205 cont., 2026-08-05): CORS fix. This function is called directly from
// the admin dashboard's browser fetch() (the Review Split modal + Approve & Post button),
// but had never handled the OPTIONS preflight or sent Access-Control-Allow-Origin --
// every browser call failed at the preflight stage with a generic "Failed to fetch",
// even though the function itself worked perfectly when called server-side (confirmed
// via direct reproduction). Every loan_splits row posted successfully earlier this
// session was posted by Claude calling this function directly, never by a real click
// in David's browser -- so this bug had never been exercised end-to-end until today.
// Fixed the same way charge-order (a function that DOES work from the browser) does it:
// a shared cors header object, an explicit OPTIONS short-circuit, and every response
// from the original handler gets the cors headers merged on afterward -- via a thin
// wrapper around the untouched original handler, so none of the actual posting logic
// above changed.
//
// v18 (session 212, 2026-08-15): XERO STATUS FILTER. This function matched a bank
// transaction on date window + bank account + amount ONLY, and never looked at the
// transaction's Status. Xero returns DELETED and VOIDED BankTransactions from the
// same endpoints as live ones, but neither affects the ledger -- so this could match
// a deleted draft and post a real POSTED reallocation journal against a transaction
// that does not exist in the books. That is exactly the failure mode found across
// four loans during the 2026-08-15 reconciliation review (BayFirst SBA Loan 3/6 and
// 5/5, BayFirst SBA 2 5/1, Dexter Loan 2 5/31 -- every one of them a live payment
// plus an identical deleted draft that had been counted as a second real payment).
// Only AUTHORISED bank transactions may now be matched, on every path including the
// explicit bank_transaction_id override and the unfiltered-paging fallback.
//
// v19 (session 218, 2026-08-17): NO-BANK-MATCH SPLITS. The bank-transaction search
// above assumes every split corresponds to exactly one lump bank payment that bundles
// principal + interest together -- find that transaction, carve interest out of it.
// That assumption breaks for two split shapes that are real, not edge cases:
//   1. A split with total_amount == 0 (a pure reclassification -- dollars move between
//      two GL accounts with no cash movement at all, e.g. a lender's periodic "Balance
//      Fee" line item that's billed against the loan balance itself, not paid via a
//      separate bank transaction -- Rapid Finance's Line of Credit statement is the
//      case that surfaced this). Searching Xero's bank feed for a $0.00 transaction
//      can never find anything meaningful.
//   2. A split with interest_amount == 0 (a payment that is 100% principal, nothing
//      embedded to reallocate). The old code still matched a bank transaction and
//      built a journal -- but both of that journal's lines came out to $0.00, and
//      Xero correctly rejects a manual journal with $0 lines. Discovered live: David's
//      first real test of the Rapid Finance auto-read flow hit this immediately on
//      the two payment-only splits it created (2026-08-04, 2026-08-11), both failing
//      with "Xero journal post failed" (502) after the amount-only match also turned
//      up 2 identical-amount candidates it couldn't disambiguate on its own.
// Both cases are handled BEFORE the bank-transaction search runs at all, since neither
// needs (or can meaningfully use) a bank-transaction match:
//   - total_amount == 0, interest != 0  ->  post a direct 2-line reclass journal dated
//     at the split's own period_label (the real fee/adjustment date), no bank txn
//     involved. As of session 222 this journal DOES carry the source statement as an
//     attachment -- the attachment belongs to the journal, not to a bank transaction.
//   - interest_amount == 0  ->  nothing to reallocate. Marked 'posted' with no Xero
//     write at all -- there is no journal that would do anything.
// This is a general fix, not Rapid-specific: any loan with a genuinely $0-interest
// period, or a genuinely non-cash reclass line, now behaves correctly instead of
// either erroring or (worse) posting a no-op journal.
//
// v20 (session 219, 2026-08-17): ACCOUNT NAMES ON REVIEW. The Review Split modal
// only ever showed raw Xero account codes ("800", "247") next to each journal line --
// no way for David or a CPA to sanity-check that a code actually points at the account
// they think it does without leaving the app and looking it up in Xero. Added
// fetchXeroAccountsMap() (one GET /Accounts call, code -> Name) and withAccountNames()
// to stamp an `AccountName` field onto every line returned to the frontend -- both the
// "Currently posted as" lines (real Xero bank-transaction LineItems) and the "Journal
// entry to post" lines (our own proposed/posted ManualJournal), on every response shape
// (dry run and confirmed post, all three split branches). Never sent as part of the
// actual POST payload to Xero -- purely additive on the response side, so this cannot
// change what gets posted, only what David sees before approving it. If the account
// lookup fails for any reason, AccountName comes back null and the frontend falls back
// to showing the code alone -- never blocks the review flow.
//
// v21 (session 219, 2026-08-17): AUTO-CLEAR FLAGS ON POSTING. Previously every loan
// flag (loan_accounts.flagged_note/flag_status system) needed a manual "Mark Resolved"
// click even when the flag's own condition -- "waiting on a statement to post interest
// on these payments" -- was mechanically satisfied the moment the split posted. David
// asked for this to self-resolve without requiring a full reconciliation-run. Added
// maybeAutoResolveFlag(), called right after every successful split-posting branch
// (all three: $0-interest no-op, pure reclass, and the normal bank-matched path). It
// only acts when loan_accounts.flag_clears_on_splits_posted = true (new column, migration
// session_219_loan_flag_auto_clear_on_splits_posted) -- a structured, per-loan opt-in
// set explicitly on flags that are genuinely of the "waiting on posting" shape, not a
// text-pattern guess. Advisory/narrative flags (e.g. Funding Circle's CPA-disclosure
// recommendation, which has no pending split to wait on) default to false and are
// untouched by this -- they still require a human's Mark Resolved. When the bit is set,
// the check is a single count of this loan's remaining pending_review/needs_attention
// splits; zero remaining calls the same mark_loan_flag_resolved RPC the manual button
// uses, stamped resolved_by='system:loan-xero-post'. Included as flag_auto_resolve in
// the response so the frontend (or a future admin note) can surface what happened;
// never throws, so a failure here can never block the split-posting response itself.
//
// v23 (session 219, 2026-08-17): SUCCINCT NARRATIONS. Same fix as payroll-xero-post
// v20 (see PROJECT-NOTES-BOOKKEEPING.md's "Xero Narration/Description succinctness"
// invariant) -- Xero's Account Transactions report shows a ManualJournal's Narration
// concatenated with every JournalLine's own Description, so a long sentence-style
// Narration is effectively repeated on every line of every journal, forever. Both
// journal shapes below (pure reclass, and the normal bank-matched reallocation) had
// long explanatory Narrations and Descriptions restating the same reasoning already
// covered in this file's comments -- shortened both to a short label + the period,
// nothing more. No change to account codes, amounts, dates, or posting logic.
//
// v24 (session 220, 2026-08-18): DIRECT TRANSACTION SPLIT -- PREVIEW ONLY (build step
// 2 of 5, see PROJECT-NOTES-BOOKKEEPING.md "Next Up -- Direct Transaction Split").
// For a loan with loan_accounts.direct_split_enabled = true (Rapid Credit Line only,
// v1), the dry-run (confirm !== true) path attempts a tighter +/-2-day closest-date
// match against a single not-yet-split bank transaction on the loan's own account, via
// findDirectSplitCandidate(). A clean match (live, not already multi-line, sum exactly
// matches the transaction's own Total) returns a `kind: 'direct_split'` preview shape
// instead of the manual-journal proposal. Any ambiguity, an already-split candidate, or
// a sum mismatch falls straight through to the existing manual-journal preview, UNCHANGED.
//
// v25 (session 220, 2026-08-18): BETTER ANCHOR DATE FOR NEW COMBINED SPLITS. A combined
// direct-split row created by loan-ingest-statement v20's pairing carries the real
// payment date as period_label ('YYYY-MM-DD'), unlike the statement-total model's
// 'YYYY-MM'. Anchor computation now uses period_label directly when it's a real date,
// instead of falling back to the statement's pull date (often days/weeks off).
//
// v26 (session 220, 2026-08-18): DIRECT TRANSACTION SPLIT -- WRITE + REVERT (build
// steps 3-4 of 5). Two additions, both still gated behind direct_split_enabled and both
// following the same "non-negotiable fallback" and "never mark posted/reverted unless
// Xero actually confirmed it" discipline as everything else in this file:
//
// WRITE (step 3): the direct-split block above now also runs when confirm === true, not
// just for preview. A clean match calls Xero's Update BankTransaction (POST to
// /BankTransactions with the existing BankTransactionID) with a 2-line LineItems array
// -- principal on the loan account, interest on Interest Expense (800), preserving the
// original line's Description/TaxType. BEFORE writing, the transaction's CURRENT
// LineItems are snapshotted into loan_splits.pre_split_line_items_snapshot -- this is
// what makes revert possible later. On success: posting_method='direct_split',
// matched_xero_bank_transaction_id set, xero_manual_journal_id left null, status='posted'.
// If the Update call fails for ANY reason (network, Xero validation, anything), this
// does NOT return an error to the user and does NOT touch the database -- it falls
// straight through to the existing manual-journal candidate search + Manual Journal
// creation below, exactly as if direct_split_enabled were false for this one call. Same
// principle as the pre-existing xero_check_error fallback pattern used elsewhere in this
// codebase: a direct-split failure must never block a post, only downgrade its mechanism.
//
// REVERT (step 4): new `revert: true` body flag (same admin/manager-only write
// authorization as confirm). Requires the split to be status='posted'. Branches on
// loan_splits.posting_method, which is exactly why that column was added in the schema
// step of this build:
//   - 'manual_journal' (includes the two v19 no-bank-match shapes): voids the Manual
//     Journal via POST /ManualJournals with Status:'VOIDED' (skipped entirely if
//     xero_manual_journal_id is null -- the $0-interest no-op case never had one), then
//     resets status back to 'pending_review' and clears the posting fields.
//   - 'direct_split': calls Update BankTransaction again, this time restoring
//     pre_split_line_items_snapshot verbatim (not reconstructed -- the exact original
//     LineItems array captured before the split, including any description or tracking
//     detail Xero had on the line), then resets status to 'pending_review',
//     posting_method back to 'manual_journal' (the default -- next confirm re-decides),
//     and clears matched_xero_bank_transaction_id + the snapshot.
// If the Xero call fails on either path, the function returns an error and the
// database row is left completely untouched -- a split must never be marked reverted
// in our own records if Xero itself wasn't actually changed back.
// NOT YET DONE: no frontend button calls revert=true yet (there has never been a
// self-service revert UI for loan splits in this codebase -- every past revert, e.g.
// the 8 duplicate Rapid journals in session 218 and the Maria Castellanos payroll
// journal this session, was done by Claude calling Supabase/Xero directly by hand).
// This gives that a real, reusable, tested code path instead of another one-off. Per
// the build plan's own testing sequence, the FIRST real use of revert=true should be
// the confirm+revert round-trip test on a single low-stakes Rapid period -- split,
// verify in Xero, revert, verify the original line item is back exactly -- before this
// is trusted for anything else.
//
// v28 (session 222, 2026-08-19): DIRECT SPLIT EXPLICIT DISAMBIGUATION. The very first
// live confirm attempt on a Rapid Credit Line split hit the ambiguous-candidates case
// (3 live bank transactions matched the amount in the wider manual-journal search
// window) and surfaced the frontend's existing candidate picker. Clicking a candidate
// passes bank_transaction_id back to this function -- which, before this version,
// caused the direct-split block above to be skipped entirely (gated on
// `!bank_transaction_id`), silently falling back to posting a Manual Journal instead
// of the in-place BankTransaction edit the preview had promised. No error, no warning
// -- just a different, unintended Xero write. Fixed by threading the explicit ID into
// findDirectSplitCandidate() itself (new preferredBankTransactionId param) so an
// operator's disambiguating pick still results in a genuine Direct Transaction Split;
// an explicit pick that fails validation (wrong amount/account/status/already split)
// is now a hard error instead of a silent fallback, matching how the manual-journal
// path has always treated an explicit pick.
//
// v29 (session 222, 2026-08-19): RECONCILED TRANSACTIONS CANNOT BE DIRECT-SPLIT --
// the real reason the first live direct split never worked, and it invalidates the
// assumption v24-v28 were built on. Proven live: replaying v28's exact Update payload
// against the real 2026-08-18 Rapid transaction returned HTTP 400 "This Bank Transaction
// cannot be edited as it has been reconciled with a Bank Statement." Nothing was written.
// That is the same constraint already documented in the session-205 note above, which was
// never applied to this feature. (David's 2026-08-17 Xero *UI* test looked like it
// contradicted this; the UI's split tool and the API's Update endpoint differ -- the UI
// can re-code a reconciled transaction, the API cannot touch it.) Every Rapid payment
// arrives auto-reconciled, and Rapid is the only direct_split_enabled loan, so in-place
// splits can effectively never succeed there. That failure used to be invisible: preview
// promised a direct split, confirm silently fell through to the manual-journal path,
// whose wider -15/+3 window then hit all three identical $2,068.89 weekly payments and
// returned an "ambiguous candidates" error unrelated to the real cause.
// Fixed by degrading honestly instead of silently: findDirectSplitCandidate() checks
// IsReconciled (both branches) and returns 'reconciled_cannot_edit' WITH the candidate,
// so the doomed Update is never attempted; that reason is excluded from the explicit-pick
// hard-error set (the pick was right, only the mechanism is unavailable); and the
// identified transaction is carried into the manual-journal path via effectiveBankTxnId
// so the journal posts against THAT transaction rather than re-searching -- which is what
// makes a fixed repeating payment postable at all, since the tight +/-2-day matcher can
// tell the three weekly payments apart and the wider window structurally cannot.
// Responses carry `direct_split_skipped` with a plain-English explanation, and the
// preview's `note` leads with it, so the operator knows the mechanism before approving.
// Accounting outcome is identical either way -- loan account reduced by principal only,
// interest on 800; one two-line transaction vs. transaction + reallocating journal.
// FOLLOW-UP (same session): direct_split_enabled was subsequently turned OFF for Rapid
// Credit Line -- see PROJECT-NOTES-BOOKKEEPING.md item 10. With it off, loan-ingest-
// statement's v20 pairing also stops, so Rapid returns to the two-row model: the bank
// payment is 100% principal and gets NO Xero write at all, and the lender's balance fee
// posts as its own journal dated the day the fee was charged. One document per week,
// and it reads as a finance charge rather than a correction to a payment.

// v30 (session 222, 2026-08-19): WORDING. The fee/reclass journal is what David now
// sees in Xero every week for Rapid (direct_split_enabled was turned off in the same
// change -- see PROJECT-NOTES-BOOKKEEPING.md item 10), so its wording matters. It said
// "<Loan> reclass" / "Interest reclass" / "<Loan> reclass", which reads like someone
// fixing a mistake. It is not a correction: it books the lender's balance fee on the
// date the lender charged it. Renamed to "<Loan> - balance fee, <date>" / "Interest" /
// "Balance fee". No change to accounts, amounts, dates, signs, or any posting logic.

const INTEREST_EXPENSE_ACCOUNT_CODE = '800'
const ZERO_TOLERANCE = 0.005 // dollars -- treat anything under half a cent as exactly zero
const DIRECT_SPLIT_WINDOW_DAYS = 2 // v24 -- David's call, tightened from an initial 3

// The single source of truth for "is this Xero bank transaction real?". AUTHORISED
// is the only status that hits the ledger; DELETED and VOIDED are still returned by
// the API but must never be matched or reported as a payment. See the v18 note above.
const isLiveBankTxn = (t: any) => t?.Status === 'AUTHORISED'

// Whole-day distance between two dates. Used ONLY for operator-facing warnings and
// for annotating candidates in the not-found response -- never for matching itself.
const wholeDaysBetween = (a: Date, b: Date) => Math.round(Math.abs(a.getTime() - b.getTime()) / 86400000)
const isoDay = (d: Date) => (d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function admin() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
}

function contentTypeFor(filename: string) {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'csv') return 'text/csv'
  return 'application/octet-stream'
}

// --- Attach a source statement to a posted Manual Journal (session 222) ---
//
// One implementation, two call sites: the pure-reclass/fee journal and the bank-matched
// journal. Both post a Manual Journal and both have a source statement sitting in
// Storage, so both should carry the proof document. Previously only the bank-matched
// path attached, and the reclass path hardcoded `attached: false` with the reason
// "no bank transaction, nothing to attach to" -- which conflated two different things:
// the attachment goes on the JOURNAL, not on a bank transaction. There is a journal and
// there is a statement, so it can and should attach. This matters more since session 222
// made the fee journal the normal output for Rapid and Funding Circle: an attached
// statement is the single biggest factor in whether a reviewer treats a journal as
// documented or as unexplained.
//
// SCOPE NOTE: `accounting.attachments` IS authorized on this connection -- verified live
// against a real Manual Journal. A comment here previously claimed the opposite; it was
// written in session 205 when the scope genuinely was missing, and was never revisited
// after the scope was added. Removed rather than left to mislead again.
//
// NEVER THROWS, by design. At every call site the journal is ALREADY posted in Xero by
// the time this runs. Turning an attachment failure into a 500 would report a successful
// post as a failure and invite a duplicate re-post -- strictly worse than a documented
// journal missing its PDF. Failures surface in the response body instead.
async function attachStatementToJournal(
  supa: any,
  token: string,
  tenantId: string,
  stmt: any,
  journalId: string | undefined,
  skipReason?: string,
): Promise<Record<string, unknown>> {
  if (skipReason) return { attached: false, reason: skipReason }
  if (!journalId) return { attached: false, reason: 'Xero returned no ManualJournalID -- nothing to attach to' }
  if (!stmt?.storage_path) return { attached: false, reason: 'no source statement file is linked to this split' }
  try {
    const { data: fileBlob, error: dlErr } = await supa.storage.from('loan-statements').download(stmt.storage_path)
    if (dlErr || !fileBlob) return { attached: false, error: dlErr?.message || 'statement download from Storage failed' }
    const fileBytes = new Uint8Array(await fileBlob.arrayBuffer())
    const fileName = stmt.storage_path.split('/').pop()
    const attRes = await fetch(
      `https://api.xero.com/api.xro/2.0/ManualJournals/${journalId}/Attachments/${encodeURIComponent(fileName)}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Xero-tenant-id': tenantId,
          'Accept': 'application/json',
          'Content-Type': contentTypeFor(fileName),
        },
        body: fileBytes,
      },
    )
    if (!attRes.ok) {
      // Keep the body: a 401 here means a scope regression, a 400 usually means the
      // filename or content type was rejected. Those need different fixes, so the
      // status alone is not enough to act on.
      const detail = await attRes.text().catch(() => '')
      return { attached: false, status: attRes.status, filename: fileName, error: detail.slice(0, 300) }
    }
    return { attached: true, status: attRes.status, filename: fileName }
  } catch (e) {
    return { attached: false, error: String((e as any)?.message || e) }
  }
}

// Shared so both call sites give the reviewer the same wording for the same situation.
const SCHEDULE_SOURCED_SKIP =
  'schedule-sourced split -- no per-period file exists; the full amortization schedule is already the permanent record in Storage'


// v20: code -> name lookup for the chart of accounts, used purely to annotate review
// output with human-readable account names. Never throws -- a failure here should
// degrade to "no name shown," never block the review/post flow.
async function fetchXeroAccountsMap(headers: Record<string, string>): Promise<Record<string, string>> {
  try {
    const res = await fetch('https://api.xero.com/api.xro/2.0/Accounts', { headers })
    if (!res.ok) return {}
    const json = await res.json().catch(() => null)
    const map: Record<string, string> = {}
    for (const a of json?.Accounts || []) {
      if (a?.Code) map[a.Code] = a.Name
    }
    return map
  } catch {
    return {}
  }
}

function withAccountNames(lines: any[] | undefined | null, acctMap: Record<string, string>) {
  return (lines || []).map((l: any) => ({ ...l, AccountName: acctMap[l.AccountCode] ?? null }))
}

// v21 (session 219): auto-clear a loan flag the moment posting satisfies it, without
// requiring a full reconciliation-run. Only acts when the loan_accounts row is
// explicitly marked flag_clears_on_splits_posted = true (see migration
// session_219_loan_flag_auto_clear_on_splits_posted) -- i.e. the flag itself is of the
// "waiting on a statement to post interest" shape, not an advisory/narrative flag like
// Funding Circle's CPA-disclosure recommendation. Condition: this loan_account has zero
// loan_splits left in pending_review/needs_attention. Never throws -- a failure here
// must never block the split-posting response that triggered it.
async function maybeAutoResolveFlag(supa: any, loanAcct: any): Promise<any> {
  try {
    if (!loanAcct?.flag_clears_on_splits_posted) return { attempted: false }
    if (!loanAcct.flag_status || loanAcct.flag_status === 'resolved') return { attempted: false }
    const { count, error: countErr } = await supa
      .from('loan_splits')
      .select('id', { count: 'exact', head: true })
      .eq('loan_account_id', loanAcct.id)
      .in('status', ['pending_review', 'needs_attention'])
    if (countErr) return { attempted: true, resolved: false, error: countErr.message }
    if ((count ?? 0) > 0) return { attempted: true, resolved: false, remaining_pending_splits: count }
    const { error: rpcErr } = await supa.rpc('mark_loan_flag_resolved', {
      p_loan_account_id: loanAcct.id,
      p_resolved: true,
      p_resolution_note: 'Auto-resolved: all outstanding splits for this loan are now posted to Xero.',
      p_resolved_by: 'system:loan-xero-post',
    })
    if (rpcErr) return { attempted: true, resolved: false, error: rpcErr.message }
    return { attempted: true, resolved: true }
  } catch (e) {
    return { attempted: true, resolved: false, error: String((e as any)?.message || e) }
  }
}

// v24: tighter, symmetric +/-2-day "closest date wins" search for the Direct
// Transaction Split feature -- deliberately NOT a reuse of the wider -15/+3 window
// used below for the manual-journal candidate search (that one anchors on a due date
// and tolerates a payment landing well after it; this one is matching a specific fee
// to its nearest already-existing payment transaction, a tighter and different job).
// Returns { candidate: <full Xero BankTransaction w/ LineItems> | null, reason, candidates? }
async function findDirectSplitCandidate(
  headers: Record<string, string>,
  loanAcct: any,
  split: any,
  anchorDate: Date,
  preferredBankTransactionId?: string,
): Promise<{ candidate: any; reason: string; candidates?: any[]; errorMessage?: string; errorDetail?: any; errorStatus?: number }> {
  const target = Number(split.total_amount)

  // v28 (session 222): explicit operator disambiguation. When the auto-match window
  // (below) turns up more than one live candidate, the frontend shows a picker built
  // from the manual-journal fallback's wider search and lets the operator click one --
  // that click passes its bank_transaction_id straight back here so the loan still gets
  // a genuine Direct Transaction Split instead of being silently downgraded to a Manual
  // Journal just because an ID was supplied (see the v28 note above the write block for
  // why that downgrade was happening). Validated exactly like the manual-journal path's
  // own explicit-ID handling -- must exist, be live, match this split's amount, and sit
  // on this loan's bank account. Any failure is a hard error, never a silent fallback,
  // because a human named a specific transaction on purpose.
  if (preferredBankTransactionId) {
    const r = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions/${preferredBankTransactionId}`, { headers })
    const j = await r.json().catch(() => null)
    const picked = j?.BankTransactions?.[0] || null
    if (!picked) {
      return { candidate: null, reason: 'explicit_not_found', errorMessage: `Bank transaction ${preferredBankTransactionId} not found in Xero`, errorStatus: 404 }
    }
    if (!isLiveBankTxn(picked)) {
      return {
        candidate: null, reason: 'explicit_not_live',
        errorMessage: `Bank transaction ${preferredBankTransactionId} has Xero status ${picked.Status} -- it is not a live transaction and must not be posted against. If there is an identical AUTHORISED transaction on or near this date, pass that one's ID instead.`,
        errorDetail: { id: picked.BankTransactionID, date: picked.DateString, total: picked.Total, status: picked.Status },
        errorStatus: 409,
      }
    }
    if (Math.abs(Number(picked.Total) - target) >= 0.02) {
      return {
        candidate: null, reason: 'explicit_wrong_amount',
        errorMessage: `Bank transaction ${preferredBankTransactionId} is $${Number(picked.Total).toFixed(2)} but this split is $${target.toFixed(2)}. Refusing to post a split against a transaction of a different amount.`,
        errorDetail: { id: picked.BankTransactionID, date: picked.DateString, total: picked.Total, status: picked.Status },
        errorStatus: 409,
      }
    }
    if (picked.BankAccount?.AccountID?.toLowerCase() !== loanAcct.xero_bank_account_id?.toLowerCase()) {
      return {
        candidate: null, reason: 'explicit_wrong_account',
        errorMessage: `Bank transaction ${preferredBankTransactionId} is not on this loan's bank account. Refusing to post a split against a transaction from a different bank account.`,
        errorDetail: { id: picked.BankTransactionID, date: picked.DateString, total: picked.Total, status: picked.Status, bank_account_id: picked.BankAccount?.AccountID },
        errorStatus: 409,
      }
    }
    if ((picked.LineItems || []).length !== 1) {
      return {
        candidate: null, reason: 'explicit_already_split',
        errorMessage: `Bank transaction ${preferredBankTransactionId} already has more than one line item -- it looks like it's already been split. Refusing to split it again.`,
        errorDetail: { id: picked.BankTransactionID, date: picked.DateString, total: picked.Total, line_items: picked.LineItems },
        errorStatus: 409,
      }
    }
    // v29: reconciled transactions cannot be edited via the API at all (see the v29
    // note above). This is NOT an error and NOT a bad pick -- the operator named the
    // right transaction, Xero simply won't let this mechanism touch it. Returned WITH
    // the candidate so the caller can hand this exact transaction to the manual-journal
    // path instead of falling back into a blind re-search.
    if (picked.IsReconciled) {
      return { candidate: picked, reason: 'reconciled_cannot_edit' }
    }
    return { candidate: picked, reason: 'ok' }
  }

  const from = new Date(anchorDate); from.setDate(from.getDate() - DIRECT_SPLIT_WINDOW_DAYS)
  const to = new Date(anchorDate); to.setDate(to.getDate() + DIRECT_SPLIT_WINDOW_DAYS)
  const fmt = (d: Date) => `${d.getFullYear()},${d.getMonth() + 1},${d.getDate()}`
  const whereClause = `Date >= DateTime(${fmt(from)}) && Date <= DateTime(${fmt(to)})`
  let list: any[] = []
  const r1 = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions?where=${encodeURIComponent(whereClause)}&order=Date DESC`, { headers })
  if (r1.ok) {
    const j1 = await r1.json()
    list = j1.BankTransactions || []
  } else {
    for (let page = 1; page <= 4; page++) {
      const rp = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions?page=${page}&order=Date DESC`, { headers })
      if (!rp.ok) break
      const jp = await rp.json()
      const batch = jp.BankTransactions || []
      if (!batch.length) break
      list.push(...batch)
      const oldest = batch[batch.length - 1]?.DateString ? new Date(batch[batch.length - 1].DateString) : null
      if (oldest && oldest < from) break
    }
    list = list.filter(t => {
      const d = t.DateString ? new Date(t.DateString) : null
      return d && d >= from && d <= to
    })
  }

  const amountAndAccountMatch = (t: any) =>
    t.BankAccount?.AccountID?.toLowerCase() === loanAcct.xero_bank_account_id.toLowerCase() &&
    Math.abs(Number(t.Total) - target) < 0.02
  const live = list.filter(t => isLiveBankTxn(t) && amountAndAccountMatch(t))
  if (live.length === 0) return { candidate: null, reason: 'no_match' }

  const withDist = live.map(t => ({ t, dist: Math.abs(new Date(t.DateString).getTime() - anchorDate.getTime()) }))
  withDist.sort((a, b) => a.dist - b.dist)
  if (withDist.length > 1 && withDist[0].dist === withDist[1].dist) {
    return { candidate: null, reason: 'ambiguous_tie', candidates: live }
  }

  // The list endpoint omits LineItems -- fetch full detail both to check "already
  // split" (more than one line item means someone/something already touched this
  // transaction) and to build the proposal.
  const best = withDist[0].t
  const detailRes = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions/${best.BankTransactionID}`, { headers })
  const detailJson = await detailRes.json().catch(() => null)
  const detail = detailJson?.BankTransactions?.[0] || best
  if ((detail.LineItems || []).length !== 1) {
    return { candidate: null, reason: 'already_split', candidates: live }
  }
  // v29: see the explicit-pick branch above -- a reconciled transaction is a correct
  // match that this mechanism simply cannot write to. Return it so the caller can reuse
  // the identification (it is the single closest amount+account match within the tight
  // window) for the manual-journal path, instead of discarding it and re-searching a
  // much wider window that, for a fixed weekly payment, will always be ambiguous.
  if (detail.IsReconciled) {
    return { candidate: detail, reason: 'reconciled_cannot_edit' }
  }
  return { candidate: detail, reason: 'ok' }
}

async function handleRequest(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 })
    const body = await req.json().catch(() => ({}))
    const { loan_split_id, confirm, revert, bank_transaction_id, posted_by } = body
    if (!loan_split_id) return new Response(JSON.stringify({ error: 'loan_split_id is required' }), { status: 400 })

    const role = await callerRole(req)
    if (!role || !['admin', 'manager', 'cpa'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Not authorized.' }), { status: 403 })
    }
    if ((confirm || revert) && !['admin', 'manager'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Your account has read-only access -- posting to or reverting from Xero requires an admin or manager.' }), { status: 403 })
    }

    const supa = admin()
    const { data: split, error: splitErr } = await supa
      .from('loan_splits')
      .select('*, loan_accounts(*), current_stmt:loan_statements!loan_splits_current_statement_id_fkey(*), prior_stmt:loan_statements!loan_splits_prior_statement_id_fkey(*), amortization_row:loan_amortization_rows(*)')
      .eq('id', loan_split_id)
      .single()
    if (splitErr || !split) {
      return new Response(JSON.stringify({ error: 'loan_splits row not found', details: splitErr?.message }), { status: 404 })
    }

    const loanAcct = split.loan_accounts
    if (!loanAcct?.xero_account_id || !loanAcct?.xero_bank_account_id) {
      return new Response(JSON.stringify({ error: 'loan_accounts row is missing xero_account_id or xero_bank_account_id' }), { status: 400 })
    }

    // v26: REVERT. Handled first and separately from everything below -- it operates
    // on an already-posted split, branching purely on posting_method, and needs none
    // of the interest/total-shape logic that governs a fresh proposal.
    if (revert) {
      if (split.status !== 'posted') {
        return new Response(JSON.stringify({ error: 'This split is not posted -- nothing to revert.' }), { status: 409 })
      }
      const { headers: revertHeaders } = await getXeroAuth()

      if (split.posting_method === 'direct_split') {
        if (!split.matched_xero_bank_transaction_id || !split.pre_split_line_items_snapshot) {
          return new Response(JSON.stringify({ error: 'This split is marked direct_split but is missing its matched transaction id or original line-item snapshot -- cannot safely auto-revert. Needs manual review in Xero.' }), { status: 409 })
        }
        const detailRes = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions/${split.matched_xero_bank_transaction_id}`, { headers: revertHeaders })
        const detailJson = await detailRes.json().catch(() => null)
        const current = detailJson?.BankTransactions?.[0]
        if (!current) {
          return new Response(JSON.stringify({ error: `Could not fetch bank transaction ${split.matched_xero_bank_transaction_id} from Xero to revert it.`, status: detailRes.status }), { status: 502 })
        }
        const restorePayload = {
          BankTransactions: [{
            BankTransactionID: current.BankTransactionID,
            Type: current.Type,
            Contact: current.Contact,
            BankAccount: current.BankAccount,
            Date: current.DateString?.slice(0, 10),
            Reference: current.Reference,
            LineAmountTypes: current.LineAmountTypes,
            Status: current.Status,
            LineItems: (split.pre_split_line_items_snapshot || []).map((l: any) => ({
              Description: l.Description,
              Quantity: l.Quantity ?? 1,
              LineAmount: l.LineAmount,
              AccountCode: l.AccountCode,
              TaxType: l.TaxType,
            })),
          }],
        }
        const restoreRes = await fetch('https://api.xero.com/api.xro/2.0/BankTransactions', {
          method: 'POST',
          headers: { ...revertHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify(restorePayload),
        })
        const restoreJson = await restoreRes.json().catch(() => null)
        if (!restoreRes.ok || restoreJson?.Elements?.[0]?.ValidationErrors?.length) {
          return new Response(JSON.stringify({ error: 'Reverting the direct split failed -- the bank transaction was NOT changed in Xero, and nothing in the database was updated either.', status: restoreRes.status, details: restoreJson }), { status: 502 })
        }
        const acctMapRevert = await fetchXeroAccountsMap(revertHeaders)
        const { error: revertErr1 } = await supa
          .from('loan_splits')
          .update({
            status: 'pending_review',
            matched_xero_bank_transaction_id: null,
            posting_method: 'manual_journal',
            pre_split_line_items_snapshot: null,
            xero_manual_journal_id: null,
            xero_posted_at: null,
            xero_posted_by: null,
            review_notes: (split.review_notes ? split.review_notes + ' -- ' : '') + `Direct split reverted ${new Date().toISOString().slice(0, 10)}${posted_by ? ' by ' + posted_by : ''}; original bank-transaction line items restored.`,
          })
          .eq('id', loan_split_id)
        return new Response(JSON.stringify({
          ok: true,
          reverted: 'direct_split',
          bank_transaction: { id: current.BankTransactionID, restored_lines: withAccountNames(restoreJson?.BankTransactions?.[0]?.LineItems, acctMapRevert) },
          loan_splits_update_error: revertErr1?.message,
        }, null, 2), { headers: { 'Content-Type': 'application/json' } })
      }

      // posting_method === 'manual_journal' (default -- also covers both v19
      // no-bank-match shapes, one of which never had a journal to begin with).
      let voidResult: any = { voided: false, reason: 'no journal to void' }
      if (split.xero_manual_journal_id) {
        const voidRes = await fetch('https://api.xero.com/api.xro/2.0/ManualJournals', {
          method: 'POST',
          headers: { ...revertHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ManualJournals: [{ ManualJournalID: split.xero_manual_journal_id, Status: 'VOIDED' }] }),
        })
        const voidJson = await voidRes.json().catch(() => null)
        if (!voidRes.ok || voidJson?.Elements?.[0]?.ValidationErrors?.length) {
          return new Response(JSON.stringify({ error: 'Voiding the Manual Journal failed -- nothing in the database was updated.', status: voidRes.status, details: voidJson }), { status: 502 })
        }
        voidResult = { voided: true, id: split.xero_manual_journal_id }
      }
      const { error: revertErr2 } = await supa
        .from('loan_splits')
        .update({
          status: 'pending_review',
          matched_xero_bank_transaction_id: null,
          xero_manual_journal_id: null,
          xero_posted_at: null,
          xero_posted_by: null,
          review_notes: (split.review_notes ? split.review_notes + ' -- ' : '') + `Reverted ${new Date().toISOString().slice(0, 10)}${posted_by ? ' by ' + posted_by : ''}${voidResult.voided ? '; Manual Journal voided' : '; no journal existed to void'}.`,
        })
        .eq('id', loan_split_id)
      return new Response(JSON.stringify({
        ok: true,
        reverted: 'manual_journal',
        manual_journal: voidResult,
        loan_splits_update_error: revertErr2?.message,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } })
    }

    if (split.status === 'posted') {
      return new Response(JSON.stringify({ error: 'This split is already posted to Xero.', matched_xero_bank_transaction_id: split.matched_xero_bank_transaction_id, xero_manual_journal_id: split.xero_manual_journal_id }), { status: 409 })
    }

    const stmt = split.current_stmt
    const priorStmt = split.prior_stmt
    const amortRow = split.amortization_row
    const isScheduleSourced = split.source === 'amortization_schedule' || !stmt
    if (isScheduleSourced && !amortRow) {
      return new Response(JSON.stringify({ error: 'This split has no statement AND no linked amortization row -- cannot determine a search anchor date.' }), { status: 400 })
    }

    const principal = Number(split.principal_amount)
    const interest = Number(split.interest_amount)
    const totalAmt = Number(split.total_amount)

    // token + tenantId are still destructured out: the attachment PUT below builds its
    // own headers because it needs a different Content-Type.
    const { headers, accessToken: token, tenantId } = await getXeroAuth()

    // --- v19: no-bank-match paths (see the version note above for why these exist) ---

    // Case 1: nothing to reallocate at all -- a payment that is 100% principal.
    if (Math.abs(interest) < ZERO_TOLERANCE) {
      if (!confirm) {
        return new Response(JSON.stringify({
          dry_run: true,
          source: split.source,
          matched_bank_transaction: null,
          proposed_journal: null,
          split,
          note: `This ${split.period_label} split has $0.00 interest -- the full $${principal.toFixed(2)} is already principal with nothing to reallocate. Approving will mark it posted with no Xero write, no bank-transaction match needed.`,
        }, null, 2), { headers: { 'Content-Type': 'application/json' } })
      }
      const { error: updateErr } = await supa
        .from('loan_splits')
        .update({
          matched_xero_bank_transaction_id: null,
          xero_manual_journal_id: null,
          xero_posted_at: new Date().toISOString(),
          xero_posted_by: posted_by ?? null,
          status: 'posted',
          review_notes: (split.review_notes ? split.review_notes + ' -- ' : '') + 'No Xero journal needed: $0.00 interest, nothing to reallocate.',
        })
        .eq('id', loan_split_id)
      const flagAutoResolve1 = await maybeAutoResolveFlag(supa, loanAcct)
      return new Response(JSON.stringify({
        ok: true,
        no_journal_needed: true,
        note: '$0.00 interest -- nothing was posted to Xero, this split is just marked reconciled.',
        loan_splits_update_error: updateErr?.message,
        flag_auto_resolve: flagAutoResolve1,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } })
    }

    // v20: chart-of-accounts lookup for review annotation, used by every remaining
    // path below (both stay purely additive on the response -- see version note).
    const acctMap = await fetchXeroAccountsMap(headers)

    // Case 2: a pure reclassification with no cash movement -- e.g. a lender fee
    // billed directly against the loan balance, never touching the bank feed.
    if (Math.abs(totalAmt) < ZERO_TOLERANCE) {
      const journalPayload = {
        ManualJournals: [{
          Narration: `${loanAcct.xero_account_name} — balance fee, ${split.period_label}`,
          Date: split.period_label,
          Status: 'POSTED',
          JournalLines: [
            { LineAmount: interest, AccountCode: INTEREST_EXPENSE_ACCOUNT_CODE, Description: `Interest`, TaxType: 'NONE' },
            { LineAmount: -interest, AccountCode: loanAcct.xero_account_code, Description: `Balance fee`, TaxType: 'NONE' },
          ],
        }],
      }
      if (!confirm) {
        return new Response(JSON.stringify({
          dry_run: true,
          source: split.source,
          matched_bank_transaction: null,
          proposed_journal: { ...journalPayload.ManualJournals[0], JournalLines: withAccountNames(journalPayload.ManualJournals[0].JournalLines, acctMap) },
          split,
          note: 'No bank transaction to match -- this reclassifies dollars between two GL accounts directly, with no cash movement involved.',
        }, null, 2), { headers: { 'Content-Type': 'application/json' } })
      }
      const postRes = await fetch('https://api.xero.com/api.xro/2.0/ManualJournals', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(journalPayload),
      })
      const postJson = await postRes.json().catch(() => null)
      if (!postRes.ok || postJson?.Elements?.[0]?.ValidationErrors?.length) {
        return new Response(JSON.stringify({ error: 'Xero journal post failed', status: postRes.status, details: postJson }), { status: 502 })
      }
      const journal = postJson.ManualJournals?.[0]

      // Attach the statement this fee was read from. See attachStatementToJournal().
      const reclassAttachment = await attachStatementToJournal(
        supa, token, tenantId, stmt, journal?.ManualJournalID,
        isScheduleSourced ? SCHEDULE_SOURCED_SKIP : undefined,
      )

      const { error: updateErr } = await supa
        .from('loan_splits')
        .update({
          matched_xero_bank_transaction_id: null,
          xero_manual_journal_id: journal?.ManualJournalID ?? null,
          xero_posted_at: new Date().toISOString(),
          xero_posted_by: posted_by ?? null,
          status: 'posted',
        })
        .eq('id', loan_split_id)
      const flagAutoResolve2 = await maybeAutoResolveFlag(supa, loanAcct)
      return new Response(JSON.stringify({
        ok: true,
        original_bank_transaction: null,
        manual_journal: { id: journal?.ManualJournalID, lines: withAccountNames(journal?.JournalLines, acctMap) },
        attachment: reclassAttachment,
        loan_splits_update_error: updateErr?.message,
        flag_auto_resolve: flagAutoResolve2,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } })
    }

    // v24 / v25 / v26: Direct Transaction Split -- preview AND write. See the version-note
    // block above for the full rationale. Runs for both dry-run and confirm; a failure at
    // any point (no match, ambiguous, already-split, sum mismatch, or the Update call
    // itself failing) falls straight through to the existing manual-journal path below,
    // UNCHANGED -- this whole block never returns an error, only a result or a fallthrough.
    //
    // v28 (session 222): a bank_transaction_id no longer skips this block for a
    // direct_split_enabled loan. Previously it did -- which meant clicking a candidate
    // in the ambiguous-match picker (which passes bank_transaction_id to disambiguate)
    // silently downgraded the write from an in-place Direct Transaction Split to a
    // Manual Journal, with no indication to the operator that the mechanism had
    // changed from what the preview promised. Root cause: bank_transaction_id was
    // being treated as "skip auto-matching, use the old manual-journal mechanism"
    // when what the operator actually meant was "skip auto-matching, use THIS
    // transaction" -- those are two different things and only the second was
    // intended. Now the ID is passed into findDirectSplitCandidate() itself, which
    // validates it (live, right amount, right account, not already split) and uses it
    // directly in place of the date-window search -- still performing the same
    // in-place Update BankTransaction as an auto-matched pick would. An explicit pick
    // that fails validation is a hard error (see immediately below), never a silent
    // fallback to Manual Journal -- a human named a specific transaction on purpose.
    // v29: set when the direct-split matcher positively identified the right bank
    // transaction but could not split it in place. Carries that identification into the
    // manual-journal path below so it posts against the SAME transaction rather than
    // re-searching. Also surfaced on the response so the operator is told which
    // mechanism they are actually getting, and why.
    let directSplitSkipped: Record<string, any> | null = null
    let identifiedBankTxnId: string | null = null

    if (loanAcct.direct_split_enabled) {
      const periodLabelIsRealDate = /^\d{4}-\d{2}-\d{2}$/.test(String(split.period_label))
      const dsAnchor = periodLabelIsRealDate
        ? new Date(split.period_label)
        : (isScheduleSourced
          ? new Date(amortRow.row_date)
          : (priorStmt?.payment_due_date ? new Date(priorStmt.payment_due_date) : new Date(priorStmt?.statement_date || stmt.statement_date)))
      const dsResult = await findDirectSplitCandidate(headers, loanAcct, split, dsAnchor, bank_transaction_id)
      // 'reconciled_cannot_edit' is deliberately excluded from the hard-error set: the
      // operator's pick was correct, only the mechanism is unavailable. It degrades to
      // a Manual Journal below (identical GL outcome) instead of erroring.
      if (bank_transaction_id && dsResult.reason !== 'ok' && dsResult.reason !== 'reconciled_cannot_edit') {
        return new Response(JSON.stringify({
          error: dsResult.errorMessage,
          bank_transaction: dsResult.errorDetail,
        }), { status: dsResult.errorStatus || 409 })
      }
      if (dsResult.reason === 'reconciled_cannot_edit' && dsResult.candidate) {
        identifiedBankTxnId = dsResult.candidate.BankTransactionID
        directSplitSkipped = {
          reason: 'reconciled_cannot_edit',
          bank_transaction_id: dsResult.candidate.BankTransactionID,
          bank_transaction_date: dsResult.candidate.DateString?.slice(0, 10),
          explanation: `This payment is already reconciled against a bank statement in Xero, and Xero does not allow a reconciled bank transaction's line items to be edited. Posting a separate Manual Journal instead -- the resulting balances on ${loanAcct.xero_account_name} and Interest Expense are identical, it is just recorded as two documents rather than one split transaction.`,
        }
      }
      const directSplitAttempt: Record<string, any> = {
        attempted: true,
        reason: dsResult.reason,
        candidate_count: dsResult.candidates?.length ?? (dsResult.candidate ? 1 : 0),
      }
      // v29: `reason === 'ok'` is now required, not just a non-null candidate --
      // 'reconciled_cannot_edit' also returns a candidate, but attempting the Update
      // for it is guaranteed to fail with a Xero ValidationException.
      if (dsResult.candidate && dsResult.reason === 'ok') {
        const originalTotal = Number(dsResult.candidate.Total)
        // Split amounts must sum EXACTLY to the original transaction total -- Xero
        // enforces this same rule server-side (confirmed live via David's hand-test in
        // the Xero UI, 2026-08-17: an unbalanced edit was rejected with "The invoice
        // total has changed. It must match the reconciled total"). Checked here first
        // so a bad match surfaces a clear reason instead of a raw Xero error later.
        const sumOk = Math.abs((principal + interest) - originalTotal) < ZERO_TOLERANCE
        if (sumOk) {
          const originalLine = (dsResult.candidate.LineItems || [])[0]
          const originalTaxType = originalLine?.TaxType || 'NONE'
          const proposedLineItems = [
            {
              AccountCode: loanAcct.xero_account_code,
              AccountName: acctMap[loanAcct.xero_account_code] ?? null,
              Description: originalLine?.Description || `${loanAcct.xero_account_name} principal`,
              LineAmount: principal,
            },
            {
              AccountCode: INTEREST_EXPENSE_ACCOUNT_CODE,
              AccountName: acctMap[INTEREST_EXPENSE_ACCOUNT_CODE] ?? null,
              Description: 'Interest',
              LineAmount: interest,
            },
          ]
          if (!confirm) {
            return new Response(JSON.stringify({
              dry_run: true,
              source: split.source,
              kind: 'direct_split',
              matched_bank_transaction: {
                id: dsResult.candidate.BankTransactionID,
                date: dsResult.candidate.DateString,
                total: originalTotal,
                status: dsResult.candidate.Status,
                reconciled: dsResult.candidate.IsReconciled,
                current_lines: withAccountNames(dsResult.candidate.LineItems, acctMap),
              },
              proposed_split: proposedLineItems,
              direct_split_match: directSplitAttempt,
              split,
              note: `Direct Transaction Split: this would split the ${loanAcct.xero_account_name} bank transaction dated ${dsResult.candidate.DateString?.slice(0, 10)} for $${originalTotal.toFixed(2)} into $${principal.toFixed(2)} principal / $${interest.toFixed(2)} interest, in place -- no separate Manual Journal.`,
            }, null, 2), { headers: { 'Content-Type': 'application/json' } })
          }

          // confirm === true: actually perform the split via Update BankTransaction.
          const updatePayload = {
            BankTransactions: [{
              BankTransactionID: dsResult.candidate.BankTransactionID,
              Type: dsResult.candidate.Type,
              Contact: dsResult.candidate.Contact,
              BankAccount: dsResult.candidate.BankAccount,
              Date: dsResult.candidate.DateString?.slice(0, 10),
              Reference: dsResult.candidate.Reference,
              LineAmountTypes: dsResult.candidate.LineAmountTypes,
              Status: dsResult.candidate.Status,
              LineItems: [
                { Description: proposedLineItems[0].Description, Quantity: 1, LineAmount: principal, AccountCode: loanAcct.xero_account_code, TaxType: originalTaxType },
                { Description: 'Interest', Quantity: 1, LineAmount: interest, AccountCode: INTEREST_EXPENSE_ACCOUNT_CODE, TaxType: originalTaxType },
              ],
            }],
          }
          const updRes = await fetch('https://api.xero.com/api.xro/2.0/BankTransactions', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(updatePayload),
          })
          const updJson = await updRes.json().catch(() => null)
          const updateFailed = !updRes.ok || updJson?.Elements?.[0]?.ValidationErrors?.length
          if (!updateFailed) {
            const { error: dsUpdateErr } = await supa
              .from('loan_splits')
              .update({
                matched_xero_bank_transaction_id: dsResult.candidate.BankTransactionID,
                posting_method: 'direct_split',
                pre_split_line_items_snapshot: dsResult.candidate.LineItems,
                xero_manual_journal_id: null,
                xero_posted_at: new Date().toISOString(),
                xero_posted_by: posted_by ?? null,
                status: 'posted',
              })
              .eq('id', loan_split_id)
            const flagAutoResolveDS = await maybeAutoResolveFlag(supa, loanAcct)
            return new Response(JSON.stringify({
              ok: true,
              kind: 'direct_split',
              bank_transaction: { id: dsResult.candidate.BankTransactionID, note: 'split in place -- original line items snapshotted for revert' },
              new_lines: withAccountNames(updJson?.BankTransactions?.[0]?.LineItems, acctMap),
              loan_splits_update_error: dsUpdateErr?.message,
              flag_auto_resolve: flagAutoResolveDS,
            }, null, 2), { headers: { 'Content-Type': 'application/json' } })
          }
          // Update call failed -- fall through to the manual-journal path below,
          // exactly as if direct_split_enabled were false for this call. Nothing in
          // the database was touched (no update ran), so this is a clean fallback.
        }
      }
      // Falls through to the existing manual-journal search below on no_match,
      // ambiguous_tie, already_split, sum_mismatch, or a failed Update call.
    }

    // --- Find the matching bank transaction (for reference/date/attachment -- it is
    //     never edited, only read) ---
    let candidate: any = null
    let candidates: any[] = []
    // Count of amount+account matches rejected purely because they are DELETED/VOIDED.
    // Surfaced in the not-found response so "no match" never silently hides the fact
    // that a deleted duplicate exists on that date -- that ambiguity is the whole
    // reason this filter was added (see v18 note).
    let suppressedNonLive = 0

    // Anchor date used for operator-facing date warnings and candidate distances.
    // Same rule the direct-split path uses: a real ISO period_label wins, otherwise the
    // same fallback the manual-journal candidate search below anchors on.
    const warnAnchor = /^\d{4}-\d{2}-\d{2}$/.test(String(split.period_label))
      ? new Date(split.period_label)
      : (isScheduleSourced
        ? new Date(amortRow.row_date)
        : (priorStmt?.payment_due_date ? new Date(priorStmt.payment_due_date) : new Date(priorStmt?.statement_date || stmt.statement_date)))
    // Non-blocking: set when an explicitly-picked transaction sits further from the
    // split's period than the direct-split window allows. Reported, never enforced.
    let pickedDateWarning: string | null = null

    // v29: an operator's explicit pick still wins, but when the direct-split matcher
    // already positively identified the transaction (and only declined because it is
    // reconciled), reuse that identification rather than re-searching. Without this, a
    // loan with a fixed repeating payment amount -- Rapid's $2,068.89 every week -- is
    // permanently ambiguous in the wider -15/+3 window below and can never post.
    const effectiveBankTxnId: string | null = bank_transaction_id || identifiedBankTxnId

    if (effectiveBankTxnId) {
      const r = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions/${effectiveBankTxnId}`, { headers })
      const j = await r.json().catch(() => null)
      candidate = j?.BankTransactions?.[0] || null
      if (!candidate) return new Response(JSON.stringify({ error: `Bank transaction ${effectiveBankTxnId} not found in Xero`, status: r.status }), { status: 404 })
      if (!isLiveBankTxn(candidate)) {
        return new Response(JSON.stringify({
          error: `Bank transaction ${effectiveBankTxnId} has Xero status ${candidate.Status} -- it is not a live transaction and must not be posted against. If there is an identical AUTHORISED transaction on or near this date, pass that one's ID instead.`,
          bank_transaction: { id: candidate.BankTransactionID, date: candidate.DateString, total: candidate.Total, status: candidate.Status },
        }), { status: 409 })
      }
      // Amount and bank account are HARD rejects; the date distance below is only a
      // warning. A genuinely late payment can legitimately sit outside the matching
      // window, so a deliberate operator pick must not be blocked on date alone -- but a
      // different amount, or a transaction on a different bank account, is categorically
      // not this split's payment and posting against it would put wrong numbers in the
      // ledger. Those two can never be waved through.
      if (Math.abs(Number(candidate.Total) - Number(split.total_amount)) >= 0.02) {
        return new Response(JSON.stringify({
          error: `Bank transaction ${effectiveBankTxnId} is $${Number(candidate.Total).toFixed(2)} but this split is $${Number(split.total_amount).toFixed(2)}. Refusing to post a split against a transaction of a different amount.`,
          bank_transaction: { id: candidate.BankTransactionID, date: candidate.DateString, total: candidate.Total, status: candidate.Status },
        }), { status: 409 })
      }
      if (candidate.BankAccount?.AccountID?.toLowerCase() !== loanAcct.xero_bank_account_id?.toLowerCase()) {
        return new Response(JSON.stringify({
          error: `Bank transaction ${effectiveBankTxnId} is not on this loan's bank account. Refusing to post a split against a transaction from a different bank account.`,
          bank_transaction: { id: candidate.BankTransactionID, date: candidate.DateString, total: candidate.Total, status: candidate.Status, bank_account_id: candidate.BankAccount?.AccountID },
        }), { status: 409 })
      }
      const pickedDistDays = candidate.DateString ? wholeDaysBetween(new Date(candidate.DateString), warnAnchor) : null
      // v29: only meaningful for a real operator pick. An auto-identified candidate came
      // from the tight +/-2-day matcher, so it can never exceed the window anyway.
      pickedDateWarning = (bank_transaction_id && pickedDistDays !== null && pickedDistDays > DIRECT_SPLIT_WINDOW_DAYS)
        ? `The transaction you picked is dated ${candidate.DateString.slice(0, 10)}, which is ${pickedDistDays} day${pickedDistDays === 1 ? '' : 's'} from this split's period (${isoDay(warnAnchor)}). Check this is the right payment.`
        : null
    } else {
      // Statement-sourced: the balance delta reflects a payment made sometime around the
      // PRIOR statement's due date (the current statement's due date is the *next* upcoming
      // payment). Schedule-sourced: anchor directly on the matched amortization row's date.
      const anchor = isScheduleSourced
        ? new Date(amortRow.row_date)
        : (priorStmt?.payment_due_date ? new Date(priorStmt.payment_due_date) : new Date(priorStmt?.statement_date || stmt.statement_date))
      const from = new Date(anchor); from.setDate(from.getDate() - 15)
      const to = new Date(isScheduleSourced ? amortRow.row_date : stmt.statement_date); to.setDate(to.getDate() + 3)
      const fmt = (d: Date) => `${d.getFullYear()},${d.getMonth() + 1},${d.getDate()}`
      const whereClause = `Date >= DateTime(${fmt(from)}) && Date <= DateTime(${fmt(to)})`
      let list: any[] = []
      const r1 = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions?where=${encodeURIComponent(whereClause)}&order=Date DESC`, { headers })
      if (r1.ok) {
        const j1 = await r1.json()
        list = j1.BankTransactions || []
      } else {
        // Fallback: fetch recent pages unfiltered and filter client-side (the `where` clause
        // has been unreliable against this Xero org for other report/list endpoints).
        for (let page = 1; page <= 4; page++) {
          const rp = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions?page=${page}&order=Date DESC`, { headers })
          if (!rp.ok) break
          const jp = await rp.json()
          const batch = jp.BankTransactions || []
          if (!batch.length) break
          list.push(...batch)
          const oldest = batch[batch.length - 1]?.DateString ? new Date(batch[batch.length - 1].DateString) : null
          if (oldest && oldest < from) break
        }
        list = list.filter(t => {
          const d = t.DateString ? new Date(t.DateString) : null
          return d && d >= from && d <= to
        })
      }

      const target = Number(split.total_amount)
      const amountAndAccountMatch = (t: any) =>
        t.BankAccount?.AccountID?.toLowerCase() === loanAcct.xero_bank_account_id.toLowerCase() &&
        Math.abs(Number(t.Total) - target) < 0.02
      // Status guard applies here, not just in the fallback path -- both the `where`
      // branch and the paging branch feed this same filter.
      candidates = list.filter(t => isLiveBankTxn(t) && amountAndAccountMatch(t))
      suppressedNonLive = list.filter(t => !isLiveBankTxn(t) && amountAndAccountMatch(t)).length
      if (candidates.length === 1) {
        // The list endpoint omits LineItems -- fetch full detail for accurate review/posting.
        const detailRes = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions/${candidates[0].BankTransactionID}`, { headers })
        const detailJson = await detailRes.json().catch(() => null)
        candidate = detailJson?.BankTransactions?.[0] || candidates[0]
      }
    }

    if (!candidate) {
      // Zero candidates is two very different situations. A statement dated within the
      // last few days whose payment simply has not synced from the bank feed yet is the
      // EXPECTED case and must not be reported as a fault; an older statement with no
      // match is a real problem worth looking at. `reason` lets the client tell them
      // apart; the HTTP status codes are deliberately unchanged so callers don't break.
      const notFoundRefDate = isScheduleSourced ? amortRow.row_date : (stmt.payment_due_date || stmt.statement_date)
      const daysFromToday = notFoundRefDate ? Math.round((Date.now() - new Date(notFoundRefDate).getTime()) / 86400000) : null
      const statementIsRecent = daysFromToday !== null && Math.abs(daysFromToday) <= 5
      const notFoundReason = candidates.length > 1
        ? 'ambiguous_candidates'
        : (statementIsRecent ? 'payment_not_yet_in_xero' : 'no_matching_transaction')
      const feedLabel = loanAcct.xero_account_name ? `the ${loanAcct.xero_account_name} feed` : 'the bank feed'
      return new Response(JSON.stringify({
        reason: notFoundReason,
        error: notFoundReason === 'ambiguous_candidates'
          ? `${candidates.length} live bank transactions matched the amount ($${split.total_amount}) in the date window -- pass bank_transaction_id to pick the right one.`
          : (notFoundReason === 'payment_not_yet_in_xero'
            ? `The $${split.total_amount} payment for ${notFoundRefDate} hasn't appeared on ${feedLabel} in Xero yet. That's normal this soon after the statement date -- it will match itself once the bank feed syncs. Nothing to do right now.`
            : `No live bank transaction found on ${feedLabel} matching $${split.total_amount} near ${notFoundRefDate}. It may not have cleared/synced yet, or the payment amount doesn't match.`),
        anchor_date: isoDay(warnAnchor),
        candidates: candidates.map(c => ({ id: c.BankTransactionID, date: c.DateString, total: c.Total, reference: c.Reference, contact: c.Contact?.Name, days_from_period: c.DateString ? wholeDaysBetween(new Date(c.DateString), warnAnchor) : null })),
        ignored_deleted_or_voided: suppressedNonLive,
        ignored_note: suppressedNonLive
          ? `${suppressedNonLive} transaction(s) matched the amount and account but are DELETED or VOIDED in Xero, so they were ignored. A deleted draft alongside a live payment is normal -- it is not a second payment.`
          : undefined,
      }), { status: candidates.length > 1 ? 409 : 404 })
    }

    // --- Build the reallocation journal plan ---
    const journalPayload = {
      ManualJournals: [{
        Narration: `${loanAcct.xero_account_name} — interest reallocation, ${split.period_label}`,
        Date: candidate.DateString?.slice(0, 10),
        Status: 'POSTED',
        JournalLines: [
          { LineAmount: interest, AccountCode: INTEREST_EXPENSE_ACCOUNT_CODE, Description: `Interest`, TaxType: 'NONE' },
          { LineAmount: -interest, AccountCode: loanAcct.xero_account_code, Description: `${loanAcct.xero_account_name} principal correction`, TaxType: 'NONE' },
        ],
      }],
    }

    if (!confirm) {
      return new Response(JSON.stringify({
        dry_run: true,
        source: split.source,
        matched_bank_transaction: { id: candidate.BankTransactionID, date: candidate.DateString, total: candidate.Total, status: candidate.Status, current_lines: withAccountNames(candidate.LineItems, acctMap), reconciled: candidate.IsReconciled },
        ignored_deleted_or_voided: suppressedNonLive,
        picked_date_warning: pickedDateWarning,
        direct_split_skipped: directSplitSkipped,
        proposed_journal: { ...journalPayload.ManualJournals[0], JournalLines: withAccountNames(journalPayload.ManualJournals[0].JournalLines, acctMap) },
        split,
        note: directSplitSkipped
          ? directSplitSkipped.explanation
          : isScheduleSourced
          ? 'Schedule-sourced split -- no per-period statement file to attach; the full amortization schedule is already the permanent record in Storage from ingestion.'
          : (candidate.IsReconciled
            ? 'This bank transaction is reconciled -- it will be left untouched. A separate Manual Journal (shown above) reallocates the interest amount instead.'
            : 'This bank transaction is not yet reconciled, but a Manual Journal is still used (simpler, one code path, works either way) rather than editing its line items.'),
      }, null, 2), { headers: { 'Content-Type': 'application/json' } })
    }

    // --- Post the reallocation journal to Xero ---
    const postRes = await fetch('https://api.xero.com/api.xro/2.0/ManualJournals', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(journalPayload),
    })
    const postJson = await postRes.json().catch(() => null)
    if (!postRes.ok || postJson?.Elements?.[0]?.ValidationErrors?.length) {
      return new Response(JSON.stringify({ error: 'Xero journal post failed', status: postRes.status, details: postJson }), { status: 502 })
    }
    const journal = postJson.ManualJournals?.[0]

    // --- Attach the source statement as a permanent proof record ---
    const attachmentResult = await attachStatementToJournal(
      supa, token, tenantId, stmt, journal?.ManualJournalID,
      isScheduleSourced ? SCHEDULE_SOURCED_SKIP : undefined,
    )

    // --- Mark the split as posted ---
    const { error: updateErr } = await supa
      .from('loan_splits')
      .update({
        matched_xero_bank_transaction_id: candidate.BankTransactionID,
        xero_manual_journal_id: journal?.ManualJournalID ?? null,
        xero_posted_at: new Date().toISOString(),
        xero_posted_by: posted_by ?? null,
        status: 'posted',
      })
      .eq('id', loan_split_id)

    const flagAutoResolve3 = await maybeAutoResolveFlag(supa, loanAcct)
    return new Response(JSON.stringify({
      ok: true,
      original_bank_transaction: { id: candidate.BankTransactionID, note: 'left untouched, not edited' },
      picked_date_warning: pickedDateWarning,
      direct_split_skipped: directSplitSkipped,
      manual_journal: { id: journal?.ManualJournalID, lines: withAccountNames(journal?.JournalLines, acctMap) },
      attachment: attachmentResult,
      loan_splits_update_error: updateErr?.message,
      flag_auto_resolve: flagAutoResolve3,
    }, null, 2), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message || err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const res = await handleRequest(req)
  const mergedHeaders = new Headers(res.headers)
  for (const [k, v] of Object.entries(cors)) mergedHeaders.set(k, v)
  if (!mergedHeaders.has('Content-Type')) mergedHeaders.set('Content-Type', 'application/json')
  return new Response(res.body, { status: res.status, headers: mergedHeaders })
})
