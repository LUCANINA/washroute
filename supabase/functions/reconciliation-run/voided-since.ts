// reconciliation-run/voided-since.ts — a void is a silent balance change (session 291)
//
// Pure. No Xero, no database, no Deno. Takes the entries a run already pulled and
// returns findings, so the whole judgement is exercisable from a test file with
// nothing running (tests/voided-since.test.mts) rather than only from a live run
// against a ledger somebody has to void something in first.

import { money, type Finding } from './double-reallocation.ts'

/** Live means it affects the books. Xero keeps DELETED/VOIDED objects and returns
 *  them from every list, so this predicate is what stands between the ledger and a
 *  withdrawn draft counted as a payment. Deliberately identical to
 *  reconciliation-run's -- if the two ever disagree, this check reports voids the
 *  walk is still counting, or misses ones it has dropped, and either way it lies. */
export const isLive = (r: any) =>
  r.srcType === 'BankTransaction' ? r.status === 'AUTHORISED' : r.status === 'POSTED'

/** Signed effect on a liability balance. SPEND pays down; RECEIVE draws more.
 *  ManualJournal LineAmount is already signed (debit +, credit −); a debit to a
 *  liability reduces it. Same rule as reconciliation-run's effect(), same reason. */
export function effect(rec: any, code: string): number {
  const amt = (rec.lines || []).filter((l: any) => l.c === code)
    .reduce((s: number, l: any) => s + Number(l.a || 0), 0)
  if (rec.srcType === 'BankTransaction') return String(rec.type || '').startsWith('RECEIVE') ? amt : -amt
  return -amt
}

/** Xero's UpdatedDateUTC as epoch ms. Null when absent or unparseable -- and null
 *  is NOT zero: an entry whose update time we cannot read must never be treated as
 *  "changed at the dawn of time", because the caller asks "changed since X?" and an
 *  unreadable stamp answering yes would fire on the entire ledger. */
export function stampMs(raw: any): number | null {
  const m = String(raw ?? '').match(/\/Date\((-?\d+)/)
  if (m) return Number(m[1])
  const t = Date.parse(String(raw ?? ''))
  return Number.isFinite(t) ? t : null
}

/** A Postgres timestamptz as epoch ms.
 *
 *  WRITTEN BECAUSE THE TEST CAUGHT IT FAILING. supabase-js hands `started_at` back
 *  as "2026-09-09 02:10:56.961634+00" -- a space instead of the T, and a two-digit
 *  offset where ISO-8601 wants "+00:00". `Date.parse` returns NaN for that, so the
 *  first cut of this check had a cursor it could never read and announced NOTHING,
 *  for every void, forever. It passed six of its own assertions while doing so,
 *  because every one of those six asserts SILENCE.
 *
 *  That is the shape this module exists to prevent, one level up: a guard that
 *  cannot read its input fails quiet, and quiet looks exactly like "nothing to
 *  report". NaN is returned as null so the caller treats it as unknown and the
 *  cursor branch simply does not run -- never as 0, which would date the cursor to
 *  1970 and fire on the entire ledger. */
export function cursorMs(raw: string | null | undefined): number | null {
  if (!raw) return null
  let t = String(raw).trim().replace(' ', 'T')
  if (/[+-]\d{2}$/.test(t)) t += ':00'            // "+00"  -> "+00:00"
  else if (!/([+-]\d{2}:?\d{2}|Z)$/i.test(t)) t += 'Z'  // no offset at all -> UTC
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? ms : null
}

/** ── A VOID IS A SILENT BALANCE CHANGE (session 291) ─────────────────────────
 *  The case this was written for, and it cost a session to diagnose:
 *
 *  Manual journal 261a4fd6 (2026-07-31, "Reverse 31 Jul reclass -- 2026-08-05
 *  PayPal principal counted twice", 284 -3,142.26 / 800 +3,142.26) was VOIDED in
 *  Xero at 2026-09-09 10:04 UTC. isLive() correctly stopped counting it, so every
 *  derived PayPal 2 balance from 2026-07-31 forward fell by exactly 3,142.26 --
 *  and NOTHING SAID SO. The consequence surfaced a screen away as an unexplained
 *  "Xero is $3,120.61 below the lender", and the next session spent its day
 *  inventing a window-boundary bug to explain it, because the run's own numbers
 *  fitted that story perfectly.
 *
 *  WORSE, AND THIS IS THE PART THAT MAKES IT A DELETION RATHER THAN A GAP: the
 *  only record that the journal had ever existed was an open
 *  `unexplained_ledger_adjustment` finding, and the SAME RUN auto-resolved it. The
 *  product removed 3,142.26 of book value and the note explaining it in one pass.
 *  That resolve is correct on its own terms -- there is no hand-posted correction
 *  any more -- so the fix is not to freeze the old finding but to make sure the
 *  claim lands somewhere: this check carries the journal's date, amount and the
 *  writer's own narration forward (ce17: cut the surface, never the claim).
 *
 *  WHY checkNonLiveCounted DOES NOT COVER IT. That check asks whether OUR SPLITS
 *  count more payments for a date than Xero has live entries. This journal had no
 *  split -- being unaccounted for is precisely what made it worth flagging -- so
 *  there was nothing for it to compare. Different question, different check.
 *
 *  NARROW BY CONSTRUCTION, in three ways, because "Xero being messy is not a
 *  finding" (the s219 lesson checkNonLiveCounted learned the hard way -- Stripe
 *  Capital alone voided 16 entries in one day from its payout sync):
 *
 *   1. ONLY entries that CHANGED SINCE THE LAST RUN. A void that predates our
 *      watch is history, not news. `prevStartedAt` null (a first run, or a run
 *      whose predecessor we cannot date) raises NOTHING -- a cold start must not
 *      announce the entire back catalogue.
 *   2. ONLY entries that MOVED THIS LOAN'S BALANCE. effect() === 0 means the void
 *      cost the account nothing; a withdrawn draft that never touched the balance
 *      is bookkeeping, not a finding.
 *   3. ONE FINDING PER JOURNAL, not per loan and not per date. The grouping key is
 *      a claim about what is the same thing (s290 cont. 5): two voids on one loan
 *      are two events, and folding them would bury the second.
 *
 *  DELIBERATELY NOT GATED ON THE CLOSE DATE. A void changes the balance TODAY
 *  whatever period the entry is dated in -- the same reason `balance_vs_lender` is
 *  never silenced by a close date (s230). Filing it under "history" because the
 *  journal is dated inside a closed month would hide precisely the voids nobody can
 *  see by eye. It asks a question about the present; it does not raise work in a
 *  closed period.
 *
 *  IT STAYS OPEN UNTIL A HUMAN DEALS WITH IT. On the NEXT run this journal's
 *  updatedMs is older than that run's cursor, so condition 1 alone would stop
 *  re-raising it and the resolve sweep would close it after a single appearance --
 *  a finding that flashes once and clears itself is worse than none, because the
 *  screen that was meant to carry it is empty by the time anyone looks. So an
 *  ALREADY-OPEN fingerprint re-raises on the entry still being non-live, with no
 *  reference to when it changed. New voids are announced; announced voids stay
 *  announced; nothing is announced twice.
 */
export function checkVoidedSinceLastRun(
  loan: any, allEntries: any[], prevStartedAt: string | null, openFingerprints: Set<string>,
): Finding[] {
  const code = loan.xero_account_code
  const prevMs = cursorMs(prevStartedAt)
  const haveCursor = prevMs != null
  const out: Finding[] = []

  for (const r of allEntries) {
    if (isLive(r)) continue
    if (!r.lines.some((l: any) => l.c === code)) continue
    const eff = Math.round(effect(r, code) * 100) / 100
    if (eff === 0) continue
    const fingerprint = `voided_since_last_run:${code}:${r.srcId}`
    const changedSince = haveCursor && r.updatedMs != null && r.updatedMs > (prevMs as number)
    if (!changedSince && !openFingerprints.has(fingerprint)) continue

    const what = r.srcType === 'ManualJournal' ? 'journal' : 'transaction'
    const said = String(r.narration ?? r.ref ?? r.contact ?? '').trim().slice(0, 120)
    // The DIRECTION in plain words. A voided entry that had been INCREASING the
    // liability leaves the books lower than they were, and vice versa -- and which
    // way it went is the first thing a bookkeeper needs, so it goes in the title
    // rather than being left for them to derive from a sign.
    const direction = eff > 0
      ? `so this loan's balance in Xero is now ${money(Math.abs(eff))} LOWER than before`
      : `so this loan's balance in Xero is now ${money(Math.abs(eff))} HIGHER than before`

    out.push({
      fingerprint,
      check_key: 'voided_since_last_run',
      severity: 'error',
      loan_account_id: loan.id,
      title: `${loan.xero_account_name} — a ${money(Math.abs(eff))} ${what} dated ${r.date} was ${String(r.status || '').toLowerCase() || 'removed'} in Xero`,
      plain_english: `A ${what} dated ${r.date}${said ? ` ("${said}")` : ''} used to be part of this loan's ledger and is now ${String(r.status || 'not live').toLowerCase()} in Xero, ${direction}. Nothing is wrong with that on its own — someone may have meant to remove it — but it moves every balance this product has calculated from ${r.date} onwards, and it is the kind of change that shows up later as an unexplained difference against the lender. Confirm it was deliberate. If it was, the balances are already correct and this can be dismissed. If it was not, the entry needs re-posting in Xero — not here.`,
      detail: {
        code,
        // `date` is load-bearing: the resolve sweep only protects a finding from
        // being auto-resolved when it can read a date off it.
        date: r.date,
        status: r.status ?? null,
        source_type: r.srcType,
        source_id: r.srcId,
        effect_on_balance: eff,
        narration: said || null,
        first_seen_via: changedSince ? 'changed_since_last_run' : 'still_open_from_earlier_run',
      },
    })
  }
  return out
}
