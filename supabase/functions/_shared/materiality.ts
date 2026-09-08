// ═══════════════════════════════════════════════════════════════════════════
// materiality.ts — WHEN IS A DIFFERENCE TOO SMALL TO BE WORTH CHASING?
// (session 284; the policy itself is older, this is only its new home)
// ═══════════════════════════════════════════════════════════════════════════
// One difference, two ceilings, and BOTH must be crossed before it counts as
// material: an absolute floor, so a trivial sum on a small loan is not chased,
// and a share of the balance, so $30 on a $960,000 loan is not treated like $30
// on a $3,000 one. Either test alone gets one of those two cases wrong.
//
// ── WHY THIS MOVED HERE, AND WHAT THAT DOES NOT FIX ────────────────────────
// It lived in reconciliation-run and was mirrored by hand into
// admin-dashboard/index.html, because a no-build SPA cannot import from this
// tree. That mirror still exists and still says "change one, change both".
//
// What moving it prevents is a THIRD copy. Session 284 gave the write-off action
// a hard ceiling and deliberately reused this policy rather than inventing a
// number for it -- a second server-side threshold, drifting from the first,
// would mean the figure the close band greys out and the figure a person is
// allowed to write off could disagree, and nothing on screen would say which was
// which. So loan-find-difference imports this rather than restating it.
//
// ⚠️ AN IMMATERIAL DIFFERENCE IS DE-ESCALATED, NEVER HIDDEN. The figure is
// printed, in grey, and it does not block a close. This function decides how
// loudly to say something, never whether to say it.

export const MATERIAL_FLOOR = 25       // dollars
export const MATERIAL_SHARE = 0.0025   // 0.25% of the balance being checked

export function isMaterialGap(residual: number, lenderBalance: number | null): { material: boolean; share: number } {
  const lender = Math.abs(Number(lenderBalance ?? 0))
  // No balance to compare against means we cannot judge proportion, so share is
  // 1 -- the pessimistic reading, which lets the floor alone decide. Failing
  // towards "material" keeps an unjudgeable difference visible.
  const share = lender > 0 ? Math.abs(residual) / lender : 1
  return { material: Math.abs(residual) >= MATERIAL_FLOOR && share >= MATERIAL_SHARE, share }
}
