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
  reallocated: boolean
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
  /** Of `at_source`, how much is already covered by a recorded journal. */
  duplicated: number
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
  /** One paragraph a human reads. Always present. */
  note: string
}

const r2 = (n: number) => Math.round(n * 100) / 100
const money = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** A split's journal counts as evidence only when the split actually reached Xero. */
const REACHED_XERO = new Set(['posted', 'already_in_xero', 'staged'])
const wasReallocated = (s: DiagSplit) =>
  !!s.xero_manual_journal_id && REACHED_XERO.has(String(s.status ?? 'posted').toLowerCase())

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
      components = sched.slice(i).map((s) => ({
        period: String(s.period_label),
        interest: r2(Number(s.interest_amount)),
        reallocated: wasReallocated(s),
        journal_id: s.xero_manual_journal_id ?? null,
      }))
      break
    }
    if (run > atSource + TOL) break // overshot; no consecutive run can match
  }

  const base = { at_source: atSource, owed, components, duplicated: 0, entry: null }

  if (!components) {
    return {
      ...base,
      shape: 'undecomposable',
      note: `Your accountant split this payment herself, putting ${money(atSource)} on Interest Expense. `
        + `This loan's own schedule says ${o.paymentPeriod} owes ${money(owed)}, and the difference does not `
        + `resolve into a run of consecutive months — so the engine cannot say what the extra covers. `
        + `Left for her; nothing here is proposed.`,
    }
  }

  const already = components.filter((c) => c.reallocated)
  const duplicated = r2(already.reduce((s, c) => s + c.interest, 0))
  const monthList = components.map((c) => `${c.period} ${money(c.interest)}`).join(' + ')

  if (duplicated < TOL) {
    return {
      ...base,
      shape: 'no_duplication',
      duplicated: 0,
      note: `Your accountant's ${money(atSource)} interest split covers ${components.length} month${components.length === 1 ? '' : 's'} `
        + `(${monthList}). None of them carries a reallocation journal on our side, so her entry is the only correction `
        + `these months have had — nothing is double-counted and there is nothing to propose.`,
    }
  }

  const journalList = already.map((c) => `${c.period} by journal ${shortId(c.journal_id)}`).join(', ')
  const partial = duplicated < atSource - TOL

  // 4. The safety belt. The proposed entry has to close the span's gap to the
  //    cent. If the arithmetic of "what was corrected twice" does not equal
  //    what the walk actually observes, something else is also going on and the
  //    engine has no business proposing a journal — it reports and stops.
  const tiesToGap = Math.abs(Math.abs(o.gap) - duplicated) < TOL
  if (!tiesToGap || partial) {
    return {
      ...base,
      shape: partial ? 'partly_duplicated' : 'duplicated_reallocation',
      duplicated,
      note: `Your accountant's ${money(atSource)} interest split covers ${monthList}. `
        + `${money(duplicated)} of that was ALREADY reallocated on our side (${journalList}) — counted twice. `
        + (tiesToGap
          ? `The rest of her split (${money(r2(atSource - duplicated))}) has no journal behind it, so the two halves need `
            + `different answers and the engine will not guess: this is hers to decide.`
          : `That does not equal this span's ${money(o.gap)} gap, so something else is moving here too — `
            + `the engine will not propose an entry it cannot fully account for.`),
    }
  }

  // 5. Reverse exactly the duplicated amount. Direction from the gap's sign, the
  //    same convention the walk uses everywhere: gap > 0 means Xero's balance
  //    sits ABOVE the lender's, so the loan account comes down (debit) and
  //    Interest Expense gives the duplicate back (credit).
  const amount = duplicated
  const direction: 'interest_back_to_loan' | 'interest_out_of_loan' =
    o.gap > 0 ? 'interest_back_to_loan' : 'interest_out_of_loan'
  const sign = direction === 'interest_back_to_loan' ? 1 : -1
  const JournalLines = [
    { LineAmount: r2(sign * amount), AccountCode: o.loanCode, Description: `${o.loanName} — reverse duplicated interest allocation`, TaxType: 'NONE' as const },
    { LineAmount: r2(-sign * amount), AccountCode: o.interestCode, Description: `Interest already reallocated (${already.map((c) => c.period).join(', ')})`, TaxType: 'NONE' as const },
  ]

  return {
    shape: 'duplicated_reallocation',
    at_source: atSource,
    owed,
    components,
    duplicated,
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
    note: `Your accountant split this payment herself, putting ${money(atSource)} on Interest Expense — that is `
      + `${monthList}. All ${already.length} of those months had ALREADY been reallocated on our side (${journalList}), `
      + `so the same interest is booked twice and the loan sits ${money(o.gap)} above the lender. `
      + `Her entry stays exactly as it is; the correction is a separate journal for ${money(amount)}, dated ${o.postingDate} `
      + `(${o.postingWhy}). Nothing posts until it is approved.`,
  }
}
