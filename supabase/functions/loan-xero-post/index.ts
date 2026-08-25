import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { getXeroAuth } from '../_shared/xero-auth.ts'
import { ensureUpcomingSplit } from '../_shared/staging-next.ts'

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
// Body: { loan_split_id: string, confirm?: boolean, revert?: boolean, bank_transaction_id?: string, posted_by?: string, attach_only?: boolean }
// attach_only=true attaches the source statement to an ALREADY-posted journal and does
// nothing else -- no journal is created, no database row is written. See its branch below.
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
// payment is 100% principal and gets NO Xero write at all, and the lender's interest charge
// posts as its own journal dated the day the fee was charged. One document per week,
// and it reads as a finance charge rather than a correction to a payment.

// v30 (session 222, 2026-08-19): WORDING, first pass. The fee/reclass journal is what
// David now sees in Xero every week for Rapid (direct_split_enabled was turned off in the
// same change -- see PROJECT-NOTES-BOOKKEEPING.md item 10), so its wording matters. It
// said "<Loan> reclass" / "Interest reclass" / "<Loan> reclass", which reads like someone
// fixing a mistake. It is not a correction: it books a charge on the date the lender
// charged it. Renamed to "<Loan> - balance fee, <date>" / "Interest" / "Balance fee".
//
// SUPERSEDED later the same session -- see the comment at the journal payload itself.
// "Balance fee" adopted Rapid's own framing without testing it. The numbers say the
// charge is interest on a declining balance, so the wording is now "interest". Design
// doc constraint C11. Still no change to accounts, amounts, dates, signs, or any
// posting logic -- every wording change in this function has been narration-only.

// v41 (session 226, 2026-08-21): TIER 1 PRE-STAGING (DESIGN-LOAN-POSTING-MODEL.md §4).
// The inversion David asked for on 2026-08-19 ("Park it. Reuse the function for the trx
// 'pre-split'"): instead of trying to edit a bank transaction that already exists
// (impossible once reconciled -- C1+C4), CREATE the transaction ourselves, already
// split into principal/interest from the loan's amortization schedule, BEFORE the
// payment arrives in the bank feed. When the statement line lands, Xero's reconcile
// screen offers our transaction as a Match and the CPA clicks once -- one clean
// two-line transaction, no Manual Journal at all. Only for loans with
// loan_accounts.prestage_enabled = true (Verdant / PCV / Dexter today -- the three
// with forward schedules on file).
//
// Four new body shapes, all keyed on an existing loan_splits row except the sweep:
//   { loan_split_id, stage: true, confirm?: bool }  -- preview, then create the
//     pre-split SPEND transaction in Xero and mark the split status='staged',
//     posting_method='pre_staged'. Guards: prestage_enabled; schedule-sourced split
//     with a linked amortization row; row_date today-or-future (Pacific) -- a past
//     period belongs to the normal review/approve flow; principal+interest must equal
//     total to the half-cent; interest > 0 (a 100%-principal payment needs no
//     pre-split -- the feed line is already correctly coded, Tier 3). Never-stage-twice:
//     refuses if a live Xero transaction already carries this stage's Reference, or if
//     a live same-amount transaction already sits on the loan's bank account within
//     +/-STAGE_DUP_WINDOW_DAYS of the payment date (the payment already happened).
//     The DB backstop is the partial unique index loan_splits_one_stage_per_amort_row.
//   { loan_split_id, unstage: true }  -- deletes the staged transaction in Xero
//     (Status DELETED -- proven safe on unreconciled transactions, C2) and returns the
//     split to pending_review. Refuses if the transaction has meanwhile been reconciled
//     (that means it MATCHED -- run the sweep instead). This is also the bail-out for
//     the live proof: if anything looks wrong, one call removes the stage cleanly.
//   { loan_split_id }  (dry run on a staged split) -- returns kind:'staged' with the
//     live Xero state of the staged transaction instead of running the normal
//     candidate search. confirm/mark on a staged split is a 409: the split's next
//     transition comes from the bank feed (match) or from unstage, never from Approve.
//   { sweep_stages: true }  -- no loan_split_id. Walks every status='staged' split:
//     reconciled -> status 'posted' (the match happened; xero_posted_at stamped);
//     transaction deleted/voided in Xero by hand -> back to 'pending_review';
//     a second live same-amount transaction near the stage -> stage_sweep_flag
//     'duplicate_suspected' (the CPA clicked Create instead of Match -- the exact
//     danger the design doc names); past due + grace with no match ->
//     stage_sweep_flag 'stale'. The sweep FLAGS stale stages but never deletes them
//     on its own -- deleting a stage is unstage, a human action, until pre-staging
//     has earned enough trust to automate that (deliberate v41 scope choice).
//     Callable by admin/manager, or by pg_cron presenting the service-role key.
//
// The staged transaction's Reference is stable and greppable: "WR-STAGE <code> <date>"
// -- it is how the sweep, the duplicate check, and any human in Xero recognize a
// product-created stage. The write reuses the v26 discipline: Xero confirmed first,
// database second, and a DB failure after a successful Xero write is a LOUD error
// carrying the transaction id, never a silent inconsistency.
//
// v42 (session 226, same day): two hardening fixes from the QA pass. (1) A split
// carrying an xero_manual_journal_id while NOT status='posted' now hard-409s on
// confirm -- that shape means the row was regenerated over an already-posted period
// (loan-generate-schedule-split's upsert resets status without clearing the posting
// fields), and posting it would duplicate the journal. (2) maybeAutoResolveFlag
// counts 'staged' splits as still-outstanding, so a "waiting on posting" loan flag
// can no longer auto-resolve while a pre-staged transaction is still unmatched.
//
// v43 (session 226, same day): Staging Engine continuation. When the sweep confirms a
// staged transaction MATCHED (reconciled -> status 'posted'), it now also creates the
// NEXT period's pending_review split for that loan via ensureUpcomingSplit
// (_shared/staging-next.ts -- same helper loan-ingest-amortization's post-ingest hook
// uses), so the CPA's next "ready to stage" card appears the moment the previous
// payment clears. DB-only write; Xero staging still requires the human Stage click.
// One active card per loan is enforced inside the helper.
//
// v47 (session 226 close, 2026-08-22): the wrong-line match guard, from a live near
// miss. Xero's reconcile screen suggested matching the PayPal 2 stage (WR-STAGE 284
// 2026-08-26) against the 8/20 bank line -- the PREVIOUS week's draft, identical
// amount. Two defenses: (1) the sweep treats a stage reconciled 2+ days before its
// scheduled date as 'matched_early_suspect' -- flags it with unmatch-and-recode
// instructions, never posts it, never creates the next card (UpdatedDateUTC bounds
// the reconcile time, so this works even when the sweep runs late); (2) the stage
// preview carries a backlog_warning when earlier scheduled payments from the same
// schedule have no processed split -- those unreconciled lines are exactly what
// attracts a wrong suggestion. Steady state (each card created only after the prior
// match) cannot hit this; the hazard is enabling staging over an unprocessed backlog.

const INTEREST_EXPENSE_ACCOUNT_CODE = '800'
const ZERO_TOLERANCE = 0.005 // dollars -- treat anything under half a cent as exactly zero
const DIRECT_SPLIT_WINDOW_DAYS = 2 // v24 -- David's call, tightened from an initial 3

// v41: pre-staging knobs.
const STAGE_REF_PREFIX = 'WR-STAGE'
const STAGE_DUP_WINDOW_DAYS = 5   // +/- days around the payment date for "payment already exists" / duplicate checks
const STAGE_STALE_GRACE_DAYS = 7  // days past the scheduled date before an unmatched stage is flagged stale
// v47: a match recorded 2+ days BEFORE the scheduled date is treated as suspect.
// Drafts initiate ON the scheduled date; a statement line can carry the prior
// day's date, so 1 day early is normal jitter. 2+ days early on a loan whose
// payments are all the same amount means the stage was almost certainly matched
// to an EARLIER payment's bank line (caught live on PayPal 2: Xero's reconcile
// screen suggested matching the 8/26 stage to the 8/20 line -- the 8/19 draft).
const STAGE_EARLY_MATCH_GRACE_DAYS = 2

// Xero's REST JSON serializes some timestamps as "/Date(1651152000000+0000)/"
// and others as ISO strings. Accept both; null when unparseable.
function xeroDateMs(v: any): number | null {
  if (!v) return null
  const m = String(v).match(/\/Date\((\d+)/)
  if (m) return Number(m[1])
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? t : null
}

// Same Pacific-day convention as the dashboard's balance code: a schedule row is
// "future" relative to today in America/Los_Angeles, not UTC.
const pacificToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date())

const stageReferenceFor = (loanAcct: any, rowDate: string) =>
  `${STAGE_REF_PREFIX} ${loanAcct.xero_account_code} ${rowDate}`

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
      // v42: 'staged' counts as still-outstanding — a pre-staged transaction is not
      // posted until the payment actually lands and matches, so a "waiting on
      // posting" flag must not auto-resolve while a stage is still open.
      .in('status', ['pending_review', 'needs_attention', 'staged'])
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

// v41: live same-amount transactions on the loan's bank account within +/-days of a
// date. Shared by the stage-time "payment already exists" check and the sweep's
// duplicate detection -- one implementation so the two checks can never disagree about
// what counts as a duplicate. AUTHORISED only (isLiveBankTxn); the staged transaction
// itself is excluded via excludeId.
async function findSameAmountTxns(
  headers: Record<string, string>,
  bankAccountId: string,
  amount: number,
  centerDate: Date,
  days: number,
  excludeId?: string,
): Promise<{ ok: boolean; error?: string; matches: any[] }> {
  const from = new Date(centerDate); from.setDate(from.getDate() - days)
  const to = new Date(centerDate); to.setDate(to.getDate() + days)
  const fmt = (d: Date) => `${d.getFullYear()},${d.getMonth() + 1},${d.getDate()}`
  const whereClause = `Date >= DateTime(${fmt(from)}) && Date <= DateTime(${fmt(to)})`
  const r = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions?where=${encodeURIComponent(whereClause)}&order=Date DESC`, { headers })
  if (!r.ok) return { ok: false, error: `Xero BankTransactions query failed: ${r.status}`, matches: [] }
  const j = await r.json().catch(() => null)
  const matches = (j?.BankTransactions || []).filter((t: any) =>
    isLiveBankTxn(t) &&
    t.BankAccount?.AccountID?.toLowerCase() === bankAccountId.toLowerCase() &&
    Math.abs(Number(t.Total) - amount) < 0.02 &&
    (!excludeId || t.BankTransactionID !== excludeId))
  return { ok: true, matches }
}

// v41: the stage sweep. Walks every status='staged' split and reads what actually
// happened in Xero since staging. Writes ONLY to our own loan_splits rows -- the one
// Xero-facing thing it never does is delete a stage (that is unstage, a human action).
// See the v41 version note at the top for the full outcome table.
// The shared secret pg_cron presents. Every scheduled HTTP job in this project posts
// the ANON key in its Authorization header, never the service-role key -- the database
// has no way to hold that key safely, and putting it in cron.job.command would expose
// it to anyone who can read the table. So an internally-called function authenticates
// on x-wr-internal instead (migration session_227h_internal_call_secret; the same
// mechanism charge-order / send-email / bookkeeping-kpis already use).
//
// This mattered here: handleStageSweep accepted ONLY the service-role key or an
// admin/manager JWT, so the obvious cron -- posting the anon key like every other job
// -- would have been refused 403 with nothing surfacing anywhere. That is the session
// 227 failure exactly: customer SMS broke silently for the same reason.
async function isInternalCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-wr-internal') || ''
  if (!provided) return false
  try {
    const c = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data } = await c.from('wr_internal_auth').select('secret').maybeSingle()
    return !!data?.secret && provided === data.secret
  } catch (_) {
    return false
  }
}

async function handleStageSweep(req: Request): Promise<Response> {
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  const isService = !!bearer && bearer === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!isService && !(await isInternalCall(req))) {
    const role = await callerRole(req)
    if (!role || !['admin', 'manager'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Sweeping staged transactions requires an admin or manager account.' }), { status: 403 })
    }
  }
  const supa = admin()
  const { data: staged, error: stagedErr } = await supa
    .from('loan_splits')
    .select('*, loan_accounts(*), amortization_row:loan_amortization_rows(*)')
    .eq('status', 'staged')
  if (stagedErr) {
    return new Response(JSON.stringify({ error: 'Could not load staged splits', details: stagedErr.message }), { status: 500 })
  }
  if (!staged?.length) {
    return new Response(JSON.stringify({ ok: true, checked: 0, results: [] }), { headers: { 'Content-Type': 'application/json' } })
  }
  const { headers } = await getXeroAuth()
  const today = pacificToday()
  const nowIso = () => new Date().toISOString()
  const appendNote = (s: any, note: string) => (s.review_notes ? s.review_notes + ' -- ' : '') + note
  const results: any[] = []
  for (const s of staged) {
    const la = s.loan_accounts
    const txnId = s.matched_xero_bank_transaction_id
    const row: any = { loan_split_id: s.id, loan: la?.xero_account_name || la?.lender, period: s.period_label }
    if (!la?.xero_bank_account_id || !txnId) {
      // A staged split with no transaction id is a record inconsistency, not a Xero
      // state -- return it to review loudly rather than leaving it invisible.
      await supa.from('loan_splits').update({
        status: 'pending_review', posting_method: 'manual_journal',
        matched_xero_bank_transaction_id: null, stage_sweep_flag: null,
        stage_sweep_checked_at: nowIso(),
        review_notes: appendNote(s, `Stage record was missing its Xero transaction id -- returned to review by the sweep on ${today}.`),
      }).eq('id', s.id)
      row.outcome = 'record_inconsistent_returned_to_review'
      results.push(row); continue
    }
    const r = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions/${txnId}`, { headers })
    const j = await r.json().catch(() => null)
    const txn = j?.BankTransactions?.[0]
    if (!r.ok || !txn) {
      await supa.from('loan_splits').update({ stage_sweep_checked_at: nowIso() }).eq('id', s.id)
      row.outcome = 'xero_fetch_failed'; row.status = r.status
      results.push(row); continue
    }
    if (txn.Status !== 'AUTHORISED') {
      // Someone deleted or voided the stage in Xero directly. Respect that -- the
      // split goes back to the normal review flow.
      await supa.from('loan_splits').update({
        status: 'pending_review', posting_method: 'manual_journal',
        matched_xero_bank_transaction_id: null, stage_reference: null, staged_at: null,
        stage_sweep_flag: null, stage_sweep_checked_at: nowIso(),
        review_notes: appendNote(s, `Staged transaction was ${txn.Status} in Xero by hand -- returned to review by the sweep on ${today}.`),
      }).eq('id', s.id)
      row.outcome = 'stage_removed_in_xero'
      results.push(row); continue
    }
    if (txn.IsReconciled) {
      // v47: reconciled BEFORE the scheduled date = probably matched to the WRONG
      // bank line (see STAGE_EARLY_MATCH_GRACE_DAYS). UpdatedDateUTC bounds the
      // reconcile time from above: IsReconciled with an update stamp earlier than
      // the cutoff proves the match happened before the payment was even due.
      // Flag for a human; NEVER auto-post a suspect match, never create the next
      // card off it. Self-healing: once the line is unreconciled in Xero and coded
      // correctly, the next sweep sees an unmatched live stage and clears the flag.
      const schedDateStr = s.amortization_row?.row_date ? String(s.amortization_row.row_date).slice(0, 10) : null
      const updatedMs = xeroDateMs(txn.UpdatedDateUTC)
      const updatedDay = updatedMs != null ? new Date(updatedMs).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }) : null
      if (schedDateStr && updatedDay) {
        const cut = new Date(schedDateStr + 'T00:00:00Z'); cut.setUTCDate(cut.getUTCDate() - STAGE_EARLY_MATCH_GRACE_DAYS)
        const earlyCutoff = cut.toISOString().slice(0, 10)
        if (updatedDay < earlyCutoff) {
          await supa.from('loan_splits').update({
            stage_sweep_flag: 'matched_early_suspect', stage_sweep_checked_at: nowIso(),
          }).eq('id', s.id)
          row.outcome = 'matched_early_suspect'
          row.detail = `The staged transaction shows as matched in Xero, but the match was recorded by ${updatedDay} -- before its scheduled payment date (${schedDateStr}). On a loan where every payment is the same amount, that almost certainly means it was matched to an EARLIER payment's bank line. In Xero: unreconcile that statement line and code it the normal way; the staged transaction then goes back to waiting for its own payment. Nothing was posted here and no next period was created.`
          results.push(row); continue
        }
      }
      // The payment arrived and a human clicked Match. This is the whole point.
      await supa.from('loan_splits').update({
        status: 'posted',
        xero_posted_at: nowIso(),
        stage_sweep_flag: null, stage_sweep_checked_at: nowIso(),
        review_notes: appendNote(s, `Pre-staged transaction matched against the bank feed (confirmed reconciled in Xero, sweep of ${today}).`),
      }).eq('id', s.id)
      const flagAutoResolve = await maybeAutoResolveFlag(supa, la)
      row.outcome = 'matched'; row.flag_auto_resolve = flagAutoResolve
      // v43: the match consumed this loan's card -- put the next period's card up.
      if (la?.prestage_enabled) {
        row.next_period = await ensureUpcomingSplit(supa, s.loan_account_id)
      }
      results.push(row); continue
    }
    // Still live and unmatched: look for trouble.
    const stageDate = new Date(txn.DateString?.slice(0, 10) || s.amortization_row?.row_date || today)
    const dup = await findSameAmountTxns(headers, la.xero_bank_account_id, Number(s.total_amount), stageDate, STAGE_DUP_WINDOW_DAYS, txnId)
    if (dup.ok && dup.matches.length) {
      const list = dup.matches.map((t: any) => `${t.DateString?.slice(0, 10)} $${Number(t.Total).toFixed(2)} (${t.BankTransactionID})`).join('; ')
      await supa.from('loan_splits').update({
        stage_sweep_flag: 'duplicate_suspected', stage_sweep_checked_at: nowIso(),
      }).eq('id', s.id)
      row.outcome = 'duplicate_suspected'
      row.detail = `The pre-staged transaction is still unmatched, but ${dup.matches.length} other live transaction(s) of the same amount sit on this loan account nearby: ${list}. Most likely someone clicked Create instead of Match on the reconcile screen -- if so, the created duplicate should be removed in Xero and the statement line matched to the staged transaction, or the stage removed here.`
      results.push(row); continue
    }
    const rowDate = s.amortization_row?.row_date ? String(s.amortization_row.row_date).slice(0, 10) : txn.DateString?.slice(0, 10)
    const staleAfter = new Date(rowDate); staleAfter.setDate(staleAfter.getDate() + STAGE_STALE_GRACE_DAYS)
    const isStale = today > staleAfter.toISOString().slice(0, 10)
    await supa.from('loan_splits').update({
      stage_sweep_flag: isStale ? 'stale' : null, stage_sweep_checked_at: nowIso(),
    }).eq('id', s.id)
    row.outcome = isStale ? 'stale' : 'waiting'
    if (isStale) row.detail = `Scheduled for ${rowDate} and still unmatched ${STAGE_STALE_GRACE_DAYS}+ days later. The real payment may have differed from the schedule (rate change, extra payment, skipped month). Check the bank feed; if the payment isn't coming in this shape, remove the stage.`
    results.push(row)
  }
  return new Response(JSON.stringify({
    ok: true,
    checked: staged.length,
    matched: results.filter(x => x.outcome === 'matched').length,
    flagged: results.filter(x => ['duplicate_suspected', 'stale', 'matched_early_suspect'].includes(x.outcome)).length,
    results,
  }, null, 2), { headers: { 'Content-Type': 'application/json' } })
}

async function handleRequest(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 })
    const body = await req.json().catch(() => ({}))
    const { loan_split_id, confirm, revert, bank_transaction_id, posted_by, attach_only, mark_already_in_xero, stage, unstage, sweep_stages } = body

    // v41: the sweep is the one mode not keyed on a single split -- it has its own
    // auth (admin/manager, or pg_cron with the service-role key) and returns early.
    if (sweep_stages) return await handleStageSweep(req)
    if (!loan_split_id) return new Response(JSON.stringify({ error: 'loan_split_id is required' }), { status: 400 })

    const role = await callerRole(req)
    if (!role || !['admin', 'manager', 'cpa'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Not authorized.' }), { status: 403 })
    }
    if ((confirm || revert || attach_only || mark_already_in_xero || unstage) && !['admin', 'manager'].includes(role)) {
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

    // attach_only is exempt: it exists precisely to repair an ALREADY-posted split's
    // attachment, so this guard would otherwise make it unreachable. Its own branch
    // below enforces the stricter requirement (an xero_manual_journal_id must exist).
    if (split.status === 'posted' && !attach_only) {
      return new Response(JSON.stringify({ error: 'This split is already posted to Xero.', matched_xero_bank_transaction_id: split.matched_xero_bank_transaction_id, xero_manual_journal_id: split.xero_manual_journal_id }), { status: 409 })
    }
    // v42: LAST LINE OF DEFENSE for the idempotency invariant. The 409 above keys on
    // status alone, but a split row can end up status='pending_review' while still
    // carrying a live journal id — e.g. loan-generate-schedule-split's upsert resets
    // status on regeneration without clearing the posting fields. Confirming a post
    // for such a row would create a DUPLICATE Xero journal. Refuse loudly; the revert
    // path (which clears the id) is the sanctioned way to make such a split postable.
    if (confirm && !attach_only && split.xero_manual_journal_id && split.status !== 'posted') {
      return new Response(JSON.stringify({
        error: `This split already carries Xero Manual Journal ${split.xero_manual_journal_id} even though its status is '${split.status}' — posting again would create a duplicate journal. This usually means the split row was regenerated over an already-posted period. Check the journal in Xero; if it should not exist, use revert; if it should, this row needs its status repaired, not a second post.`,
        xero_manual_journal_id: split.xero_manual_journal_id,
      }), { status: 409 })
    }
    // Session 224: 'already_in_xero' is the resolved state of the exception flow --
    // a human looked at the evidence and recorded that the month was handled
    // directly in Xero. Nothing further to do, ever.
    if (split.status === 'already_in_xero') {
      return new Response(JSON.stringify({ reason: 'already_marked', error: 'This split is already marked as handled in Xero -- nothing left to do here.', review_notes: split.review_notes }), { status: 409 })
    }
    if (mark_already_in_xero && bank_transaction_id) {
      return new Response(JSON.stringify({ error: 'mark_already_in_xero takes no bank_transaction_id -- the server re-verifies the already-handled state itself.' }), { status: 400 })
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

    // ── v48 (session 230): THE POSTING BOUNDARY FOR THE SPLIT INVARIANT ──────
    // Nothing arithmetically impossible reaches Xero from here -- not by approve,
    // not by stage, not by mark-already-in-xero, and not by preview either (a
    // preview of an impossible number is an invitation to click Approve).
    //
    // The rule itself lives in ONE place, the database function
    // split_invariant_check() (migration session_230_split_invariant), which the
    // BEFORE INSERT/UPDATE trigger on loan_splits also uses. This is a CALL to that
    // definition, never a second copy of it -- two implementations of one rule is
    // how this module has drifted before.
    //
    // Why the check must ALSO be here, and this early: the trigger REFUSES to
    // record an impossible split as posted/staged. If the refusal happened after
    // the Xero write, we would create a real journal in Xero and then fail to
    // record it -- an orphan. Checking before any Xero call is what makes the
    // trigger's guarantee safe rather than dangerous.
    //
    // Live at the time of writing: two Ford splits carrying negative interest
    // (E5-4751 and E6-7410, both 2026-06). Either would have posted on request.
    {
      const { data: invRes, error: invErr } = await supa.rpc('split_invariant_check', {
        p_principal: split.principal_amount,
        p_interest: split.interest_amount,
        p_total: split.total_amount,
      })
      // A failed RPC is not a licence to post -- if the invariant cannot be
      // evaluated, nothing is written to Xero.
      if (invErr) {
        return new Response(JSON.stringify({
          error: `Could not check this split before booking it: ${invErr.message}`,
          reason: 'split_invariant_unavailable',
        }), { status: 503 })
      }
      if (invRes && invRes.ok === false) {
        return new Response(JSON.stringify({
          error: `This split can't be booked: ${invRes.note}`,
          reason: 'split_invariant_violation',
          code: invRes.code,
          split: {
            period_label: split.period_label,
            principal_amount: split.principal_amount,
            interest_amount: split.interest_amount,
            total_amount: split.total_amount,
          },
        }), { status: 409 })
      }
    }

    // ==================== v41: TIER 1 PRE-STAGING LIFECYCLE ====================
    // Everything stage-related lives in this one block and always returns -- a
    // staged split must never fall through into the normal candidate-search /
    // journal-posting flow below (its next transition comes from the bank feed via
    // the sweep, or from an explicit unstage).
    if (stage || unstage || split.status === 'staged' || split.status === 'stage_expired') {
      const { headers: stHeaders } = await getXeroAuth()

      // --- unstage: delete the staged transaction in Xero, return the split to review ---
      if (unstage) {
        if (split.status !== 'staged' || !split.matched_xero_bank_transaction_id) {
          return new Response(JSON.stringify({ error: 'This split is not currently staged -- nothing to remove.' }), { status: 409 })
        }
        const dRes = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions/${split.matched_xero_bank_transaction_id}`, { headers: stHeaders })
        const dJson = await dRes.json().catch(() => null)
        const staged = dJson?.BankTransactions?.[0]
        if (!dRes.ok || !staged) {
          return new Response(JSON.stringify({ error: `Could not fetch the staged transaction from Xero to remove it (status ${dRes.status}). Nothing was changed.` }), { status: 502 })
        }
        if (staged.IsReconciled) {
          return new Response(JSON.stringify({ error: 'This staged transaction has already been MATCHED against the bank feed in Xero -- it is now a real reconciled payment and must not be deleted. Run the staged-payments check instead; it will mark this split posted.' }), { status: 409 })
        }
        if (staged.Status === 'AUTHORISED') {
          const delRes = await fetch('https://api.xero.com/api.xro/2.0/BankTransactions', {
            method: 'POST',
            headers: { ...stHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ BankTransactions: [{ BankTransactionID: split.matched_xero_bank_transaction_id, Status: 'DELETED' }] }),
          })
          const delJson = await delRes.json().catch(() => null)
          if (!delRes.ok || delJson?.Elements?.[0]?.ValidationErrors?.length) {
            return new Response(JSON.stringify({ error: 'Xero refused to delete the staged transaction -- the split was left staged.', details: delJson }), { status: 502 })
          }
        }
        const { error: unstageErr } = await supa
          .from('loan_splits')
          .update({
            status: 'pending_review',
            posting_method: 'manual_journal',
            matched_xero_bank_transaction_id: null,
            stage_reference: null, staged_at: null,
            stage_sweep_flag: null, stage_sweep_checked_at: null,
            review_notes: (split.review_notes ? split.review_notes + ' -- ' : '') + `Pre-staged transaction removed from Xero ${pacificToday()}${posted_by ? ' by ' + posted_by : ''}; split returned to review.`,
          })
          .eq('id', loan_split_id)
        return new Response(JSON.stringify({
          ok: true,
          unstaged: true,
          deleted_bank_transaction_id: split.matched_xero_bank_transaction_id,
          loan_splits_update_error: unstageErr?.message,
        }, null, 2), { headers: { 'Content-Type': 'application/json' } })
      }

      // --- dry run / stray confirm on an already-staged split: report, never repost ---
      if (split.status === 'staged' && !stage) {
        let liveState: any = null
        if (split.matched_xero_bank_transaction_id) {
          const lr = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions/${split.matched_xero_bank_transaction_id}`, { headers: stHeaders })
          const lj = await lr.json().catch(() => null)
          const lt = lj?.BankTransactions?.[0]
          if (lt) liveState = { id: lt.BankTransactionID, date: lt.DateString?.slice(0, 10), total: lt.Total, status: lt.Status, reconciled: lt.IsReconciled, reference: lt.Reference }
        }
        if (confirm || mark_already_in_xero) {
          return new Response(JSON.stringify({ error: 'This split is already staged in Xero as a pre-split transaction -- it will complete on its own when the payment is matched on the reconcile screen. Nothing to approve here.', staged_transaction: liveState }), { status: 409 })
        }
        return new Response(JSON.stringify({
          dry_run: true,
          kind: 'staged',
          stage_reference: split.stage_reference,
          staged_at: split.staged_at,
          stage_sweep_flag: split.stage_sweep_flag,
          stage_sweep_checked_at: split.stage_sweep_checked_at,
          staged_transaction: liveState,
          split,
          note: liveState?.reconciled
            ? 'The staged transaction has been matched in Xero -- run the staged-payments check to mark this split posted.'
            : `Staged and waiting: a pre-split transaction (${split.stage_reference}) sits in Xero ready for the CPA to Match when the payment lands in the bank feed.`,
        }, null, 2), { headers: { 'Content-Type': 'application/json' } })
      }

      // --- stage: preview, then create the pre-split SPEND transaction ---
      if (!loanAcct.prestage_enabled) {
        return new Response(JSON.stringify({ error: 'Pre-staging is not enabled for this loan.' }), { status: 409 })
      }
      if (!(split.source === 'amortization_schedule' && amortRow)) {
        return new Response(JSON.stringify({ error: 'Only schedule-sourced splits with a linked amortization row can be pre-staged -- the split must come from the loan\'s own amortization schedule.' }), { status: 409 })
      }
      if (!['pending_review', 'stage_expired'].includes(split.status)) {
        return new Response(JSON.stringify({ error: `This split is ${split.status} -- only a pending-review split can be staged.` }), { status: 409 })
      }

      // ── STALENESS GUARD (session 230) ────────────────────────────────────
      // A DERIVED schedule is a projection from one balance on one date. When a
      // newer lender statement exists, that anchor is out of date and every future
      // row is wrong -- most obviously after an extra principal payment, where the
      // projection keeps charging interest on a balance that no longer exists.
      //
      // The dangerous part is that such a row is not IMPOSSIBLE, merely wrong:
      // principal + interest still equals the payment, so the split invariant and
      // every arithmetic check below pass happily. It would stage, match and post
      // in silence. This is the one check that catches it, and it deliberately
      // fails CLOSED -- refusing to stage costs a click; staging a wrong split
      // costs a correcting journal and a conversation with the CPA.
      //
      // Scoped to derived schedules only. A lender-issued amortization document
      // (PCV, Verdant, Dexter 2, PayPal 2) is not invalidated by a statement
      // arriving -- it IS the lender's own figures. Only our projections go stale.
      if (String(split.stage_sweep_flag ?? '') === 'stale_projection') {
        return new Response(JSON.stringify({
          error: 'This period was flagged stale after its schedule was re-derived. Re-generate the split from the current schedule before staging it.',
          review_notes: split.review_notes,
        }), { status: 409 })
      }
      {
        const { data: guardSched } = await supa.from('loan_amortization_schedules')
          .select('id, amort_type, schedule_generated_date, anchor_statement_date')
          .eq('id', amortRow.schedule_id).maybeSingle()
        if (guardSched && String(guardSched.amort_type ?? '').startsWith('derived_')) {
          const { data: newestStmts } = await supa.from('loan_statements')
            .select('statement_date')
            .eq('loan_account_id', loanAcct.id)
            .in('source', ['lender_statement', 'email_pdf_upload', 'portal_manual_pull'])
            .not('principal_balance', 'is', null)
            .lte('statement_date', pacificToday())
            .order('statement_date', { ascending: false })
            .limit(1)
          const newestStmt = newestStmts?.[0]?.statement_date ? String(newestStmts[0].statement_date).slice(0, 10) : null
          // Prefer the recorded anchor; fall back to the generation date for
          // schedules derived before anchor_statement_date existed.
          const anchor = guardSched.anchor_statement_date
            ? String(guardSched.anchor_statement_date).slice(0, 10)
            : (guardSched.schedule_generated_date ? String(guardSched.schedule_generated_date).slice(0, 10) : null)
          if (newestStmt && anchor && anchor < newestStmt) {
            return new Response(JSON.stringify({
              error: `Refusing to stage: this card comes from a projection anchored to the ${anchor} balance, but a lender statement dated ${newestStmt} has arrived since. The projection is out of date -- re-derive this loan's schedule first, then stage the fresh card.`,
              projection_anchor_date: anchor,
              newest_statement_date: newestStmt,
              fix: 'Run loan-derive-schedule for this loan with confirm:true. Re-deriving also flags anything already staged whose numbers moved.',
            }), { status: 409 })
          }
        }
      }
      if (Math.abs((principal + interest) - totalAmt) >= ZERO_TOLERANCE) {
        return new Response(JSON.stringify({ error: `Refusing to stage: principal ($${principal.toFixed(2)}) + interest ($${interest.toFixed(2)}) does not equal the total ($${totalAmt.toFixed(2)}).` }), { status: 409 })
      }
      if (interest < ZERO_TOLERANCE || principal < ZERO_TOLERANCE || totalAmt < ZERO_TOLERANCE) {
        return new Response(JSON.stringify({ error: 'Refusing to stage: pre-staging is for blended payments with a real principal AND interest portion. A 100%-principal payment needs no pre-split (the feed line already codes to the loan account), and a zero/negative amount cannot be a SPEND transaction.' }), { status: 409 })
      }
      const rowDate = String(amortRow.row_date).slice(0, 10)
      const today = pacificToday()
      if (rowDate < today) {
        return new Response(JSON.stringify({ error: `This period was scheduled for ${rowDate}, which has already passed -- the payment should be in the bank feed by now. Use the normal review/approve flow instead of staging.` }), { status: 409 })
      }
      const stageRef = stageReferenceFor(loanAcct, rowDate)

      // Never stage twice, check 1: a live transaction already carrying this Reference.
      // Also self-heals the "Xero write succeeded but our DB update failed" gap.
      const refRes = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions?where=${encodeURIComponent(`Reference=="${stageRef}"`)}`, { headers: stHeaders })
      const refJson = await refRes.json().catch(() => null)
      if (!refRes.ok) {
        return new Response(JSON.stringify({ error: `Could not check Xero for an existing stage (status ${refRes.status}) -- refusing to stage blind.` }), { status: 502 })
      }
      const existingStage = (refJson?.BankTransactions || []).find((t: any) => isLiveBankTxn(t))
      if (existingStage) {
        return new Response(JSON.stringify({
          error: `A live transaction with reference "${stageRef}" already exists in Xero -- this period is already staged. If our records didn't reflect that, they may need repair.`,
          existing_bank_transaction_id: existingStage.BankTransactionID,
        }), { status: 409 })
      }
      // Never stage twice, check 2: the payment itself (or a hand-created copy)
      // already sits on the loan's bank account near the scheduled date.
      const existing = await findSameAmountTxns(stHeaders, loanAcct.xero_bank_account_id, totalAmt, new Date(rowDate), STAGE_DUP_WINDOW_DAYS)
      if (!existing.ok) {
        return new Response(JSON.stringify({ error: `Could not check Xero for an existing payment (${existing.error}) -- refusing to stage blind.` }), { status: 502 })
      }
      if (existing.matches.length) {
        return new Response(JSON.stringify({
          error: `A live transaction of $${totalAmt.toFixed(2)} already exists on this loan's account within ${STAGE_DUP_WINDOW_DAYS} days of ${rowDate} -- the payment appears to already be in Xero, so there is nothing to stage. Use the normal review/approve flow.`,
          candidates: existing.matches.map((t: any) => ({ id: t.BankTransactionID, date: t.DateString?.slice(0, 10), total: t.Total, reconciled: t.IsReconciled })),
        }), { status: 409 })
      }

      const stAcctMap = await fetchXeroAccountsMap(stHeaders)
      const proposedLines = [
        { AccountCode: loanAcct.xero_account_code, AccountName: stAcctMap[loanAcct.xero_account_code] ?? null, Description: `${loanAcct.xero_account_name} principal`, LineAmount: principal },
        { AccountCode: INTEREST_EXPENSE_ACCOUNT_CODE, AccountName: stAcctMap[INTEREST_EXPENSE_ACCOUNT_CODE] ?? null, Description: 'Interest', LineAmount: interest },
      ]

      // v47: backlog warning. Earlier payments from the same schedule that were never
      // processed here are the one thing that makes a stage dangerous on a loan with
      // identical payment amounts: if any of those bank lines is still unreconciled,
      // Xero's reconcile screen will suggest matching it to THIS staged transaction
      // (caught live on PayPal 2, 2026-08-21). We can't see Xero's unreconciled queue
      // through the API, so warn from our own records and let the human decide.
      let backlogWarning: string | null = null
      try {
        const schedId = split.amortization_row?.schedule_id
        if (schedId) {
          const { data: priorRows } = await supa
            .from('loan_amortization_rows')
            .select('id, row_date')
            .eq('schedule_id', schedId)
            .eq('row_type', 'payment')
            .lt('row_date', rowDate)
            .lte('row_date', today)
            .order('row_date', { ascending: false })
            .limit(12)
          if (priorRows?.length) {
            const { data: doneSplits } = await supa
              .from('loan_splits')
              .select('amortization_row_id, period_label, status')
              .eq('loan_account_id', split.loan_account_id)
              .in('status', ['posted', 'already_in_xero', 'staged'])
            const done = doneSplits || []
            const unprocessed = priorRows.filter((r: any) => {
              const day = String(r.row_date).slice(0, 10)
              return !done.some((d: any) => d.amortization_row_id === r.id || d.period_label === day || d.period_label === day.slice(0, 7))
            })
            if (unprocessed.length) {
              const dates = unprocessed.map((r: any) => String(r.row_date).slice(0, 10)).reverse().join(', ')
              backlogWarning = `${unprocessed.length} earlier scheduled payment${unprocessed.length === 1 ? '' : 's'} (${dates}) ${unprocessed.length === 1 ? 'has' : 'have'} no processed split yet. If any of those bank lines is still unreconciled in Xero, the reconcile screen will suggest matching it to this staged transaction -- same amount, wrong week. Match ONLY the line whose date agrees with the staged reference (${stageRef}); code earlier lines the normal way first.`
            }
          }
        }
      } catch (_) { /* the warning is best-effort; never block staging on it */ }

      if (!confirm) {
        return new Response(JSON.stringify({
          dry_run: true,
          kind: 'pre_stage',
          proposed_transaction: {
            type: 'SPEND',
            date: rowDate,
            contact: loanAcct.lender,
            reference: stageRef,
            total: totalAmt,
            lines: proposedLines,
          },
          split,
          backlog_warning: backlogWarning,
          note: `This will create a $${totalAmt.toFixed(2)} pre-split transaction in Xero dated ${rowDate}, ready for the CPA to Match (one click) when the real payment lands in the bank feed. Nothing has been written yet.`,
        }, null, 2), { headers: { 'Content-Type': 'application/json' } })
      }

      // confirm === true: create the transaction. Xero first, database second (v26
      // discipline) -- and a DB failure after a successful create is a LOUD error.
      const createPayload = {
        BankTransactions: [{
          Type: 'SPEND',
          Contact: { Name: loanAcct.lender },
          BankAccount: { AccountID: loanAcct.xero_bank_account_id },
          Date: rowDate,
          Reference: stageRef,
          LineAmountTypes: 'NoTax',
          Status: 'AUTHORISED',
          LineItems: [
            { Description: proposedLines[0].Description, Quantity: 1, LineAmount: principal, AccountCode: loanAcct.xero_account_code, TaxType: 'NONE' },
            { Description: 'Interest', Quantity: 1, LineAmount: interest, AccountCode: INTEREST_EXPENSE_ACCOUNT_CODE, TaxType: 'NONE' },
          ],
        }],
      }
      const createRes = await fetch('https://api.xero.com/api.xro/2.0/BankTransactions', {
        method: 'PUT',
        headers: { ...stHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(createPayload),
      })
      const createJson = await createRes.json().catch(() => null)
      const created = createJson?.BankTransactions?.[0]
      if (!createRes.ok || createJson?.Elements?.[0]?.ValidationErrors?.length || !created?.BankTransactionID) {
        return new Response(JSON.stringify({ error: 'Xero refused to create the pre-staged transaction -- nothing was staged.', status: createRes.status, details: createJson }), { status: 502 })
      }
      const { error: stageDbErr } = await supa
        .from('loan_splits')
        .update({
          status: 'staged',
          posting_method: 'pre_staged',
          matched_xero_bank_transaction_id: created.BankTransactionID,
          stage_reference: stageRef,
          staged_at: new Date().toISOString(),
          stage_sweep_flag: null,
          stage_sweep_checked_at: null,
          review_notes: (split.review_notes ? split.review_notes + ' -- ' : '') + `Pre-staged in Xero ${today}${posted_by ? ' by ' + posted_by : ''} as ${stageRef}.`,
        })
        .eq('id', loan_split_id)
      if (stageDbErr) {
        // The Xero transaction EXISTS. Never report this as a clean failure -- name
        // the transaction so a human (or the Reference check above, next attempt)
        // can reconcile our records with reality.
        return new Response(JSON.stringify({
          error: `The pre-staged transaction WAS created in Xero (${created.BankTransactionID}, reference ${stageRef}), but our own record could not be updated: ${stageDbErr.message}. Do NOT stage again blindly -- the Reference check will refuse, and the record needs repair.`,
          bank_transaction_id: created.BankTransactionID,
        }), { status: 500 })
      }
      return new Response(JSON.stringify({
        ok: true,
        kind: 'pre_stage',
        staged: true,
        bank_transaction: { id: created.BankTransactionID, date: rowDate, reference: stageRef, total: totalAmt, lines: proposedLines },
        note: `Staged: a $${totalAmt.toFixed(2)} pre-split transaction now sits in Xero dated ${rowDate}. When the real payment lands in the bank feed, the reconcile screen will offer it as a Match -- one click, no journal. The staged-payments check watches for the match, a duplicate, or a payment that never comes.`,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } })
    }
    // ==================== end v41 pre-staging lifecycle ====================

    // --- attach_only: attach the statement to an ALREADY-posted journal (session 222) ---
    //
    // Repair path, deliberately narrow. It exists for two situations:
    //   1. Splits posted BEFORE v34, whose journal never got its statement because the
    //      pure-reclass branch hardcoded attached:false. Those journals are correct but
    //      undocumented, and there was previously no way to fix that short of voiding and
    //      re-posting -- which is a far riskier operation than attaching a PDF.
    //   2. A post where the journal succeeded but the attachment leg failed. Since
    //      attachStatementToJournal() never throws (by design -- see its comment), that
    //      combination is reachable and needs a retry that does NOT re-post the journal.
    //
    // Writes NOTHING to the database and creates NO journal. It requires the split to
    // already carry an xero_manual_journal_id and refuses otherwise, so it cannot be used
    // to sneak a write onto an unposted split.
    if (attach_only) {
      if (!split.xero_manual_journal_id) {
        return new Response(JSON.stringify({
          error: 'This split has no posted Manual Journal to attach to. attach_only repairs the attachment on an already-posted split; it never posts.',
          split_status: split.status,
        }), { status: 409 })
      }
      const { accessToken: aToken, tenantId: aTenant } = await getXeroAuth()
      const result = await attachStatementToJournal(
        supa, aToken, aTenant, stmt, split.xero_manual_journal_id,
        isScheduleSourced ? SCHEDULE_SOURCED_SKIP : undefined,
      )
      return new Response(JSON.stringify({
        ok: true,
        attach_only: true,
        manual_journal_id: split.xero_manual_journal_id,
        period_label: split.period_label,
        statement_path: stmt?.storage_path ?? null,
        attachment: result,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } })
    }

    // token + tenantId are still destructured out: the attachment PUT below builds its
    // own headers because it needs a different Content-Type.
    const { headers, accessToken: token, tenantId } = await getXeroAuth()

    // --- v19: no-bank-match paths (see the version note above for why these exist) ---

    // Session 224: the two no-bank-match shapes below have nothing to be
    // "already handled" against -- marking doesn't apply, Approve is the path.
    if (mark_already_in_xero && (Math.abs(interest) < ZERO_TOLERANCE || Math.abs(totalAmt) < ZERO_TOLERANCE)) {
      return new Response(JSON.stringify({ error: "This split doesn't involve a matched bank payment, so 'already handled in Xero' doesn't apply -- use Approve; it posts exactly what the review screen shows." }), { status: 409 })
    }

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
          // Wording settled session 222 after testing the numbers rather than taking the
          // lender's framing at face value. Rapid presents this as a "fee", which reads
          // like a fixed one-time charge -- but it is 0.894% of the OUTSTANDING BALANCE
          // every week across 10 measured periods, with a spread of 0.0009 percentage
          // points, and equals payment minus that week's principal reduction exactly.
          // A fixed fee does not shrink as the balance is paid down. This is interest on
          // a declining balance (~46.5% simple APR), and calling it a "fee" in the ledger
          // was the one wording that implied it was NOT interest. See design doc C11.
          Narration: `${loanAcct.xero_account_name} — interest, ${split.period_label}`,
          Date: split.period_label,
          Status: 'POSTED',
          JournalLines: [
            { LineAmount: interest, AccountCode: INTEREST_EXPENSE_ACCOUNT_CODE, Description: `Interest`, TaxType: 'NONE' },
            { LineAmount: -interest, AccountCode: loanAcct.xero_account_code, Description: `Interest charged to loan balance`, TaxType: 'NONE' },
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

    if (loanAcct.direct_split_enabled && !mark_already_in_xero) {
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
    // Session 224: set when the SINGLE amount+account match turns out to be a
    // transaction that was already split in Xero — the exception case below.
    let candidateAnnotationsSeed: { id: string; lines: any[] } | null = null
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
      // Session 224 (David): "Redoing already split transactions is a recipe for
      // a big mess." A picked transaction that already carries a split — more
      // than one line item, or an interest-account line — was already handled
      // (by this system or by the CPA directly in Xero). Posting a reallocation
      // journal for it would double the interest move. Hard refusal, plain
      // language, evidence included so the CPA can verify in Xero.
      {
        const pickedLines = candidate.LineItems || []
        const pickedWorked = pickedLines.length > 1 ||
          pickedLines.some((l: any) => String(l.AccountCode) === INTEREST_EXPENSE_ACCOUNT_CODE)
        if (pickedWorked) {
          return new Response(JSON.stringify({
            reason: 'picked_already_worked',
            error: `That ${candidate.DateString?.slice(0, 10)} transaction has already been split in Xero — its coding already includes ${pickedLines.length > 1 ? `${pickedLines.length} lines` : 'an interest line'}. Posting this split against it would double up the interest. Nothing was posted. If this month still needs work, that's a question for whoever coded the transaction in Xero.`,
            bank_transaction: { id: candidate.BankTransactionID, date: candidate.DateString, total: candidate.Total, current_lines: candidate.LineItems },
          }), { status: 409 })
        }
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
        // Session 224: even a unique match must not be re-done if its Xero
        // coding shows it was already split (see the block below for the rule).
        const soleLines = candidate.LineItems || []
        if (soleLines.length > 1 || soleLines.some((l: any) => String(l.AccountCode) === INTEREST_EXPENSE_ACCOUNT_CODE)) {
          candidateAnnotationsSeed = { id: candidate.BankTransactionID, lines: soleLines }
          candidate = null
        }
      }
    }

    // ── Session 224 (David): "Giving the bookkeeper 6 dates to choose from is
    // not helpful. We need to be abstracting as much as possible here." ──────
    // The system can answer most of the question itself, from facts it already
    // has: a transaction whose Xero coding carries more than one line item, or
    // an interest-account line, has ALREADY been worked — by this system or by
    // the CPA directly in Xero. And a transaction another split has posted
    // against is taken. So, when the amount alone is ambiguous:
    //   - classify every candidate (bounded detail fetches),
    //   - if exactly ONE unworked, untaken candidate remains, proceed with it
    //     automatically (the operator still reviews and approves — this only
    //     removes the pointless multiple-choice quiz),
    //   - if NONE remain, the month was already handled in Xero: flag it as an
    //     EXCEPTION for the CPA to verify — per David, the system must never
    //     "redo" an already-split transaction, so there is no write path here,
    //   - otherwise show the (shorter) picker with the worked ones labeled and
    //     unclickable.
    // Everything here READS Xero and our own loan_splits; nothing is guessed.
    let candidateAnnotations: Map<string, { alreadyWorked: boolean; usedByPeriod: string | null; lines: any[] }> | null = null
    if (!candidate && candidates.length > 1 && candidates.length <= 8) {
      const { data: usedRows } = await supa.from('loan_splits')
        .select('id, period_label, matched_xero_bank_transaction_id')
        .eq('loan_account_id', loanAcct.id)
        .not('matched_xero_bank_transaction_id', 'is', null)
      const usedBy = new Map<string, string>()
      for (const r of (usedRows || [])) {
        if (r.id !== loan_split_id && r.matched_xero_bank_transaction_id) {
          usedBy.set(String(r.matched_xero_bank_transaction_id).toLowerCase(), r.period_label)
        }
      }
      candidateAnnotations = new Map()
      const detailedById = new Map<string, any>()
      for (const c of candidates) {
        const dr = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions/${c.BankTransactionID}`, { headers })
        const dj = await dr.json().catch(() => null)
        const d = dj?.BankTransactions?.[0] || c
        detailedById.set(c.BankTransactionID, d)
        const lines = d.LineItems || []
        const alreadyWorked = lines.length > 1 ||
          lines.some((l: any) => String(l.AccountCode) === INTEREST_EXPENSE_ACCOUNT_CODE)
        candidateAnnotations.set(c.BankTransactionID, {
          alreadyWorked,
          usedByPeriod: usedBy.get(String(c.BankTransactionID).toLowerCase()) || null,
          lines: withAccountNames(lines, acctMap),
        })
      }
      const open = candidates.filter(c => {
        const a = candidateAnnotations!.get(c.BankTransactionID)!
        return !a.alreadyWorked && !a.usedByPeriod
      })
      if (open.length === 1) {
        candidate = detailedById.get(open[0].BankTransactionID) || open[0]
      }
    }

    // Session 224: marking re-verifies server-side and only succeeds when the
    // already-handled state still holds. An untouched matching payment means the
    // month is NOT fully handled -- refuse rather than hide real work.
    if (mark_already_in_xero && candidate) {
      return new Response(JSON.stringify({
        reason: 'not_actually_handled',
        error: `Re-checking found an untouched ${String(candidate.DateString || '').slice(0, 10)} payment matching this amount -- this month is not already handled, so it stays in your approvals. Open the review to post it normally.`,
        bank_transaction: { id: candidate.BankTransactionID, date: candidate.DateString, total: candidate.Total },
      }), { status: 409 })
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
      const feedLabel = loanAcct.xero_account_name ? `the ${loanAcct.xero_account_name} feed` : 'the bank feed'
      // Session 224: annotated candidates + the already-handled exception state.
      const annotatedCandidates = candidates.map(c => {
        const a = candidateAnnotations?.get(c.BankTransactionID) || null
        return {
          id: c.BankTransactionID, date: c.DateString, total: c.Total,
          reference: c.Reference, contact: c.Contact?.Name,
          days_from_period: c.DateString ? wholeDaysBetween(new Date(c.DateString), warnAnchor) : null,
          already_worked: a ? a.alreadyWorked : null,
          used_by_period: a ? a.usedByPeriod : null,
          current_lines: a && a.alreadyWorked ? a.lines : undefined,
        }
      })
      const openCount = candidateAnnotations
        ? annotatedCandidates.filter(c => !c.already_worked && !c.used_by_period).length
        : null
      const soleWorked = candidateAnnotationsSeed !== null
      const allHandled = soleWorked || (candidateAnnotations !== null && openCount === 0)
      if (allHandled) {
        const handledEvidence = soleWorked
          ? [{ id: candidateAnnotationsSeed!.id, already_worked: true, used_by_period: null, current_lines: withAccountNames(candidateAnnotationsSeed!.lines, acctMap) }]
          : annotatedCandidates
        // Session 224 round 2 (David: "if they do [count as actionable], make
        // them go away"): a human who has SEEN this evidence may record the
        // resolution. The mark writes NOTHING to Xero -- it only moves OUR
        // loan_splits row out of the approvals queue, with the evidence kept
        // in review_notes. Server-verified on this same request, never taken
        // from the client.
        if (mark_already_in_xero) {
          const evidenceNote = handledEvidence
            .map((c: any) => `${String(c.date || '').slice(0, 10) || c.id}: ${(c.current_lines || []).map((l: any) => `$${l.LineAmount} -> ${l.AccountCode}${l.AccountName ? ' ' + l.AccountName : ''}`).join(', ') || (c.used_by_period ? `attached to ${c.used_by_period} split` : 'already split')}`)
            .join(' | ')
          const { error: markErr } = await supa
            .from('loan_splits')
            .update({
              status: 'already_in_xero',
              review_notes: (split.review_notes ? split.review_notes + ' -- ' : '')
                + `Marked as already handled in Xero ${new Date().toISOString().slice(0, 10)}${posted_by ? ' by ' + posted_by : ''}. No WashRoute write; evidence read from Xero: ${evidenceNote}`.slice(0, 1500),
            })
            .eq('id', loan_split_id)
          if (markErr) {
            return new Response(JSON.stringify({ error: `Could not update the split: ${markErr.message}` }), { status: 500 })
          }
          const flagAutoResolveMark = await maybeAutoResolveFlag(supa, loanAcct)
          return new Response(JSON.stringify({
            ok: true,
            marked: 'already_in_xero',
            wrote_nothing_to_xero: true,
            evidence: handledEvidence,
            flag_auto_resolve: flagAutoResolveMark,
          }, null, 2), { headers: { 'Content-Type': 'application/json' } })
        }
        // Every payment matching this amount has already been split in Xero (or
        // is attached to another period's split). Per David: FLAG the exception
        // for the CPA to investigate in Xero — never redo an already-split
        // transaction. The only write on offer is can_mark -- recording, in OUR
        // records alone, that a human confirmed it.
        return new Response(JSON.stringify({
          can_mark: true,
          reason: 'already_handled_in_xero',
          error: soleWorked
            ? `The one bank transaction matching this amount was already split in Xero — its coding already carries the interest breakdown. WashRoute will not touch it again.`
            : `Every bank transaction matching this amount ($${split.total_amount}) has already been handled — split in Xero or attached to another period's split. WashRoute will not redo any of them.`,
          anchor_date: isoDay(warnAnchor),
          candidates: handledEvidence,
          cpa_note: 'This split stays pending as a flag. Ask whoever keeps the books in Xero to confirm the period was split correctly there; if it was, this row is just history catching up and can be left as-is.',
        }), { status: 409 })
      }
      if (mark_already_in_xero) {
        return new Response(JSON.stringify({
          reason: 'not_actually_handled',
          error: candidates.length > 1
            ? 'Re-checking found untouched payments matching this amount -- this month is not already handled, so it stays in your approvals.'
            : 'Re-checking found no matching payment in Xero at all -- there is nothing to mark as handled. If the payment is recent, it may simply not have synced yet.',
        }), { status: 409 })
      }
      const notFoundReason = candidates.length > 1
        ? 'ambiguous_candidates'
        : (statementIsRecent ? 'payment_not_yet_in_xero' : 'no_matching_transaction')
      const handledCount = candidateAnnotations ? candidates.length - (openCount ?? candidates.length) : 0
      return new Response(JSON.stringify({
        reason: notFoundReason,
        error: notFoundReason === 'ambiguous_candidates'
          ? (handledCount > 0
            ? `${candidates.length} payments matched this amount — ${handledCount} ${handledCount === 1 ? 'is' : 'are'} already handled, leaving ${openCount} to choose from.`
            : `${candidates.length} live bank transactions matched the amount ($${split.total_amount}) in the date window -- pass bank_transaction_id to pick the right one.`)
          : (notFoundReason === 'payment_not_yet_in_xero'
            ? `The $${split.total_amount} payment for ${notFoundRefDate} hasn't appeared on ${feedLabel} in Xero yet. That's normal this soon after the statement date -- it will match itself once the bank feed syncs. Nothing to do right now.`
            : `No live bank transaction found on ${feedLabel} matching $${split.total_amount} near ${notFoundRefDate}. It may not have cleared/synced yet, or the payment amount doesn't match.`),
        anchor_date: isoDay(warnAnchor),
        candidates: annotatedCandidates,
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