// ── READ EVERY ROW, OR REFUSE ──────────────────────────────────────────────
// PostgREST answers a select with at most `max-rows` rows (1,000 on this
// project) and says nothing when it truncates: the caller gets a shorter
// array, no error, no flag. Session 246 put a count check on
// reconciliation-run's amortization read for exactly that reason, and on
// 2026-09-22 the check fired for real — 1,081 anchor rows against the cap, so
// the schedule chosen for a loan and the balance answering a date were both
// being picked from a partial set, every night, silently.
//
// A count check is a smoke alarm, not a fix. This is the fix: ask for the rows
// a page at a time until a short page proves the end was reached.
//
// TWO PROPERTIES MATTER, AND BOTH ARE LOAD-BEARING:
//
// 1. THE QUERY MUST CARRY A TOTAL ORDER. Paging is `.range(from, to)` over
//    whatever order the server chose, so an order with ties (or none at all)
//    can hand back one row twice and skip another between pages. Every caller
//    ends its `.order()` chain with a unique column — `id` — and this module
//    cannot check that for you, so it is the one thing to get right at the
//    call site.
//
// 2. A FAILED PAGE IS NEVER A SHORTER ANSWER. An error mid-walk means the rows
//    already collected are a partial set wearing a complete set's clothes,
//    which is the precise failure this file exists to end. It throws. The
//    caller's run fails loudly and reports why, rather than closing a month on
//    a subset.
export const PAGE_SIZE = 1000

// A page-at-a-time read of one PostgREST query.
//
// `makeQuery(from, to)` must build the query afresh each call — a Supabase
// query builder is single-use, so reusing one across pages throws rather than
// paging.
//
//   const rows = await fetchAllPaged('loan_splits', (from, to) =>
//     supa.from('loan_splits').select('*').order('id', { ascending: true }).range(from, to))
//
// `maxPages` is a runaway guard, not a limit anyone should reach: 200 pages is
// 200,000 rows, far beyond anything this book holds. Hitting it means the walk
// is not terminating (a non-unique order is the usual cause), so it throws too.
export async function fetchAllPaged<T = any>(
  label: string,
  makeQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? PAGE_SIZE
  const maxPages = opts.maxPages ?? 200
  const out: T[] = []
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize
    const { data, error } = await makeQuery(from, from + pageSize - 1)
    if (error) {
      throw new Error(
        `${label}: page ${page + 1} failed after ${out.length} row(s) — ${error.message || error}. ` +
        `Refusing to continue on a partial read.`)
    }
    const rows = data ?? []
    out.push(...rows)
    // A short page is the end of the table. A full one might be, but the only
    // way to know is to ask again — an exact multiple of the page size costs
    // one extra empty read and buys certainty.
    if (rows.length < pageSize) return out
  }
  throw new Error(
    `${label}: still reading after ${maxPages} pages (${out.length} rows). ` +
    `The query's order is probably not unique, so pages are repeating.`)
}
