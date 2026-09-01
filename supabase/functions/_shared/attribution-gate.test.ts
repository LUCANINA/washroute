// Does the gate actually stop the three wrong calls of 2026-09-01?
//
// Every case below is built from the REAL numbers of that day, and each pair is
// written to discriminate: the failing shape must refuse, and the corresponding sound
// shape must pass. A test that only ever asserts refusal proves nothing — a gate that
// refuses everything would pass it.
import { assert, assertEquals } from "jsr:@std/assert"
import { gate, lintMotive, factualSentence, HABIT_PATTERNS, type LedgerEntry } from "./attribution-gate.ts"

// ── The real entries of 2026-09-01 ──────────────────────────────────────────

/** PCV's 2026-08-03 payment: ALREADY split at source. */
const PCV_TXN: LedgerEntry = {
  id: 'ec50f278-0129-46f2-b4de-3cf9e8c4144e', date: '2026-08-03', kind: 'BankTransaction',
  lines: [{ account: '254', amount: 5335.52 }, { account: '800', amount: 1802.58 }],
}
/** And David's 2026-08-31 journal that split it AGAIN. */
const PCV_JNL: LedgerEntry = {
  id: 'd1347f7c-1629-4c5c-9b04-25884ccc3c02', date: '2026-08-31', kind: 'ManualJournal',
  lines: [{ account: '800', amount: 1802.58 }, { account: '254', amount: -1802.58 }],
  narration: 'To split out August 2026 PCV loan interest expense [PCV-AUG2026-INTEREST-SPLIT]',
}
/** PayPal's 2026-07-31 journal. */
const PP_JNL: LedgerEntry = {
  id: 'a2c49ead-3c5c-4bf0-a343-9cbfa657f271', date: '2026-07-31', kind: 'ManualJournal',
  lines: [{ account: '284', amount: 3142.26 }, { account: '800', amount: -3142.26 }],
  narration: 'To reclass the payment made for paypal',
}
/** E4-9744's 2026-05-11 payment — the entry that actually carries the defect. */
const E4_TXN: LedgerEntry = {
  id: '30886184-e137-42be-8b8c-7fe2dc2a1aa6', date: '2026-05-11', kind: 'BankTransaction',
  lines: [{ account: '244', amount: 793.81 }, { account: '800', amount: 350.74 }],
}

// ── A1: no decomposition without an attributed entry ────────────────────────

Deno.test("A1 — E4-9744: $182.00 matching April's scheduled interest, with NO entry, is refused", () => {
  const r = gate({
    pattern: 'unsplit_payment', proposed: 'probable', amount: 182.00, code: '244',
    entry: null, // this is exactly what the real error had: a number, and no entry
    sentence: "The gap is the size of April's scheduled interest ($181.99).",
  })
  assertEquals(r.confidence, 'unresolved')
  assert(r.refusals.includes('no_attributed_entry'))
  assertEquals(r.proposedCorrection, null)
})

Deno.test("A1 discriminates — the SAME claim, once the May entry that carries it is attached, passes", () => {
  const r = gate({
    pattern: 'unsplit_payment', proposed: 'probable', amount: 350.74, code: '244',
    entry: E4_TXN,
    sentence: factualSentence({
      entryKind: 'BankTransaction', entryDate: '2026-05-11',
      accountName: 'E-Transit Loan E4 -9744', moved: 793.81, expected: 975.78,
    }),
    proposedCorrection: { amount: 181.97, description: 'Re-split the 2026-05-11 payment.' },
  })
  assertEquals(r.refusals, [])
  assertEquals(r.confidence, 'probable')
  assertEquals(r.evidence.corroboration, 'line_amount')
  assert(r.proposedCorrection !== null)
})

// ── A2: the entry's own lines, fetched ──────────────────────────────────────

Deno.test("A2 — lines NOT READ (null) is fatal, however plausible the claim", () => {
  const r = gate({
    pattern: 'double_reallocation', proposed: 'confirmed', amount: 1802.58, code: '254',
    entry: { ...PCV_JNL, lines: null },
    sentence: 'A journal dated 2026-08-31 moved $1,802.58 against account 254.',
  })
  assertEquals(r.confidence, 'unresolved')
  assert(r.refusals.includes('entry_lines_unread'))
  assertEquals(r.evidence.lines_read, false)
})

Deno.test("A2 — an EMPTY line list is not the same as unread: it refuses on corroboration, not on reading", () => {
  const r = gate({
    pattern: 'double_reallocation', proposed: 'confirmed', amount: 1802.58, code: '254',
    entry: { ...PCV_JNL, lines: [] },
    sentence: 'A journal dated 2026-08-31 moved $1,802.58 against account 254.',
  })
  assertEquals(r.confidence, 'unresolved')
  assertEquals(r.evidence.lines_read, true)
  assert(r.refusals.includes('amount_not_in_entry'))
  assert(!r.refusals.includes('entry_lines_unread'))
})

Deno.test("A2 — an amount the entry's lines do NOT carry is refused", () => {
  const r = gate({
    pattern: 'double_reallocation', proposed: 'confirmed', amount: 999.99, code: '254',
    entry: PCV_JNL,
    sentence: 'A journal dated 2026-08-31 moved $999.99 against account 254.',
  })
  assertEquals(r.confidence, 'unresolved')
  assert(r.refusals.includes('amount_not_in_entry'))
})

Deno.test("A2 discriminates — PCV's real double reallocation, both halves read, is CONFIRMED", () => {
  const r = gate({
    pattern: 'double_reallocation', proposed: 'confirmed', amount: 1802.58, code: '254',
    entry: PCV_JNL,
    sentence: 'The 2026-08-03 payment is split at source ($5,335.52 / $1,802.58) and this '
      + 'journal splits $1,802.58 again, so the interest is counted twice.',
    proposedCorrection: { amount: 1802.58, description: 'Reverse journal d1347f7c.' },
  })
  assertEquals(r.refusals, [])
  assertEquals(r.confidence, 'confirmed')
  assert(r.proposedCorrection !== null)
})

Deno.test("A2 — account_net corroboration: the amount is the NET of several lines on the loan account", () => {
  const split: LedgerEntry = {
    id: 'x', date: '2026-08-03', kind: 'ManualJournal',
    // Deliberately NO single line equal to 1802.58 — otherwise this would pass via
    // `line_amount` and never exercise the net path at all.
    lines: [
      { account: '254', amount: 1000 }, { account: '254', amount: 802.58 },
      { account: '800', amount: -1000 }, { account: '800', amount: -802.58 },
    ],
  }
  const r = gate({
    pattern: 'double_reallocation', proposed: 'confirmed', amount: 1802.58, code: '254',
    entry: split, sentence: 'A journal dated 2026-08-03 moved $1,802.58 against account 254.',
  })
  assertEquals(r.refusals, [])
  assertEquals(r.evidence.corroboration, 'account_net')
})

// ── A3: a habit must generalise ─────────────────────────────────────────────

Deno.test("A3 — PayPal: the plug verdict, with June's journal NOT matching any anchor, is downgraded", () => {
  const r = gate({
    pattern: 'plug_to_wrong_date_anchor', proposed: 'confirmed', amount: 3142.26, code: '284',
    entry: PP_JNL,
    siblings: [
      { id: '5351abb3', date: '2026-06-30', satisfiesPattern: false }, // June matches no anchor
      { id: 'a8bbccca', date: '2026-05-31', satisfiesPattern: false },
    ],
    sentence: 'This journal brought account 284 to the lender’s 2026-08-05 balance.',
  })
  assertEquals(r.confidence, 'unresolved')
  assert(r.refusals.includes('habit_does_not_generalise'))
})

Deno.test("A3 — a habit pattern with no siblings supplied at all is refused, not assumed", () => {
  const r = gate({
    pattern: 'plug_to_wrong_date_anchor', proposed: 'confirmed', amount: 3142.26, code: '284',
    entry: PP_JNL,
    sentence: 'This journal brought account 284 to the lender’s 2026-08-05 balance.',
  })
  assertEquals(r.confidence, 'unresolved')
  assert(r.refusals.includes('habit_untested'))
})

Deno.test("A3 discriminates — if a sibling DOES satisfy the pattern, the plug verdict stands", () => {
  const r = gate({
    pattern: 'plug_to_wrong_date_anchor', proposed: 'confirmed', amount: 3142.26, code: '284',
    entry: PP_JNL,
    siblings: [{ id: '5351abb3', date: '2026-06-30', satisfiesPattern: true }],
    sentence: 'This journal brought account 284 to the lender’s 2026-08-05 balance.',
  })
  assertEquals(r.refusals, [])
  assertEquals(r.confidence, 'confirmed')
})

Deno.test("A3 — single-event patterns are exempt: no siblings needed", () => {
  assert(!HABIT_PATTERNS.has('double_reallocation'))
  assert(!HABIT_PATTERNS.has('unsplit_payment'))
  const r = gate({
    pattern: 'double_reallocation', proposed: 'confirmed', amount: 1802.58, code: '254',
    entry: PCV_JNL, sentence: 'A journal dated 2026-08-31 moved $1,802.58 against account 254.',
  })
  assertEquals(r.refusals, [])
})

// ── A4: never motive ────────────────────────────────────────────────────────

Deno.test("A4 — the exact sentence that was wrong on PayPal is caught", () => {
  const hits = lintMotive(
    'She forced account 284 to equal a portal balance she was reading, and the balance '
    + 'she was reading was the lender’s 2026-08-05 figure.')
  assert(hits.length > 0, 'the PayPal motive sentence must be caught')
})

Deno.test("A4 — a motive sentence is WITHHELD, not shipped, and the verdict is weakened", () => {
  const r = gate({
    pattern: 'double_reallocation', proposed: 'confirmed', amount: 1802.58, code: '254',
    entry: PCV_JNL,
    sentence: 'The CPA intended to split the interest and did not realise it was already split.',
  })
  assert(r.violations.length > 0)
  assert(!r.sentence.includes('intended'))
  assert(r.sentence.includes('withheld'))
  assertEquals(r.confidence, 'probable') // lowered from confirmed, not passed through
})

Deno.test("A4 — naming a person FACTUALLY is allowed; only intent is banned", () => {
  assertEquals(lintMotive('Journal d1347f7c was posted by Ramona on 2026-08-31.'), [])
  assertEquals(lintMotive('The CPA’s own split on the 2026-06-17 payment carries three months of interest.'), [])
  assertEquals(lintMotive('The 2026-08-03 payment was posted in full to the loan account.'), [])
})

Deno.test("A4 — factualSentence never trips its own lint", () => {
  const s = factualSentence({
    entryKind: 'ManualJournal', entryDate: '2026-07-31', accountName: 'Paypal 2',
    moved: 3142.26, expected: 0,
  })
  assertEquals(lintMotive(s), [])
  assert(s.includes('$3,142.26'))
})

// ── The gate's own invariant ────────────────────────────────────────────────

Deno.test("the gate can only ever LOWER confidence, never raise it", () => {
  const r = gate({
    pattern: 'double_reallocation', proposed: 'probable', amount: 1802.58, code: '254',
    entry: PCV_JNL, sentence: 'A journal dated 2026-08-31 moved $1,802.58 against account 254.',
  })
  assertEquals(r.confidence, 'probable') // passed everything, still only what was claimed
})

Deno.test("a refused verdict never carries a correction anyone could post", () => {
  const r = gate({
    pattern: 'unsplit_payment', proposed: 'confirmed', amount: 182.00, code: '244',
    entry: null,
    sentence: 'The gap is the size of April’s scheduled interest.',
    proposedCorrection: { amount: 181.99, description: 'Post an interest correction.' },
  })
  assertEquals(r.proposedCorrection, null)
})
