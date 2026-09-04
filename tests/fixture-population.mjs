/* tests/fixture-population.mjs — "did this pull actually return anything?"
 *
 * Session 268. Pure, and separated from refresh-bookkeeping-fixture.mjs for the
 * same reason _shared/existing-deposit.ts is pure: a decision embedded in a
 * script that needs a live database and a privileged side-car cannot be tested,
 * and this one destroyed the live fixture once already.
 *
 * The defect it replaces: `ORDER.filter(k => !fixture[k])`. `[]` is truthy, so
 * a pull that returned zero rows for every table passed the check and was
 * written over the good fixture, with a success message. Presence is not
 * population.
 */

export const SHRINK_LIMIT = 0.20;

/**
 * @param {object|null} previous  the fixture already on disk, or null on a first run
 * @param {object} pulled         what we just fetched
 * @param {string[]} order        the table names to check
 * @returns {{ok: boolean, emptied: string[], shrank: string[], rows: object[]}}
 *
 * `emptied` is ABSOLUTE — a table that had rows and came back with none is a
 * broken connection, and no caller flag may override it. `shrank` is advisory:
 * real deletions happen, but rarely, and a partial pull is indistinguishable
 * from one until a person looks.
 */
export function populationVerdict(previous, pulled, order, { shrinkLimit = SHRINK_LIMIT } = {}) {
  const rows = order.map(k => {
    const was = Array.isArray(previous?.[k]) ? previous[k].length : 0;
    const now = Array.isArray(pulled?.[k]) ? pulled[k].length : 0;
    return { table: k, was, now };
  });
  // No previous fixture: nothing to compare against, so nothing can be judged.
  // Deliberately permissive — refusing here would make a first run impossible —
  // and the script says out loud that it wrote unchecked.
  if (!previous) return { ok: true, emptied: [], shrank: [], rows };

  const emptied = rows.filter(r => r.was > 0 && r.now === 0).map(r => r.table);
  const shrank = rows.filter(r => r.was > 0 && r.now > 0 && (r.was - r.now) / r.was > shrinkLimit)
    .map(r => r.table);
  return { ok: emptied.length === 0 && shrank.length === 0, emptied, shrank, rows };
}
