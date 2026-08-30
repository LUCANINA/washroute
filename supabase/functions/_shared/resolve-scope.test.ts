// Session 253: does "this transaction was re-examined this run" only excuse the
// window guard for the check it was built for (lumped_payment*)? bank_transaction_id
// is written into finding detail by THREE places (lumpedFinding in
// reconciliation-run/index.ts, plus checkDoubleReallocation's double_reallocation
// and split_collision in double-reallocation.ts) -- session 252's fix assumed one
// writer. If this scoping were removed, a double_reallocation or split_collision
// finding whose transaction happened to be re-pulled for an unrelated reason could
// get marked "resolved" without the double-count ever actually being re-verified.
import { assertEquals } from "jsr:@std/assert"
import { isExaminedForResolve } from "./resolve-scope.ts"

Deno.test("a lumped_payment finding whose transaction was re-examined counts as examined", () => {
  const examined = new Set(["txn-1"])
  assertEquals(isExaminedForResolve("lumped_payment", "txn-1", examined), true)
})

Deno.test("the missing-prior-statement lumped_payment variant also counts (startsWith match)", () => {
  const examined = new Set(["txn-1"])
  assertEquals(isExaminedForResolve("lumped_payment_missing_prior_statement", "txn-1", examined), true)
})

Deno.test("a double_reallocation finding on the SAME re-examined transaction does NOT count -- this is the bug session 253 fixed", () => {
  const examined = new Set(["txn-1"])
  assertEquals(isExaminedForResolve("double_reallocation", "txn-1", examined), false)
})

Deno.test("a split_collision finding on the same transaction does NOT count either", () => {
  const examined = new Set(["txn-1"])
  assertEquals(isExaminedForResolve("split_collision", "txn-1", examined), false)
})

Deno.test("a lumped_payment finding whose transaction was NOT re-examined stays false", () => {
  const examined = new Set(["some-other-txn"])
  assertEquals(isExaminedForResolve("lumped_payment", "txn-1", examined), false)
})

Deno.test("no bank_transaction_id on the finding at all (e.g. balance_vs_lender) is always false", () => {
  const examined = new Set(["txn-1"])
  assertEquals(isExaminedForResolve("lumped_payment", undefined, examined), false)
  assertEquals(isExaminedForResolve("balance_vs_lender", "txn-1", examined), false)
})
