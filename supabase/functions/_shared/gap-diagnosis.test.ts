// Session 253 (item 13b): does diagnoseUnexplainedGap actually find the leads it's
// supposed to, and stay silent (return null, changing nothing) when it shouldn't?
// The PCV Good and Green Loan case David gave is test 1 below, reconstructed from
// the real numbers in the session 253 log entry.
import { assertEquals } from "jsr:@std/assert"
import { diagnoseUnexplainedGap } from "./gap-diagnosis.ts"

Deno.test("PCV Good and Green Loan shape: residual matches that date's scheduled interest", () => {
  const result = diagnoseUnexplainedGap(
    -1802.58,
    [{ date: "2026-08-04" }],
    [{ row_date: "2026-08-04", interest: 1802.58, principal: 5335.52 }],
    [],
  )
  assertEquals(result, { kind: "schedule_interest", date: "2026-08-04", scheduled_amount: 1802.58 })
})

Deno.test("a residual matching scheduled PRINCIPAL (not interest) is found too", () => {
  const result = diagnoseUnexplainedGap(
    -5335.52,
    [{ date: "2026-08-04" }],
    [{ row_date: "2026-08-04", interest: 1802.58, principal: 5335.52 }],
    [],
  )
  assertEquals(result, { kind: "schedule_principal", date: "2026-08-04", scheduled_amount: 5335.52 })
})

Deno.test("a schedule row on an UNRELATED date does not count as a match, even if the dollar amount lines up", () => {
  const result = diagnoseUnexplainedGap(
    -1802.58,
    [{ date: "2026-08-04" }],
    [{ row_date: "2026-09-04", interest: 1802.58, principal: 5335.52 }], // wrong month
    [],
  )
  assertEquals(result, null)
})

Deno.test("no schedule match, but an open sibling finding dated on the same later-entry date -- falls back to the weaker sibling lead", () => {
  const result = diagnoseUnexplainedGap(
    -1802.58,
    [{ date: "2026-08-04" }],
    [{ row_date: "2026-08-04", interest: 999.99, principal: 4000.00 }], // doesn't match
    [{ check_key: "lumped_payment", title: "Some Loan — 2026-08-04 payment of $5,335.52 has no interest split", detail: { date: "2026-08-04" } }],
  )
  assertEquals(result, { kind: "sibling_finding", date: "2026-08-04", check_key: "lumped_payment", title: "Some Loan — 2026-08-04 payment of $5,335.52 has no interest split" })
})

Deno.test("schedule match takes precedence over a sibling finding when both are present", () => {
  const result = diagnoseUnexplainedGap(
    -1802.58,
    [{ date: "2026-08-04" }],
    [{ row_date: "2026-08-04", interest: 1802.58, principal: 5335.52 }],
    [{ check_key: "lumped_payment", title: "irrelevant", detail: { date: "2026-08-04" } }],
  )
  assertEquals(result?.kind, "schedule_interest")
})

Deno.test("a sibling finding dated OUTSIDE the later-entry dates is not used -- date has to be real, not coincidental", () => {
  const result = diagnoseUnexplainedGap(
    -1802.58,
    [{ date: "2026-08-04" }],
    [],
    [{ check_key: "lumped_payment", title: "irrelevant", detail: { date: "2026-09-15" } }],
  )
  assertEquals(result, null)
})

Deno.test("nothing lines up -- returns null, which is what keeps the existing generic sentence unchanged", () => {
  const result = diagnoseUnexplainedGap(
    -1802.58,
    [{ date: "2026-08-04" }],
    [{ row_date: "2026-08-04", interest: 42.00, principal: 100.00 }],
    [{ check_key: "double_reallocation", title: "irrelevant", detail: { date: "2026-07-01" } }],
  )
  assertEquals(result, null)
})

Deno.test("no later entries at all -- returns null immediately, never scans anything", () => {
  const result = diagnoseUnexplainedGap(
    -1802.58,
    [],
    [{ row_date: "2026-08-04", interest: 1802.58, principal: 5335.52 }],
    [],
  )
  assertEquals(result, null)
})

Deno.test("a zero residual returns null (nothing to diagnose, checkBalanceVsLender never calls this for a tie anyway)", () => {
  const result = diagnoseUnexplainedGap(0, [{ date: "2026-08-04" }], [], [])
  assertEquals(result, null)
})

Deno.test("the sign of the residual doesn't matter -- only the size", () => {
  const positive = diagnoseUnexplainedGap(1802.58, [{ date: "2026-08-04" }], [{ row_date: "2026-08-04", interest: 1802.58 }], [])
  const negative = diagnoseUnexplainedGap(-1802.58, [{ date: "2026-08-04" }], [{ row_date: "2026-08-04", interest: 1802.58 }], [])
  assertEquals(positive?.kind, "schedule_interest")
  assertEquals(negative?.kind, "schedule_interest")
})
