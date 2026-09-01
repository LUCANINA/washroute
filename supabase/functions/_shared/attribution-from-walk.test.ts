// Fixtures are the REAL loan-find-difference output for E-Transit E4-9744, pulled from
// the live dashboard on 2026-09-01. Nothing here is invented.
import { assert, assertEquals } from "jsr:@std/assert"
import { attributionFromWalk, type WalkResponse } from "./attribution-from-walk.ts"

/** Verbatim from the live walk, 2026-09-01. */
const E4_EXCEPTION = {
  period: { from: '2026-04-19', to: '2026-05-09' },
  split_period: '2026-05',
  entry: {
    src_type: 'BankTransaction' as const,
    id: '30886184-e137-42be-8b8c-7fe2dc2a1aa6',
    date: '2026-05-11',
    total: 1144.55,
    effect_on_loan: -793.81,
    lines: [{ account_code: '244', amount: 793.81 }, { account_code: '800', amount: 350.74 }],
  },
  diagnosis: { shape: 'duplicated_reallocation', at_source: 350.74, owed: 168.77, duplicated: 181.99 },
}
const base: WalkResponse = {
  ok: true,
  loan: { id: '5e2ebcdb', name: 'E-Transit Loan E4 -9744', code: '244' },
  periods: [
    { from: '2026-03-19', to: '2026-04-19', diff: 0, verdict: 'clean' },
    { from: '2026-04-19', to: '2026-05-09', diff: 181.97, verdict: 'divergent' },
  ],
  cpa_exception: E4_EXCEPTION,
}

Deno.test("the short-circuit response is detected before anything else is read", () => {
  const r = attributionFromWalk({ verdict: 'not_enough_history' } as WalkResponse)
  assertEquals(r.notEnoughHistory, true)
  assertEquals(r.verdicts, [])
})

Deno.test("LIVE GAP — a BankTransaction claim refuses today, because the walk omits Xero's txn type", () => {
  // This is the real current behaviour and it is correct: without the type the gate
  // cannot verify the DIRECTION of the entry's effect, and a verdict it cannot check
  // must not ship. When entryView gains `txn_type`, the next test is what passes.
  const r = attributionFromWalk(base)
  const v = r.verdicts[0]
  assertEquals(v.confidence, 'unresolved')
  assert(v.refusals.includes('entry_direction_unknown'))
  assert(v.sentence.includes('is not explained'))
  assertEquals(v.proposedCorrection, null)
})

Deno.test("DISCRIMINATES — with `txn_type` present, the same real data yields a CONFIRMED verdict", () => {
  const withType: WalkResponse = {
    ...base,
    cpa_exception: { ...E4_EXCEPTION, entry: { ...E4_EXCEPTION.entry, txn_type: 'SPEND' } },
  }
  const v = attributionFromWalk(withType).verdicts[0]
  assertEquals(v.refusals, [])
  assertEquals(v.confidence, 'confirmed')
  assertEquals(v.pattern, 'multi_month_interest')
  // The gate DERIVED the responsibility from primary fields: effect −793.81 against an
  // expected −(1144.55 − 168.77) = −975.78.
  assertEquals(v.amount, 181.97)
  assertEquals(v.evidence.computed_effect, -793.81)
  assertEquals(v.evidence.expected_on_account, -975.78)
  assertEquals(v.period, { from: '2026-04-19', to: '2026-05-09' })
})

Deno.test("the derived amount is INDEPENDENT of the walk's own `duplicated` figure", () => {
  // The walk says duplicated = 181.99; the gate derives 181.97 from entry.total and
  // diagnosis.owed. Two cents apart, from two different routes — which is the point:
  // had the adapter simply trusted `duplicated`, this check could never disagree.
  const withType: WalkResponse = {
    ...base,
    cpa_exception: { ...E4_EXCEPTION, entry: { ...E4_EXCEPTION.entry, txn_type: 'SPEND' } },
  }
  const v = attributionFromWalk(withType).verdicts[0]
  assertEquals(E4_EXCEPTION.diagnosis.duplicated, 181.99)
  assertEquals(v.amount, 181.97)
  assert(v.amount !== E4_EXCEPTION.diagnosis.duplicated)
})

Deno.test("a ManualJournal needs no txn type and passes on the same shape", () => {
  const mj: WalkResponse = {
    ok: true, loan: { id: 'x', name: 'Paypal 2', code: '284' },
    periods: [{
      from: '2026-07-01', to: '2026-07-31', diff: -3142.26, verdict: 'divergent',
      culprit: {
        kind: 'extra_entry',
        entry: {
          src_type: 'ManualJournal', id: 'a2c49ead', date: '2026-07-31',
          effect_on_loan: -3142.26,
          lines: [{ account_code: '284', amount: 3142.26 }, { account_code: '800', amount: -3142.26 }],
        },
      },
    }],
  }
  const v = attributionFromWalk(mj).verdicts[0]
  assertEquals(v.refusals, [])
  assertEquals(v.pattern, 'extra_entry')
  assertEquals(v.evidence.computed_effect, -3142.26)
})

Deno.test("a divergent span with NO culprit entry yields an unresolved verdict that still states the arithmetic", () => {
  const noCulprit: WalkResponse = {
    ok: true, loan: { id: 'x', name: 'Ford 4140', code: '242' },
    periods: [{ from: '2026-05-01', to: '2026-06-01', diff: 283.07, verdict: 'divergent', culprit: { kind: 'missing_reduction', amount: 283.07 } }],
  }
  const v = attributionFromWalk(noCulprit).verdicts[0]
  assertEquals(v.confidence, 'unresolved')
  assert(v.refusals.includes('no_attributed_entry'))
  assert(v.sentence.includes('is not explained'))
})

Deno.test("clean, timing-pair and exception-covered spans are skipped with a stated reason", () => {
  const s: WalkResponse = {
    ok: true, loan: { id: 'x', name: 'L', code: '1' },
    periods: [
      { from: 'a', to: 'b', diff: 0, verdict: 'clean' },
      { from: 'c', to: 'd', diff: 100, verdict: 'divergent', timing_pair: { role: 'first' } },
      { from: 'e', to: 'f', diff: 100, verdict: 'divergent', explained_by_exception: true },
    ],
  }
  const r = attributionFromWalk(s)
  assertEquals(r.verdicts.length, 0)
  assertEquals(r.skipped.map(x => x.reason), ['clean', 'timing, not an error', 'covered by the exception above'])
})

Deno.test("a PROPOSED journal is never used as evidence — only real ledger lines reach the gate", () => {
  // proposal.journal.JournalLines uses LineAmount/AccountCode and is our own suggestion.
  // The adapter reads `lines` (account_code/amount) and nothing else, so a response
  // carrying only a proposal produces no verdict at all rather than a self-corroborated one.
  const proposalOnly = {
    ok: true, loan: { id: 'x', name: 'L', code: '254' },
    periods: [],
    proposal: { journal: { JournalLines: [{ LineAmount: 1802.58, AccountCode: '254' }] } },
  } as unknown as WalkResponse
  assertEquals(attributionFromWalk(proposalOnly).verdicts.length, 0)
})

Deno.test("entry lines that were not read produce a refusal, not a confident verdict", () => {
  const unread: WalkResponse = {
    ...base,
    cpa_exception: { ...E4_EXCEPTION, entry: { ...E4_EXCEPTION.entry, txn_type: 'SPEND', lines: null } },
  }
  const v = attributionFromWalk(unread).verdicts[0]
  assert(v.refusals.includes('entry_lines_unread'))
  assertEquals(v.evidence.lines_read, false)
})

Deno.test("every verdict this module emits is gate-branded — nothing bypasses it", () => {
  const withType: WalkResponse = {
    ...base,
    cpa_exception: { ...E4_EXCEPTION, entry: { ...E4_EXCEPTION.entry, txn_type: 'SPEND' } },
  }
  const r = attributionFromWalk(withType)
  assert(r.verdicts.length > 0)
  for (const v of r.verdicts) assertEquals(v.gated, true)
})

// ── Regressions from the first live run over all 14 loans (session 259 cont. 9) ──

/** Verbatim: PayPal 2's 2026-02-28 month-end journal, as the walk reports it. */
const PP_ADJ_SPAN = {
  from: '2026-02-18', to: '2026-02-25', diff: -2544.96, verdict: 'divergent' as const,
  culprit: {
    kind: 'extra_entry',
    entry: {
      src_type: 'ManualJournal' as const, id: 'b0b4a203-10b6-4946-8372-c7966c50879d',
      date: '2026-02-28', total: null, effect_on_loan: -2544.96,
      lines: [{ account_code: '284', amount: 2544.96 }, { account_code: '800', amount: -2544.96 }],
    },
  },
}
const PP_WALK: WalkResponse = {
  ok: true, loan: { id: 'f3aa83c5', name: 'Paypal 2', code: '284' }, periods: [PP_ADJ_SPAN],
}

Deno.test("LIVE — an entry already on file in our own splits is NOT accused of being extra", () => {
  const r = attributionFromWalk(PP_WALK, { recordedEntryIds: new Map([['b0b4a203-10b6-4946-8372-c7966c50879d', 2544.96]]) })
  assertEquals(r.verdicts.length, 0)
  assertEquals(r.skipped[0].reason, 'already recorded in our own splits, at the same amount')
  assertEquals(r.skipped[0].entryId, 'b0b4a203-10b6-4946-8372-c7966c50879d')
})

Deno.test("DISCRIMINATES — the same journal, NOT on file, does produce a verdict", () => {
  const r = attributionFromWalk(PP_WALK)
  assertEquals(r.verdicts.length, 1)
  assertEquals(r.verdicts[0].pattern, 'extra_entry')
  assertEquals(r.verdicts[0].confidence, 'probable')
  assertEquals(r.verdicts[0].evidence.computed_effect, -2544.96)
})

Deno.test("LIVE — a `no_duplication` diagnosis is skipped outright, not turned into a zero claim", () => {
  // PCV's real exception: the entry was examined and found sound (duplicated: 0).
  const pcv: WalkResponse = {
    ok: true, loan: { id: 'ad5dd55d', name: 'PCV Good and Green Loan', code: '254' }, periods: [],
    cpa_exception: {
      period: { from: '2025-11-01', to: '2025-12-01' }, split_period: '2025-12-01',
      entry: {
        src_type: 'BankTransaction', txn_type: 'SPEND', id: 'd02e14a9', date: '2025-12-01',
        total: 7138.1, effect_on_loan: -5160.96,
        lines: [{ account_code: '254', amount: 5160.96 }, { account_code: '800', amount: 1977.14 }],
      },
      diagnosis: { shape: 'no_duplication', at_source: 1977.14, owed: 1977.14, duplicated: 0 },
    },
  }
  assertEquals(attributionFromWalk(pcv).verdicts.length, 0)
})

Deno.test("DISCRIMINATES — a duplicated_reallocation on the same shape DOES produce a verdict", () => {
  const dup: WalkResponse = {
    ...base,
    cpa_exception: { ...E4_EXCEPTION, entry: { ...E4_EXCEPTION.entry, txn_type: 'SPEND' } },
  }
  // `base` also carries a divergent span with no culprit, which correctly yields its
  // own unresolved verdict — so assert on the pattern, not on the count.
  const pats = attributionFromWalk(dup).verdicts.map(v => v.pattern)
  assert(pats.includes('multi_month_interest'), pats.join(','))
})

// ── v3 regressions: the three severe audit findings ─────────────────────────

Deno.test("SEVERE 2 — a third line on the payment makes `expected` underivable, not inflated", () => {
  // A $50 bank fee turned $181.97 of duplicated interest into $231.97, at `confirmed`.
  // The sum-vs-total check could never catch it: the fee is inside the total too.
  const withFee: WalkResponse = { ...base, cpa_exception: { ...E4_EXCEPTION, entry: {
    ...E4_EXCEPTION.entry, txn_type: 'SPEND', total: 1194.55,
    lines: [...E4_EXCEPTION.entry.lines, { account_code: '404', amount: 50 }] } } }
  const v = attributionFromWalk(withFee).verdicts[0]
  assertEquals(v.confidence, 'unresolved')
  assert(v.refusals.includes('expected_not_derivable'), JSON.stringify(v.refusals))
})

Deno.test("SEVERE 2 — the 'covers more than' clause is only stated when it is true", () => {
  const odd: WalkResponse = { ...base, cpa_exception: { ...E4_EXCEPTION,
    entry: { ...E4_EXCEPTION.entry, txn_type: 'SPEND' },
    diagnosis: { shape: 'duplicated_reallocation', at_source: 0, owed: 500, duplicated: 0 } } }
  const v = attributionFromWalk(odd).verdicts[0]
  assert(!v.sentence.includes('covers more'), v.sentence)
})

Deno.test("SEVERE 3 — a culprit whose effect does NOT equal the gap is not accused", () => {
  const mismatch: WalkResponse = { ok: true, loan: { id: 'x', name: 'PP', code: '284' },
    periods: [{ from: '2026-07-01', to: '2026-07-31', diff: -1000, verdict: 'divergent',
      culprit: { kind: 'extra_entry', entry: { src_type: 'ManualJournal', id: 'a2', date: '2026-07-31',
        effect_on_loan: -3142.26,
        lines: [{ account_code: '284', amount: 3142.26 }, { account_code: '800', amount: -3142.26 }] } } }] }
  const r = attributionFromWalk(mismatch)
  assertEquals(r.verdicts.length, 0)
  assert(r.skipped[0].reason.includes('does not equal'))
})

Deno.test("SEVERE 3 discriminates — when it DOES equal the gap, expected is 0, not moved-minus-diff", () => {
  const match: WalkResponse = { ok: true, loan: { id: 'x', name: 'PP', code: '284' },
    periods: [{ from: '2026-07-01', to: '2026-07-31', diff: -3142.26, verdict: 'divergent',
      culprit: { kind: 'extra_entry', entry: { src_type: 'ManualJournal', id: 'a2', date: '2026-07-31',
        effect_on_loan: -3142.26,
        lines: [{ account_code: '284', amount: 3142.26 }, { account_code: '800', amount: -3142.26 }] } } }] }
  const v = attributionFromWalk(match).verdicts[0]
  assertEquals(v.refusals, [])
  assertEquals(v.evidence.expected_on_account, 0)
  assertEquals(v.amount, -3142.26)
})

Deno.test("FINDING 5 — an entry on file at a DIFFERENT amount is still reported", () => {
  const w: WalkResponse = { ok: true, loan: { id: 'x', name: 'L', code: '254' },
    periods: [{ from: 'a', to: 'b', diff: -5000, verdict: 'divergent',
      culprit: { kind: 'duplicate_suspected', entry: { src_type: 'BankTransaction', txn_type: 'SPEND',
        id: 'bt', date: 'd', total: 5000, effect_on_loan: -5000,
        lines: [{ account_code: '254', amount: 5000 }] } } }] }
  assertEquals(attributionFromWalk(w, { recordedEntryIds: new Map([['bt', 5000]]) }).verdicts.length, 0)
  assertEquals(attributionFromWalk(w, { recordedEntryIds: new Map([['bt', 1234]]) }).verdicts.length, 1)
})

Deno.test("SEVERE 2 — loan + FEE with no interest line is underivable, though it is two lines", () => {
  // The isolating case for the account-identity half of the shape guard. Two lines, one
  // genuinely on the loan account — so the gate's own `account_not_on_entry` cannot help
  // — but the second is a fee, not interest. `-(total - owed)` would silently treat the
  // fee as principal. Found because mutation M5 survived a weaker fixture.
  const loanPlusFee: WalkResponse = { ...base, cpa_exception: { ...E4_EXCEPTION, entry: {
    ...E4_EXCEPTION.entry, txn_type: 'SPEND', total: 1144.55,
    lines: [{ account_code: '244', amount: 793.81 }, { account_code: '404', amount: 350.74 }] } } }
  const v = attributionFromWalk(loanPlusFee).verdicts[0]
  assertEquals(v.confidence, 'unresolved')
  assert(v.refusals.includes('expected_not_derivable'), JSON.stringify(v.refusals))
})
