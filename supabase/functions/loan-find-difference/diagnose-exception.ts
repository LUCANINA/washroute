// diagnose-exception.ts — session 234
// =============================================================================
// DEFERENCE HAS TO CARRY A DIAGNOSIS.
//
// The engine's rule is that it never writes on top of the accountant's work
// (`alreadyWorked`, session 224). Until now that rule was implemented as
// silence: `cpa_exception` said "your accountant already worked it — she
// decides" and stopped. In the 4140 case the analysis was holding, at that
// exact moment, every input needed to say something far more useful:
//
//   the $415.88 is April $147.43 + May $135.64 + June $132.81, and all three
//   were ALREADY reallocated by journals 31ad48e9 / 7ce60981 / 12ef542c — so
//   the payment's at-source interest split is a second correction of the same
//   three months. Reverse it: debit the loan $415.88, credit 800 $415.88.
//
// A human worked that out by hand. Doing it by hand does not survive contact
// with the second customer (THE ACCOUNTANT IS THE OTHER USER, rule 2), so it
// has to come out of the engine.
//
// ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
// It still never writes on her entry, and it never proposes anything on the
// strength of arithmetic alone. Session 233 shipped a check whose whole defect
// was that a plausible-looking sum near a payment was treated as that payment's
// (PROXIMITY IS NOT OWNERSHIP). The guard here is that a component only counts
// as already-reallocated when the SPLIT ITSELF RECORDS THE JOURNAL --
// `xero_manual_journal_id` on our own row, the same link `checkDoubleReallocation`
// was rewritten to pair through. Arithmetic decides WHICH months; the recorded
// link decides whether they were already corrected. Both must agree, and the
// total must equal the span's gap to the cent, or no entry is proposed.
// =============================================================================

export interface DiagSplit {
  period_label: string
  interest_amount: number | string | null
  xero_manual_journal_id?: string | null
  status?: string | null
}

export interface DiagLine { c: string | null; a: number | string | null; d?: string | null }

export interface DiagnosisComponent {
  period: string
  interest: number
  /** Already booked once, by either route — so allocating it again duplicates it. */
  already_booked: boolean
  booked_by: BookedBy
  journal_id: string | null
}

export interface WorkedEntryDiagnosis {
  /**
   * What was found. NOTE: always test `entry` rather than `shape` before
   * treating this as a proposal — a diagnosis can be a confident
   * 'duplicated_reallocation' and still carry entry: null, when the amount
   * does not fully account for the span's gap.
   */
  shape: 'duplicated_reallocation' | 'partly_duplicated' | 'no_duplication' | 'undecomposable'
  /** Interest allocated on the accountant's entry, at source. */
  at_source: number
  /** What the payment's OWN period actually owes in interest. */
  owed: number
  /** The months the at-source figure decomposes into, newest last. */
  components: DiagnosisComponent[] | null
  /** Of `at_source`, how much was already booked once before (either route). */
  duplicated: number
  /**
   * The remainder of her split that we deliberately do NOT reverse: months that
   * were never booked, where her allocation is a legitimate catch-up. Null when
   * there is none, or when no entry is proposed.
   */
  carry_over: { amount: number; months: string[] } | null
  /** The balanced correcting entry — only when shape is 'duplicated_reallocation'. */
  entry: {
    amount: number
    direction: 'interest_back_to_loan' | 'interest_out_of_loan'
    date: string
    dated_because: string
    Narration: string
    Date: string
    Status: 'POSTED'
    JournalLines: Array<{ LineAmount: number; AccountCode: string; Description: string; TaxType: 'NONE' }>
  } | null
  /** The decision, visible, at most ~35 words. Always present. */
  note: string
  /**
   * Everything the short note used to say, unabridged, for "Show the working".
   * ── session 279: A CLAIM IS STATED ONCE PER SCREEN ─────────────────────────
   * The old single `note` was 126 words of prose that restated, in order: the
   * month table rendered directly beneath it, the journal ids in that table's
   * own column, the carry-over box, and the prepared entry's date and dating
   * reason. Every figure on the card was on screen at least twice and the
   * important ones five times. Nothing here is deleted -- it is relocated
   * behind a <details>, which is where a second statement of a visible claim
   * belongs. Empty string when there is nothing beyond the short note.
   */
  note_working: string
}

const r2 = (n: number) => Math.round(n * 100) / 100
const money = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// ── WAS THIS MONTH'S INTEREST ALREADY BOOKED? (session 235) ────────────────
// There are exactly TWO ways it can already be booked, and both are RECORDED
// FACTS in our own rows -- neither is inferred from arithmetic or proximity:
//
//   'our_journal'  the split carries `xero_manual_journal_id` and reached Xero.
//                  We reallocated it. The payment was coded 100% to the loan and
//                  our journal carved the interest out afterwards.
//
//   'at_source'    the split's status is `already_in_xero`. Per loan-xero-post
//                  (session 224) that is "a human looked at the evidence and
//                  recorded that the month was handled directly in Xero", and it
//                  is set deliberately, one way, by a person clicking a button.
//
// Session 235 checked the second against production before trusting it, because
// an `already_in_xero` split carries NO journal id and the first draft of this
// file therefore read it as "never booked" -- the exact inversion that would
// have left a real duplicate unreversed. Every such split sampled across four
// loans (242, 332, 338, 243) resolves to a bank transaction split AT SOURCE into
// the loan account and 800, for exactly the principal/interest this row records:
//
//   4140  2026-01  242=1011.27  800=169.05   (split row: 1011.27 / 169.05)
//   4140  2026-08  242=1070.29  800=110.03   (split row: 1070.29 / 110.03)
//   4751  2026-08  332= 791.62  800=255.33   (split row:  791.62 / 255.33)
//   7410  2026-08  338= 470.64  800=172.86   (split row:  470.64 / 172.86)
//   BayFirst 2026-08 243=971.56 800=1094.19  (split row:  971.56 / 1094.19)
//
// Anything else -- pending_review, needs_attention, a staged split with no
// journal, or no split row for that month at all -- is NOT booked. A later
// payment allocating that month's interest is then a legitimate CATCH-UP, and
// reversing it would re-break the month it was fixing.
const REACHED_XERO = new Set(['posted', 'already_in_xero', 'staged'])

export type BookedBy = 'our_journal' | 'at_source' | 'at_source_unverified' | null

export function bookedBy(s: DiagSplit): BookedBy {
  const status = String(s.status ?? '').toLowerCase()
  if (s.xero_manual_journal_id && REACHED_XERO.has(status || 'posted')) return 'our_journal'
  if (status === 'already_in_xero') return 'at_source'
  return null
}

const shortId = (id: string | null) => (id ? String(id).slice(0, 8) : '—')

export function diagnoseWorkedEntry(o: {
  lines: DiagLine[]
  loanCode: string
  interestCode: string
  splits: DiagSplit[]
  paymentPeriod: string
  /** The span's gap, xeroDelta − lenderDelta. Positive = Xero above the lender. */
  gap: number
  postingDate: string
  postingWhy: string
  loanName: string
  tol?: number
  /** How many months back a catch-up allocation may plausibly reach. */
  maxLookback?: number
  /**
   * Session 236: does the journal that ALSO booked the payment's OWN month fall
   * inside this span's entry window? The caller knows; we cannot.
   *
   * This matters because a correction lands in the span its DATE puts it in, not
   * the span of the period it corrects. On 4140, journal `12ef542c` carries June's
   * interest but is dated 2026-05-18, so it sits in the PREVIOUS pair and June's
   * duplicate is nowhere in June's own gap. Assuming otherwise is what made the
   * first version of this file never fire on the case it was written for.
   */
  ownJournalInSpan?: boolean
  /**
   * Session 236 cont.: does a SEPARATE transaction actually show this month's
   * interest booked at source? The caller can see Xero; we cannot.
   *
   * Session 235 trusted `already_in_xero` on its own, having verified five
   * samples that all turned out to be split-at-source. E5-4751's 2026-04 is the
   * counterexample, sitting in the same lender's books: marked already_in_xero,
   * carrying no journal, and with NO booking anywhere in Xero — its own month's
   * payment is a single unsplit line, and the $281.79 was only ever booked as
   * part of the May catch-up. Trusting the marker proposed reversing $548.21 on a
   * loan only $266.42 above its lender, which would have pushed it $281.79 BELOW.
   *
   * The marker means "a human said this month is handled" — and a human may well
   * have said it BECAUSE of the catch-up payment we are now examining. So for a
   * foreign month it is a claim, not evidence, and it has to be corroborated by
   * an actual second transaction. With no predicate supplied, an at-source claim
   * counts as UNVERIFIED: the safe direction is to leave money alone.
   */
  atSourceEvidence?: (interest: number, period: string) => boolean
  /**
   * Tolerance for "does the walk agree with my decomposition". Wider than the
   * cent-level TOL used for matching amounts: the walk sums many Xero lines
   * against lender balances, and a couple of cents of drift is normal (E4-9744
   * reads 181.97 against a schedule that says 181.99, and carries a 0.02 span
   * elsewhere in its own history). The amount PROPOSED is always the exact
   * figure from the split, never the walk's, so this slack never reaches a
   * journal — it only decides whether we understand the span well enough to act.
   */
  gapTol?: number
}): WorkedEntryDiagnosis | null {
  const TOL = o.tol ?? 0.02
  const maxLookback = o.maxLookback ?? 12

  // 1. What did the accountant's entry put on Interest Expense, at source?
  const atSource = r2(Math.abs(
    (o.lines || [])
      .filter((l) => String(l.c ?? '') === String(o.interestCode))
      .reduce((s, l) => s + Number(l.a || 0), 0),
  ))
  // No interest line means this is some other shape of hand-edit. Not ours.
  if (atSource < TOL) return null

  // 2. The schedule of interest by month, oldest first, up to the payment's own
  //    period. Only splits carrying a real interest figure can be components.
  const sched = (o.splits || [])
    .filter((s) => s.interest_amount != null && Number(s.interest_amount) > 0)
    .filter((s) => String(s.period_label) <= String(o.paymentPeriod))
    .sort((a, b) => String(a.period_label).localeCompare(String(b.period_label)))

  const own = sched[sched.length - 1]
  const owed = own && String(own.period_label) === String(o.paymentPeriod) ? r2(Number(own.interest_amount)) : 0

  // 3. Decompose: walk BACKWARD from the payment's own month. A catch-up
  //    allocation covers consecutive arrears — it does not cherry-pick months.
  //    Arbitrary subset-sum would find a match in almost any schedule by
  //    coincidence; a consecutive run ending at this payment is the only shape
  //    that means anything.
  let components: DiagnosisComponent[] | null = null
  let run = 0
  for (let i = sched.length - 1, steps = 0; i >= 0 && steps < maxLookback; i--, steps++) {
    run = r2(run + Number(sched[i].interest_amount))
    if (Math.abs(run - atSource) < TOL) {
      components = sched.slice(i).map((s) => {
        const by = bookedBy(s)
        return {
          period: String(s.period_label),
          interest: r2(Number(s.interest_amount)),
          already_booked: by !== null,
          booked_by: by,
          journal_id: s.xero_manual_journal_id ?? null,
        }
      })
      break
    }
    if (run > atSource + TOL) break // overshot; no consecutive run can match
  }

  const base = { at_source: atSource, owed, components, duplicated: 0, carry_over: null, entry: null }

  if (!components) {
    return {
      ...base,
      shape: 'undecomposable',
      note: `Your accountant split this payment herself, putting ${money(atSource)} on Interest Expense. `
        + `This loan's own schedule says ${o.paymentPeriod} owes ${money(owed)}, and the difference does not `
        + `resolve into a run of consecutive months — so the engine cannot say what the extra covers. `
        + `Left for her; nothing here is proposed.`,
      note_working: '',
    }
  }

  // ── SESSION 236: what the span's gap is actually made of ─────────────────
  //
  // The first version of this file assumed her whole at-source interest figure
  // showed up as this span's gap. The live 4140 run proved otherwise, and the
  // decomposition below is read straight off that walk:
  //
  //   payment 2026-06-17, coded 242=764.44 / 800=415.88, should be 1047.51/132.81
  //   415.88  =  Apr 147.43  +  May 135.64  +  Jun 132.81
  //   span 2026-05-28 -> 2026-06-17 gap  =  +283.07  =  Apr + May  ONLY
  //   Jun's 132.81 surfaces two spans earlier, as a timing-pair residue, because
  //   the journal that double-booked it (12ef542c) is dated 2026-05-18
  //
  // So the months divide into two kinds with different meanings:
  //
  //   FOREIGN  months other than the payment's own. Their interest has no business
  //            on this payment at all, so ALL of it lands in this span's gap --
  //            whether or not it was ever booked elsewhere.
  //   OWN      the payment's own month. Its interest BELONGS on this payment, so it
  //            is not in the gap. It is only a duplicate if a separate JOURNAL also
  //            booked it -- and then it shows up wherever that journal is dated.
  //
  // Note the asymmetry on the own month: `already_in_xero` there means she split
  // THIS payment, which is the booking we are looking at, not a second one. Only
  // `our_journal` makes the own month a duplicate.
  const ownComp = components.find((c) => c.period === String(o.paymentPeriod)) ?? null
  const foreign = components.filter((c) => c !== ownComp)

  // Corroborate every FOREIGN at-source claim before it is allowed to count as a
  // prior booking (see `atSourceEvidence`). A claim that fails is downgraded in
  // place, so carry_over and the note pick it up automatically and the month is
  // reported as never booked rather than silently reversed.
  for (const c of foreign) {
    if (c.booked_by !== 'at_source') continue
    const corroborated = !!o.atSourceEvidence && o.atSourceEvidence(c.interest, c.period)
    if (!corroborated) {
      c.already_booked = false
      c.booked_by = 'at_source_unverified'
    }
  }
  const foreignSum = r2(foreign.reduce((s, c) => s + c.interest, 0))
  const ownDuplicated = !!ownComp && ownComp.booked_by === 'our_journal'

  // Reversible = foreign months that were already booked (their interest is on this
  // payment AND booked in their own month) + the own month when a journal doubled it.
  // A foreign month that was NEVER booked is a legitimate catch-up: her allocation is
  // the only correction it ever got, and reversing it would re-break that month.
  const foreignBooked = foreign.filter((c) => c.already_booked)
  const already = [...foreignBooked, ...(ownDuplicated ? [ownComp!] : [])]
  const duplicated = r2(already.reduce((s, c) => s + c.interest, 0))
  const monthList = components.map((c) => `${c.period} ${money(c.interest)}`).join(' + ')

  if (duplicated < TOL) {
    return {
      ...base,
      shape: 'no_duplication',
      duplicated: 0,
      // The month-by-month figures are the table directly below this note; the
      // note states only what the table cannot (s279).
      note: `Your accountant's ${money(atSource)} interest split covers the ${components.length} month${components.length === 1 ? '' : 's'} below. `
        + `None of it was booked anywhere else, so nothing is double-counted and there is nothing to propose.`,
      note_working: `Her split covers ${monthList}. No reallocation journal on our side books any of it, and none `
        + `is marked as handled directly in Xero — so her entry is the only correction these months have had.`,
    }
  }

  const describe = (c: DiagnosisComponent) => c.booked_by === 'our_journal'
    ? `${c.period} by journal ${shortId(c.journal_id)}`
    : `${c.period} handled directly in Xero`
  const journalList = already.map(describe).join(', ')
  const notBooked = foreign.filter((c) => !c.already_booked)
  const unverified = notBooked.filter((c) => c.booked_by === 'at_source_unverified')
  const carryOver = r2(foreignSum - r2(foreignBooked.reduce((s, c) => s + c.interest, 0)))
  const partial = notBooked.length > 0

  // ── THE SAFETY BELT ───────────────────────────────────────────────────────
  // What we expect this span's gap to be, from the decomposition above: every
  // foreign month, plus the own month ONLY when its doubling journal is dated
  // inside this span. If the walk disagrees, something else is moving here too and
  // the engine has no business proposing an entry it cannot fully account for.
  const expectedGap = r2(foreignSum + (ownDuplicated && o.ownJournalInSpan ? (ownComp?.interest ?? 0) : 0))
  const tiesToGap = Math.abs(Math.abs(o.gap) - expectedGap) < (o.gapTol ?? 0.05)
  if (!tiesToGap) {
    return {
      ...base,
      shape: partial ? 'partly_duplicated' : 'duplicated_reallocation',
      duplicated,
      note: `Her ${money(atSource)} split should leave this span off by ${money(expectedGap)} — the walk says `
        + `${money(o.gap)}. Something else is moving here too, so nothing is proposed. This one is hers.`,
      note_working: `Her split covers ${monthList}. ${money(foreignSum)} of that belongs to other months, which is `
        + `where the expected ${money(expectedGap)} comes from. The engine will not propose an entry it cannot `
        + `fully account for.`,
    }
  }

  // ── The entry. Reverse exactly what was booked twice -- which is NOT always
  //    what this span's gap is. On 4140 the gap is $283.07 and the correction is
  //    $415.88, because June's duplicate is real but sits in a different span. ──
  const amount = duplicated
  const direction: 'interest_back_to_loan' | 'interest_out_of_loan' =
    o.gap > 0 ? 'interest_back_to_loan' : 'interest_out_of_loan'
  const sign = direction === 'interest_back_to_loan' ? 1 : -1
  const JournalLines = [
    { LineAmount: r2(sign * amount), AccountCode: o.loanCode, Description: `${o.loanName} — reverse duplicated interest allocation`, TaxType: 'NONE' as const },
    { LineAmount: r2(-sign * amount), AccountCode: o.interestCode, Description: `Interest already booked (${already.map((c) => c.period).join(', ')})`, TaxType: 'NONE' as const },
  ]

  const beyondSpan = r2(amount - expectedGap)
  return {
    shape: partial ? 'partly_duplicated' : 'duplicated_reallocation',
    at_source: atSource,
    owed,
    components,
    duplicated,
    carry_over: partial ? { amount: carryOver, months: notBooked.map((c) => c.period) } : null,
    entry: {
      amount,
      direction,
      date: o.postingDate,
      dated_because: o.postingWhy,
      Narration: `${o.loanName} — reverse duplicated interest allocation (${already.map((c) => c.period).join(', ')})`,
      Date: o.postingDate,
      Status: 'POSTED',
      JournalLines,
    },
    // ── session 279: A CLAIM IS STATED ONCE PER SCREEN ──────────────────────
    // Everything below the first sentence used to be visible prose sitting
    // directly above the table, the carry-over box and the prepared entry that
    // each state the same thing again. The claims are unchanged and none is
    // dropped; they moved to the surface that already owns them:
    //   month-by-month interest ......... the components table's own rows
    //   which journal booked each one ... that table's "Already booked" column
    //   the carry-over months ........... the carry-over box (client)
    //   the entry's date and why ........ the prepared-correction block (client)
    //   everything else ................. note_working, behind Show the working
    // The decision figure and the fact her entry is untouched stay visible,
    // because they are the decision.
    // The figure is the table footer's ("Her split, at source"), and "her entry
    // is not touched" is the prepared block's own heading. Neither is repeated
    // here; this states the one thing neither of them says (s279).
    note: `She split it herself, across the `
      + `month${components.length === 1 ? '' : 's'} below. `
      + (Math.abs(duplicated - atSource) < TOL
        ? `Every one of them was already booked, so the whole split is counted twice.`
        : `${money(duplicated)} of it was already booked, so that much is counted twice.`),
    note_working: `Her split is ${monthList}, against ${money(owed)} that this period actually owes. `
      + `${money(duplicated)} of it was already booked once before (${journalList}). `
      + (partial
        ? `The other ${money(carryOver)} (${notBooked.map((c) => c.period).join(', ')}) had never been booked at all — `
          + `her split is the only correction ${notBooked.length === 1 ? 'that month has' : 'those months have'} had, so it stays; `
          + `reversing it would re-break the ${notBooked.length === 1 ? 'month' : 'months'} it just fixed. `
          + (unverified.length
            ? `(${unverified.map((c) => c.period).join(', ')} ${unverified.length === 1 ? 'is' : 'are'} marked as handled in Xero on our side, but no `
              + `separate transaction actually books ${unverified.length === 1 ? 'it' : 'them'} — so the marker looks like a note about this very `
              + `payment, and ${unverified.length === 1 ? 'it is' : 'they are'} treated as never booked.) `
            : '')
        : '')
      + (Math.abs(beyondSpan) >= TOL
        ? `This span is only off by ${money(o.gap)}: ${money(beyondSpan)} of the correction answers a duplicate `
          + `that surfaces in a different span, because the journal that made it is dated outside this one. `
        : '')
      + `The correction is a separate journal for ${money(amount)}; nothing posts until it is approved.`,
  }
}
