// Does the gate stop the three wrong calls of 2026-09-01 — AND the four bugs the
// adversarial review found in the gate's own first version?
//
// Every fixture is a real entry from that day. Every rule has a DISCRIMINATING PAIR:
// the failing shape refuses and the sound shape passes. A gate that refused everything
// would fail half of these.
import { assert, assertEquals } from "jsr:@std/assert"
import {
  gate, lintMotive, factualSentence, computeEffect, PATTERNS, type LedgerEntry,
} from "./attribution-gate.ts"

// ── Real entries, 2026-09-01 ────────────────────────────────────────────────

/** PCV's 2026-08-03 payment — ALREADY split at source. SPEND: balance falls. */
const PCV_TXN: LedgerEntry = {
  id: 'ec50f278', date: '2026-08-03', kind: 'BankTransaction', txnType: 'SPEND',
  lines: [{ account: '254', amount: 5335.52 }, { account: '800', amount: 1802.58 }],
}
/** The 2026-08-31 journal that split it AGAIN: credit 254, so the balance RISES. */
const PCV_JNL: LedgerEntry = {
  id: 'd1347f7c', date: '2026-08-31', kind: 'ManualJournal',
  lines: [{ account: '800', amount: 1802.58 }, { account: '254', amount: -1802.58 }],
}
/** PayPal's 2026-07-31 journal: debit 284, so the balance FALLS by 3,142.26. */
const PP_JNL: LedgerEntry = {
  id: 'a2c49ead', date: '2026-07-31', kind: 'ManualJournal',
  lines: [{ account: '284', amount: 3142.26 }, { account: '800', amount: -3142.26 }],
}
/** E4-9744's 2026-05-11 payment: reduced 244 by 793.81, should have been 975.78. */
const E4_TXN: LedgerEntry = {
  id: '30886184', date: '2026-05-11', kind: 'BankTransaction', txnType: 'SPEND',
  lines: [{ account: '244', amount: 793.81 }, { account: '800', amount: 350.74 }],
}

const ok = (over: Partial<Parameters<typeof gate>[0]> = {}) => gate({
  pattern: 'unsplit_payment', proposed: 'probable', code: '244',
  movedOnAccount: -793.81, expectedOnAccount: -975.78, entry: E4_TXN,
  sentence: 'A payment dated 2026-05-11 reduced the loan by $793.81.',
  ...over,
} as any)

// ── The effect calculation itself ───────────────────────────────────────────

Deno.test("computeEffect: SPEND against a liability REDUCES it (negative)", () => {
  assertEquals(computeEffect(PCV_TXN, '254'), -5335.52)
})
Deno.test("computeEffect: a CREDIT journal line on a liability RAISES it (positive)", () => {
  assertEquals(computeEffect(PCV_JNL, '254'), 1802.58)
})
Deno.test("computeEffect: a DEBIT journal line on a liability REDUCES it (negative)", () => {
  assertEquals(computeEffect(PP_JNL, '284'), -3142.26)
})
Deno.test("computeEffect: RECEIVE is a draw, not a payment — opposite sign", () => {
  assertEquals(computeEffect({ ...PCV_TXN, txnType: 'RECEIVE' }, '254'), 5335.52)
})
Deno.test("computeEffect: refuses rather than guesses when a BankTransaction has no type", () => {
  assertEquals(computeEffect({ ...PCV_TXN, txnType: undefined }, '254'), null)
})

// ── REGRESSION: the four bugs the review found in gate v1 ───────────────────

Deno.test("REGRESSION v1-bug-1 — a claim about an account the entry never touches is refused", () => {
  // v1 returned `confirmed` here: PayPal's 284 'corroborated' by a PCV entry, because
  // the 800 line happened to equal the claimed amount.
  const r = gate({
    pattern: 'unsplit_payment', proposed: 'confirmed', code: '284',
    movedOnAccount: -1802.58, expectedOnAccount: 0, entry: PCV_TXN, sentence: 'x',
  })
  assertEquals(r.confidence, 'unresolved')
  assert(r.refusals.includes('account_not_on_entry'))
})

Deno.test("REGRESSION v1-bug-2 — a SIGN-FLIPPED measurement is refused", () => {
  // The journal RAISES 254 by 1802.58. Claiming it lowered it must not pass.
  const wrong = gate({
    pattern: 'double_reallocation', proposed: 'confirmed', code: '254',
    movedOnAccount: -1802.58, expectedOnAccount: 0, entry: PCV_JNL, sentence: 'x',
  })
  assertEquals(wrong.confidence, 'unresolved')
  assert(wrong.refusals.includes('measurement_disagrees_with_entry'))

  const right = gate({
    pattern: 'double_reallocation', proposed: 'confirmed', code: '254',
    movedOnAccount: 1802.58, expectedOnAccount: 0, entry: PCV_JNL,
    sentence: 'A journal dated 2026-08-31 increased the loan by $1,802.58.',
  })
  assertEquals(right.confidence, 'confirmed')
  assertEquals(right.refusals, [])
  assertEquals(right.evidence.computed_effect, 1802.58)
})

Deno.test("REGRESSION v1-bug-3 — a $0.00 / immaterial claim is refused", () => {
  const r = gate({
    pattern: 'unsplit_payment', proposed: 'confirmed', code: '254',
    movedOnAccount: -5335.52, expectedOnAccount: -5335.52, entry: PCV_TXN, sentence: 'x',
  })
  assertEquals(r.confidence, 'unresolved')
  assert(r.refusals.includes('immaterial_claim'))
})

Deno.test("REGRESSION v1-bug-4 — an UNREGISTERED pattern is refused, not silently ungated", () => {
  const r = gate({
    pattern: 'plug_to_month_end', proposed: 'confirmed', code: '284',
    movedOnAccount: -3142.26, expectedOnAccount: 0, entry: PP_JNL, sentence: 'x',
  })
  assertEquals(r.confidence, 'unresolved')
  assert(r.refusals.includes('unregistered_pattern'))
})

Deno.test("REGRESSION — a refused verdict never asserts the attribution it refused", () => {
  const r = gate({
    pattern: 'double_reallocation', proposed: 'confirmed', code: '254',
    movedOnAccount: 1802.58, expectedOnAccount: 0,
    entry: { ...PCV_JNL, lines: null }, sentence: 'x',
  })
  assert(r.sentence.includes('is not explained'))
  assert(!r.sentence.includes('accounts for'))
})

// ── A1 ──────────────────────────────────────────────────────────────────────

Deno.test("A1 — E4-9744's $182 with NO entry is refused", () => {
  const r = ok({ entry: null, movedOnAccount: -182, expectedOnAccount: 0 })
  assertEquals(r.confidence, 'unresolved')
  assert(r.refusals.includes('no_attributed_entry'))
  assertEquals(r.proposedCorrection, null)
})

Deno.test("A1 discriminates — the same defect, once the May entry is attached, passes", () => {
  const r = ok({ proposedCorrection: { amount: 181.97, description: 'Re-split the 2026-05-11 payment.' } })
  assertEquals(r.refusals, [])
  assertEquals(r.confidence, 'probable')
  assertEquals(r.amount, 181.97)          // DERIVED by the gate: -793.81 - (-975.78)
  assertEquals(r.evidence.computed_effect, -793.81)
  assert(r.proposedCorrection !== null)
})

// ── A2 ──────────────────────────────────────────────────────────────────────

Deno.test("A2 — lines NOT READ (null) is fatal", () => {
  const r = ok({ entry: { ...E4_TXN, lines: null } })
  assertEquals(r.confidence, 'unresolved')
  assert(r.refusals.includes('entry_lines_unread'))
  assertEquals(r.evidence.lines_read, false)
})

Deno.test("A2 — lines MISSING (undefined) is also 'not read', not 'read and empty'", () => {
  const { lines: _drop, ...noLines } = E4_TXN
  const r = ok({ entry: noLines as LedgerEntry })
  assert(r.refusals.includes('entry_lines_unread'))
  assertEquals(r.evidence.lines_read, false)
})

Deno.test("A2 — a BankTransaction with no txnType refuses rather than assuming SPEND", () => {
  const r = ok({ entry: { ...E4_TXN, txnType: null } })
  assertEquals(r.confidence, 'unresolved')
  assert(r.refusals.includes('entry_direction_unknown'))
})

Deno.test("A2 — a measurement that disagrees with the entry's own lines is refused", () => {
  const r = ok({ movedOnAccount: -800.00 })   // real effect is -793.81
  assertEquals(r.confidence, 'unresolved')
  assert(r.refusals.includes('measurement_disagrees_with_entry'))
})

Deno.test("A2 — the 2-cent tolerance holds, and holds at awkward magnitudes", () => {
  assertEquals(ok({ movedOnAccount: -793.79 }).refusals, [])   // 2c under
  assertEquals(ok({ movedOnAccount: -793.83 }).refusals, [])   // 2c over
  assert(ok({ movedOnAccount: -793.84 }).refusals.includes('measurement_disagrees_with_entry'))
})

// ── A3 ──────────────────────────────────────────────────────────────────────

Deno.test("A3 — PayPal's plug verdict: 1 of 7 sibling journals conform, so it does not generalise", () => {
  const r = gate({
    pattern: 'plug_to_wrong_date_anchor', proposed: 'confirmed', code: '284',
    movedOnAccount: -3142.26, expectedOnAccount: 0, entry: PP_JNL,
    habit: { considered: 7, satisfied: 1 },
    sentence: 'This journal brought account 284 to a lender figure.',
  })
  assertEquals(r.confidence, 'unresolved')
  assert(r.refusals.includes('habit_single_instance'))
})

Deno.test("A3 — no habit evidence at all is refused, not assumed", () => {
  const r = gate({
    pattern: 'plug_to_wrong_date_anchor', proposed: 'confirmed', code: '284',
    movedOnAccount: -3142.26, expectedOnAccount: 0, entry: PP_JNL, sentence: 'x',
  })
  assert(r.refusals.includes('habit_untested'))
})

Deno.test("A3 — a minority of conforming siblings is not a habit", () => {
  const r = gate({
    pattern: 'plug_to_wrong_date_anchor', proposed: 'confirmed', code: '284',
    movedOnAccount: -3142.26, expectedOnAccount: 0, entry: PP_JNL,
    habit: { considered: 7, satisfied: 2 }, sentence: 'x',
  })
  assert(r.refusals.includes('habit_does_not_generalise'))
})

Deno.test("A3 discriminates — a real habit (6 of 7) passes", () => {
  const r = gate({
    pattern: 'plug_to_wrong_date_anchor', proposed: 'confirmed', code: '284',
    movedOnAccount: -3142.26, expectedOnAccount: 0, entry: PP_JNL,
    habit: { considered: 7, satisfied: 6 },
    sentence: 'Six of this loan’s seven month-end journals close to a lender figure.',
  })
  assertEquals(r.refusals, [])
  assertEquals(r.confidence, 'confirmed')
})

Deno.test("A3 — single-event patterns need no habit evidence", () => {
  assertEquals(PATTERNS['double_reallocation'].habit, false)
  assertEquals(PATTERNS['plug_to_anchor'].habit, true)
})

// ── A4 ──────────────────────────────────────────────────────────────────────

Deno.test("A4 — the exact sentence that was wrong on PayPal is caught", () => {
  assert(lintMotive('She forced account 284 to equal a portal balance she was reading.').length > 0)
})

Deno.test("A4 — the phrasings that evaded the first lint are caught now", () => {
  const evasions = [
    'The journal was posted to make account 284 agree with the portal balance.',
    'The journal was posted so that the balance would tie to the lender statement.',
    'The intent was to bring 284 to the lender’s 2026-08-05 figure.',
    'The purpose of this journal was to hide the unreconciled difference.',
    'The previous bookkeeper wanted the account to look clean before year-end.',
    'The CPA never checked whether the 2026-08-03 payment was already split.',
    'The CPA overlooked the source split and posted a second one anyway.',
    'The journal appears to have been an attempt to force a match.',
    'Whoever posted it wanted the loan to tie to the portal.',
  ]
  for (const s of evasions) assert(lintMotive(s).length > 0, `not caught: ${s}`)
})

Deno.test("A4 — factual accounting language is NOT caught (the false positives are gone)", () => {
  const fine = [
    'Any correcting journal must have an offsetting credit to account 800.',
    'The reversing entry must have the same date as the original.',
    'Journal d1347f7c was posted by Ramona on 2026-08-31.',
    'The CPA’s own split on the 2026-06-17 payment carries three months of interest.',
    'The 2026-08-03 payment was posted in full to the loan account.',
    'The two journals net account 254 and 800 to zero.',
  ]
  for (const s of fine) assertEquals(lintMotive(s), [], `false positive: ${s}`)
})

Deno.test("A4 — the CORRECTION DESCRIPTION is linted too, not just the sentence", () => {
  const r = ok({
    sentence: 'A payment dated 2026-05-11 reduced the loan by $793.81.',
    proposedCorrection: { amount: 181.97, description: 'Reverse it — the CPA intended to split interest she had already split.' },
  })
  assert(r.violations.length > 0)
  assertEquals(r.proposedCorrection, null)   // a fabricated motive forfeits the correction
  assertEquals(r.confidence, 'unresolved')   // probable -> weaker
})

Deno.test("A4 — a motive sentence is WITHHELD, not shipped", () => {
  const r = ok({ proposed: 'confirmed', sentence: 'The CPA intended to split the interest.' })
  assert(!r.sentence.includes('intended'))
  assert(r.sentence.includes('withheld'))
  assertEquals(r.confidence, 'probable')
})

Deno.test("A4 — factualSentence never trips its own lint, in either direction", () => {
  for (const moved of [-3142.26, 3142.26]) {
    const s = factualSentence({ entryKind: 'ManualJournal', entryDate: '2026-07-31', accountName: 'Paypal 2', moved, expected: 0 })
    assertEquals(lintMotive(s), [])
  }
})

// ── Contract invariants ─────────────────────────────────────────────────────

Deno.test("the gate can only LOWER confidence, never raise it", () => {
  assertEquals(ok({ proposed: 'probable' }).confidence, 'probable')
})

Deno.test("an unrecognised confidence from a JSON caller is refused, not passed through", () => {
  const r = ok({ proposed: 'certain' as any })
  assertEquals(r.confidence, 'unresolved')
  assert(r.refusals.includes('invalid_proposed_confidence'))
})

Deno.test("NaN / Infinity measurements refuse", () => {
  assert(ok({ movedOnAccount: NaN }).refusals.includes('amount_not_finite'))
  assert(ok({ movedOnAccount: Infinity }).refusals.includes('amount_not_finite'))
})

Deno.test("a refused verdict never carries a correction anyone could post", () => {
  const r = ok({ entry: null, proposedCorrection: { amount: 181.99, description: 'Post it.' } })
  assertEquals(r.proposedCorrection, null)
})

Deno.test("every result is branded as gated, so a hand-built verdict cannot pose as one", () => {
  assertEquals(ok().gated, true)
})
