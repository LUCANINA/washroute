// _shared/resolve-scope.ts -- which check types "examined this run" excuses the
// window guard in reconciliation-run's resolve block (session 253).
//
// `examinedSrcIds` (built in reconciliation-run/index.ts from allEntries /
// relevantChangedOld -- see the SESSION 252 comment there) says a Xero object's
// CURRENT state was actually read this run, regardless of its own date. That only
// means a finding is safe to auto-resolve for the check whose own raise logic is
// satisfied by that one object alone.
//
// `bank_transaction_id` is written into finding `detail` by THREE places, not the
// one session 252's fix assumed (it grepped reconciliation-run/index.ts only, and
// double-reallocation.ts is a separate module): lumpedFinding (index.ts), and
// checkDoubleReallocation's double_reallocation and split_collision findings
// (double-reallocation.ts). The latter two need their PAIRED manual journal
// examined too before checkDoubleReallocation can say anything about them -- see
// its own "outside the loaded window; say nothing" bail when either half of the
// pair isn't in this run's ledger. A transaction-only "examined" is therefore not
// evidence those checks were actually re-verified, and treating it as such risks
// auto-resolving a real double-count in the database without the check ever having
// confirmed it was fixed -- a worse failure than the stale-recycling bug session
// 252 fixed, because it makes a real problem silently disappear instead of a fixed
// one linger.
//
// Lives in its own module, not inline in reconciliation-run/index.ts, for the same
// reason double-reallocation.ts does: index.ts calls Deno.serve() at import time,
// so nothing inside it can be unit-tested directly. See resolve-scope.test.ts.
export function isExaminedForResolve(checkKey: string, bankTransactionId: unknown, examinedSrcIds: Set<string>): boolean {
  if (!String(checkKey || '').startsWith('lumped_payment')) return false
  const txnId = String(bankTransactionId || '')
  return txnId !== '' && examinedSrcIds.has(txnId)
}
