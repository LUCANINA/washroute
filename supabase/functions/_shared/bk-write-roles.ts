// bk-write-roles.ts — WHO MAY WRITE IN BOOKKEEPING (session 289, David)
//
// ONE list, imported by every Bookkeeping edge function that guards a write.
//
// David, session 289: "remove the read-only part. The CPA needs to be able to
// post from the Bookkeeping section." Before this, the CPA could run every
// preview and was stopped at the confirm -- the product asked her to do the
// reading and then handed the work back to somebody else.
//
// WHY A MODULE RATHER THAN EDITING THE ARRAYS
// The answer used to be written out ~70 times across three layers. Session 231's
// rule -- a guard is only as good as the branch it sits on -- cannot be enforced
// against 70 copies: the next permission change means auditing all of them, and
// one missed branch is a silent hole. loan-find-difference's own header comment
// already worried about exactly this ("a role simply not appearing in an array
// someone may widen later").
//
// THE OTHER TWO LAYERS CARRY THE SAME LIST:
//   * database — public.can_write_bookkeeping()   (migration session_289_*)
//   * dashboard — BK_WRITE_ROLES / _bkCanWrite()  (admin-dashboard/index.html)
// Change one, change all three. A button the page shows but the function refuses
// is a 403 nobody can explain.
//
// ⚠️ `internal_job` IS DELIBERATELY NOT HERE and must never be added. The nightly
// jobs authenticate on the shared secret and may run analyze only; their refusal
// is stated explicitly at the point where the write paths converge (session 261),
// precisely so that widening this list cannot hand a write path to a cron job.
export const BK_WRITE_ROLES = ['admin', 'manager', 'cpa'] as const;

export function canWriteBookkeeping(role: string | null | undefined): boolean {
  return !!role && (BK_WRITE_ROLES as readonly string[]).includes(role);
}
