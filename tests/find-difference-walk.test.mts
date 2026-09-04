// tests/find-difference-walk.test.mts — the REAL analyzeWalk, not a copy (session 272)
//
// WHY THIS FILE LOADS THE SHIPPED SOURCE INSTEAD OF RESTATING IT
// -------------------------------------------------------------
// Session 245's most expensive finding was that tests/loan-roster.test.mts held
// *copies* of the dashboard functions it claimed to test — fifty-two green
// assertions proving a copy agreed with itself. `analyzeWalk` is the single most
// consequential pure function in this module (it decides what a human is told to
// go and fix), it is 440 lines long, and it lives inside a Deno server file that
// cannot simply be imported. Transcribing it would repeat exactly that mistake at
// four times the size.
//
// So this loader takes the real supabase/functions/loan-find-difference/index.ts,
// strips its types with node's own stripper, and neutralises the only three things
// that stop it being an ordinary ES module:
//
//   * `import "jsr:.../edge-runtime.d.ts"` — a types-only import, dropped.
//   * `createClient` / `getXeroAuth` — never called on any path this file
//     exercises; replaced with throwing stubs, so if a future edit DID reach for
//     the network here, this test fails loudly rather than quietly passing.
//   * `Deno.serve(...)` at the bottom — the one top-level side effect. A shimmed
//     global swallows it. `Deno.env.get` is only ever called inside the stubs above.
//
// `close-date.ts` and `diagnose-exception.ts` are the REAL modules, imported by
// absolute file URL. Nothing about the walk's arithmetic, its span logic, its
// close-date gate or its conclusions is re-implemented here.
//
// Run:  node --experimental-strip-types tests/find-difference-walk.test.mts

import { stripTypeScriptTypes } from 'node:module'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

const FN_DIR = new URL('../supabase/functions/loan-find-difference/', import.meta.url)
const SHARED = new URL('../supabase/functions/_shared/', import.meta.url)

// ── the loader ──────────────────────────────────────────────────────────────
// `mutate` lets a test re-load the module with a surgical change to the SHIPPED
// source, which is how we prove an assertion discriminates: apply the INVERSE of
// the fix and watch the assertion go red. The repo file is never written to.
async function loadWalk(mutate?: (src: string) => string) {
  let src = readFileSync(new URL('index.ts', FN_DIR), 'utf8')
  if (mutate) {
    const before = src
    src = mutate(src)
    if (src === before) throw new Error('mutation did not apply — the anchor text has moved')
  }
  src = src
    .replace(/^import "jsr:@supabase\/functions-js\/edge-runtime\.d\.ts"\s*$/m, '')
    .replace(/^import \{ createClient \} from "jsr:@supabase\/supabase-js@2"\s*$/m,
      `const createClient = () => { throw new Error('createClient must not be reached in the walk') }`)
    .replace(/^import \{ getXeroAuth \} from '\.\.\/_shared\/xero-auth\.ts'\s*$/m,
      `const getXeroAuth = () => { throw new Error('getXeroAuth must not be reached in the walk') }`)
    .replace(/from '\.\.\/_shared\/close-date\.ts'/, `from '${new URL('close-date.ts', SHARED).href}'`)
    // session 273 cont.: the statement-date basis rule lives in _shared too, and
    // it is loaded for real -- a stub here would test the stub, not the rule.
    .replace(/from '\.\.\/_shared\/statement-period\.ts'/, `from '${new URL('statement-period.ts', SHARED).href}'`)
    .replace(/from '\.\/diagnose-exception\.ts'/, `from '${new URL('diagnose-exception.ts', FN_DIR).href}'`)
  src = `globalThis.Deno = { serve: () => {}, env: { get: () => '' } };\n` + src
  src += `\nexport { analyzeWalk, trimAnchors, effect, entryView, r2, TOL };\n`
  const js = stripTypeScriptTypes(src, { mode: 'transform', sourceMap: false })
  const dir = mkdtempSync(join(tmpdir(), 'fdiff-'))
  const file = join(dir, 'under-test.mjs')
  writeFileSync(file, js)
  return await import(pathToFileURL(file).href + `?v=${Math.random()}`)
}

// ── the fixture: PayPal 2's real shape ──────────────────────────────────────
// Weekly statements, a steadily falling principal balance, and a Xero ledger that
// agrees with the lender everywhere EXCEPT two injected divergences: one deep in
// closed books (2026-02) and one in the open month (2026-08). Those two are the
// whole experiment — a gate that cannot tell them apart is not a gate.
const CODE = '284'
const CLOSE_DATE = '2026-06-30'
const TODAY = '2026-09-04'

function weekly(from: string, weeks: number, start: number, step: number) {
  const out: any[] = []
  let d = new Date(from + 'T00:00:00Z'), bal = start
  for (let i = 0; i < weeks; i++) {
    out.push({ statement_date: d.toISOString().slice(0, 10), principal_balance: bal.toFixed(2) })
    bal -= step
    d = new Date(d.getTime() + 7 * 86400000)
  }
  return out
}

// One Xero bank line per statement span, sized to the lender's own move, so every
// span ties before we break anything. SIGN NOTE: a `break` adds to the SPEND, so
// Xero's balance falls FURTHER than the lender's and `diff` comes back negative.
// Assertions below compare magnitudes for that reason — the direction is asserted
// separately where it carries meaning.
function ledgerFor(stmts: any[], breaks: Record<string, number> = {}) {
  const entries: any[] = []
  for (let i = 1; i < stmts.length; i++) {
    const delta = Number(stmts[i - 1].principal_balance) - Number(stmts[i].principal_balance)
    const extra = breaks[stmts[i].statement_date] ?? 0
    entries.push({
      srcType: 'BankTransaction', srcId: `bt-${i}`, date: stmts[i].statement_date,
      status: 'AUTHORISED', reconciled: true, ref: null, contact: 'PayPal', narration: null,
      type: 'SPEND', total: delta + extra,
      lines: [{ d: 'Loan principal', a: delta + extra, c: CODE }],
    })
  }
  return entries
}

// Weekly statements whose principal step GROWS each period, like a real
// amortization. Uniform steps make every span's lender figure identical, which
// makes a transposition indistinguishable from a coincidence — the distinction
// the swap check exists to draw, so the fixture has to be able to express it.
function amortizing(from: string, weeks: number, start: number, step0: number, growth: number) {
  const out: any[] = []
  let d = new Date(from + 'T00:00:00Z'), bal = start, step = step0
  for (let i = 0; i < weeks; i++) {
    out.push({ statement_date: d.toISOString().slice(0, 10), principal_balance: bal.toFixed(2) })
    bal -= step; step = r2n(step * growth)
    d = new Date(d.getTime() + 7 * 86400000)
  }
  return out
}
const r2n = (n: number) => Math.round(n * 100) / 100

// Force a span's Xero movement to an EXACT figure (rather than lender + break),
// which is how a swap is expressed: span A moves B's amount and vice versa.
function ledgerExact(stmts: any[], exact: Record<string, number> = {}, breaks: Record<string, number> = {}) {
  const entries: any[] = []
  for (let i = 1; i < stmts.length; i++) {
    const date = stmts[i].statement_date
    const delta = Number(stmts[i - 1].principal_balance) - Number(stmts[i].principal_balance)
    const amt = date in exact ? exact[date] : delta + (breaks[date] ?? 0)
    entries.push({
      srcType: 'BankTransaction', srcId: `bt-${i}`, date, status: 'AUTHORISED', reconciled: true,
      ref: null, contact: 'PayPal', narration: null, type: 'SPEND', total: amt,
      lines: [{ d: 'Loan principal', a: amt, c: CODE }],
    })
  }
  return entries
}

const BASE = {
  loan: { id: 'loan-pp2', xero_account_name: 'Paypal 2', lender: 'PayPal' },
  code: CODE,
  splits: [] as any[],
  siblingPool: [] as any[],
  otherLoanByCode: new Map<string, any>(),
  matchKnown: () => null,
  acctMap: { [CODE]: 'Paypal 2', '800': 'Interest Expense' } as Record<string, string>,
  skippedForBasis: [] as any[],
  postingDate: '2026-09-30', postingWhy: 'books are closed through 2026-06-30',
  closeDate: CLOSE_DATE, today: TODAY,
}

function run(mod: any, opts: { breaks?: Record<string, number>, closeDate?: string | null } = {}) {
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const entries = ledgerFor(stmts, opts.breaks || {})
  const headline = { difference: 0 }
  return mod.analyzeWalk({
    ...BASE, usable: stmts, entries, headline,
    closeDate: opts.closeDate === undefined ? CLOSE_DATE : opts.closeDate,
  })
}

const mod = await loadWalk()

// ═══════════════════════════════════════════════════════════════════════════
section('the fixture itself is sound — a clean book has nothing to say')
{
  const r = run(mod)
  ok('every span ties when the ledger matches the lender', r.divergent_count === 0,
    `divergent_count=${r.divergent_count}`)
  ok('no closed-book spans are flagged either', r.closed_divergent_count === 0)
  ok('it says so in one conclusion', r.conclusions.some((c: string) => /Every span ties to the cent/.test(c)),
    JSON.stringify(r.conclusions))
}

section('THE GATE — a divergence in closed books is history, not work')
{
  // 2026-02-25 is eight months inside books closed through 2026-06-30.
  const r = run(mod, { breaks: { '2026-02-25': 2544.96 } })
  const p = r.periods.find((x: any) => x.to === '2026-02-25')
  ok('the span is still WALKED and still carries its full difference', Math.abs(Math.abs(p.diff) - 2544.96) < 0.02,
    `diff=${p.diff}`)
  ok('...and is marked closed_period', p.closed_period === true)
  ok('it is NOT counted as an open finding', r.divergent_count === 0, `divergent_count=${r.divergent_count}`)
  ok('it IS counted, and named, as closed', r.closed_divergent_count === 1)
  ok('the closed total states the money — nothing is deleted',
    Math.abs(Math.abs(r.closed_divergent_total) - 2544.96) < 0.02, `total=${r.closed_divergent_total}`)
  ok('the arithmetic still foots: total_period_diff is unchanged by the gate',
    Math.abs(Math.abs(r.total_period_diff) - 2544.96) < 0.02, `total_period_diff=${r.total_period_diff}`)

  const joined = r.conclusions.join(' | ')
  ok('one conclusion names the close date and says nothing to do',
    /closed through 2026-06-30/.test(joined) && /Nothing to do/.test(joined), joined)
  ok('NO conclusion sends the reader hunting in that span',
    !/2026-02-25 is off by/.test(joined) && !/Recode it and re-run/.test(joined), joined)
  ok('the open book is reported as clean', /ties to the cent/.test(joined), joined)
}

section('THE OTHER HALF — an OPEN divergence still gets the full treatment')
{
  const r = run(mod, { breaks: { '2026-08-05': 1234.56 } })
  const p = r.periods.find((x: any) => x.to === '2026-08-05')
  ok('the open span is not marked closed', p.closed_period === false)
  ok('it counts as an open finding', r.divergent_count === 1, `divergent_count=${r.divergent_count}`)
  ok('nothing is filed as closed', r.closed_divergent_count === 0)
  ok('a conclusion names the span and its amount',
    r.conclusions.some((c: string) => c.includes('2026-08-05') && c.includes('1,234.56')),
    JSON.stringify(r.conclusions))
}

section('BOTH AT ONCE — the gate separates them, it does not silence either')
{
  const r = run(mod, { breaks: { '2026-02-25': 2544.96, '2026-08-05': 1234.56 } })
  ok('one open finding', r.divergent_count === 1)
  ok('one closed finding', r.closed_divergent_count === 1)
  ok('the headline arithmetic still carries BOTH',
    Math.abs(Math.abs(r.total_period_diff) - (2544.96 + 1234.56)) < 0.02, `total=${r.total_period_diff}`)
  const joined = r.conclusions.join(' | ')
  ok('the open one is spelled out', /2026-08-05/.test(joined), joined)
  ok('the closed one is summarised, not spelled out',
    /closed through 2026-06-30/.test(joined) && !/2026-02-25 is off by/.test(joined), joined)
}

section('A SPAN THAT STRADDLES THE CLOSE DATE STAYS OPEN')
{
  // 2026-06-24 → 2026-07-01 straddles 2026-06-30. Half its movement is still live,
  // so calling it closed would bury real work — the same reasoning isPeriodClosed()
  // uses to refuse to close a half-closed month.
  const r = run(mod, { breaks: { '2026-07-01': 500 } })
  const p = r.periods.find((x: any) => x.to === '2026-07-01')
  ok('the straddling span exists in the walk', !!p)
  ok('...and is treated as OPEN', p.closed_period === false)
  ok('...and is reported as an open finding', r.divergent_count === 1, `divergent_count=${r.divergent_count}`)
}

section('NO CLOSE DATE SET — the gate is inert, nothing is hidden')
{
  const r = run(mod, { breaks: { '2026-02-25': 2544.96 }, closeDate: null })
  ok('nothing is marked closed', r.periods.every((p: any) => p.closed_period === false))
  ok('the divergence is an ordinary open finding', r.divergent_count === 1)
  ok('and it is spelled out', r.conclusions.some((c: string) => c.includes('2026-02-25')),
    JSON.stringify(r.conclusions))
}

section('THE FOCUS MONTH — the button matches the row')
{
  // PayPal 2's actual shape: the Loans row is about August, and the walk's newest
  // statement is months older. Saying "nothing here covers August" is the answer.
  const mod2 = mod
  const stmts = weekly('2025-12-17', 20, 154000, 3000)   // ends 2026-04-29
  const r = mod2.analyzeWalk({
    ...BASE, usable: stmts, entries: ledgerFor(stmts), headline: { difference: 0 },
    focusPeriod: '2026-08',
  })
  const joined = r.conclusions.join(' | ')
  ok('no span is in focus', r.focus_span_count === 0, `focus_span_count=${r.focus_span_count}`)
  ok('the FIRST conclusion says the walk does not cover that month',
    /^Nothing in this walk covers August 2026/.test(r.conclusions[0]), JSON.stringify(r.conclusions))
  ok('...and names the newest statement it does have',
    r.conclusions[0].includes(stmts[stmts.length - 1].statement_date), r.conclusions[0])
  ok('...and asks for the document rather than proposing an investigation',
    /Upload the August 2026 statement/.test(joined) && /nothing here to investigate/.test(joined), joined)
}
{
  // The focus month IS covered and ties: say so, plainly, first.
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const r = mod.analyzeWalk({
    ...BASE, usable: stmts, entries: ledgerFor(stmts), headline: { difference: 0 },
    focusPeriod: '2026-08',
  })
  ok('spans in the focus month are counted', r.focus_span_count > 0, `n=${r.focus_span_count}`)
  ok('the lead conclusion is about that month',
    /^Every span in August 2026 ties to the cent/.test(r.conclusions[0]), JSON.stringify(r.conclusions))
}
{
  // Two open divergences, one in the focus month and one earlier. The focus one
  // must be spelled out FIRST — that is the whole of "the button matches the row".
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const r = mod.analyzeWalk({
    ...BASE, usable: stmts, entries: ledgerFor(stmts, { '2026-07-22': 700, '2026-08-19': 900 }),
    headline: { difference: 0 }, focusPeriod: '2026-08',
  })
  ok('both are open findings', r.divergent_count === 2, `divergent_count=${r.divergent_count}`)
  const iFocus = r.conclusions.findIndex((c: string) => c.includes('2026-08-19'))
  const iOther = r.conclusions.findIndex((c: string) => c.includes('2026-07-22'))
  ok('the focus-month span is named', iFocus >= 0, JSON.stringify(r.conclusions))
  ok('the earlier span is still named — nothing is dropped', iOther >= 0, JSON.stringify(r.conclusions))
  ok('the focus-month span comes FIRST', iFocus < iOther, `focus@${iFocus} other@${iOther}`)
  ok('the spans carry in_focus so the table can tier them',
    r.periods.filter((p: any) => p.in_focus).every((p: any) => p.to.slice(0, 7) === '2026-08'),
    JSON.stringify(r.periods.filter((p: any) => p.in_focus).map((p: any) => p.to)))
}
{
  // No focus period: the old behaviour, untouched.
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const r = mod.analyzeWalk({
    ...BASE, usable: stmts, entries: ledgerFor(stmts, { '2026-08-19': 900 }), headline: { difference: 0 },
  })
  ok('nothing is marked in_focus', r.periods.every((p: any) => p.in_focus === false))
  ok('no focus conclusion is invented',
    !r.conclusions.some((c: string) => /Nothing in this walk covers|Every span in .* ties/.test(c)),
    JSON.stringify(r.conclusions))
  ok('the finding is still reported', r.divergent_count === 1)
}

// ── PayPal 2's real numbers, transcribed from the screen David sent ─────────
// Each row is one statement span: the date it ENDS, what the lender's balance
// moved, and what Xero moved. The whole point of this block is that these are not
// invented — the four March spans below are the exact figures that were reported
// as four separate errors, and they cancel to zero inside their own month.
const PP2: Array<[string, number, number]> = [
  ['2025-12-24', 2681.39, 2681.39],
  ['2025-12-31', 2694.12, 12976.96],   // her month-end journal lands here
  ['2026-01-07', 2706.93, 2706.93],
  ['2026-01-14', 2719.79, 2719.79],
  ['2026-01-21', 2732.71, 2732.71],
  ['2026-01-28', 2745.70, 2805.29],
  ['2026-02-04', 2758.74, 2758.74],
  ['2026-02-11', 2771.86, 2771.86],
  ['2026-02-18', 2785.02, 2785.02],
  ['2026-02-25', 2798.26, 5343.22],
  ['2026-03-04', 2811.55, 2851.82],    // ┐
  ['2026-03-11', 2824.91, 2838.34],    // │ four spans, one month,
  ['2026-03-18', 2838.34, 2824.91],    // │ net exactly $0.00
  ['2026-03-25', 2851.82, 2811.55],    // ┘
  ['2026-04-01', 2865.37, 8612.30],
  ['2026-04-08', 2878.99, 2878.99],
  ['2026-04-15', 2892.67, 2892.67],
  ['2026-04-22', 2906.41, 2906.41],
  ['2026-04-29', 2920.23, 1299.31],
  ['2026-05-06', 2934.10, 2934.10],
  ['2026-05-13', 2948.04, 2948.04],
]

// Build statements whose consecutive balances reproduce each lender move, and one
// Xero bank line per span sized to that span's own Xero move.
function pp2Inputs() {
  const stmts: any[] = [{ statement_date: '2025-12-17', principal_balance: '154000.00' }]
  const entries: any[] = []
  let bal = 154000
  PP2.forEach(([date, lender, xero], i) => {
    bal -= lender
    stmts.push({ statement_date: date, principal_balance: bal.toFixed(2) })
    entries.push({
      srcType: 'BankTransaction', srcId: `pp-${i}`, date, status: 'AUTHORISED', reconciled: true,
      ref: null, contact: 'PayPal', narration: null, type: 'SPEND', total: xero,
      lines: [{ d: 'Loan principal', a: xero, c: CODE }],
    })
  })
  return { stmts, entries }
}

section('MONTH GRANULARITY — PayPal 2\'s four March spans are one non-event')
{
  const { stmts, entries } = pp2Inputs()
  // Close date pushed back so the close gate cannot do this job for us — this
  // section must prove the MONTH rule works on its own.
  const r = mod.analyzeWalk({ ...BASE, usable: stmts, entries, headline: { difference: 0 }, closeDate: '2025-01-31' })

  const march = r.months.find((m: any) => m.month === '2026-03')
  ok('March is rolled up as a month', !!march, JSON.stringify(r.months.map((m: any) => m.month)))
  ok('March has four spans', march.span_count === 4, `span_count=${march.span_count}`)
  ok('...all four flagged at weekly resolution', march.divergent_spans === 4, `divergent=${march.divergent_spans}`)
  ok('...and the MONTH ties to the cent', Math.abs(march.diff) < 0.02, `diff=${march.diff}`)
  ok('...so the month is marked as netting internally', march.nets_internally === true)

  const marchSpans = r.periods.filter((p: any) => p.to.slice(0, 7) === '2026-03')
  ok('every March span still carries its own weekly difference — nothing is erased',
    marchSpans.filter((p: any) => Math.abs(p.diff) >= 0.02).length === 4,
    JSON.stringify(marchSpans.map((p: any) => p.diff)))
  ok('...and each records both its own gap and its month\'s',
    marchSpans.every((p: any) => !p.month_nets || (p.month_nets.month === '2026-03' && Math.abs(p.month_nets.month_gap) < 0.02)),
    JSON.stringify(marchSpans.map((p: any) => p.month_nets)))
  ok('no March span is reported as work',
    !r.conclusions.some((c: string) => /2026-03-04 is off by|2026-03-25 is off by/.test(c)),
    JSON.stringify(r.conclusions))
  ok('no correction is proposed for a month that balances', !r.proposal || !/2026-03/.test(JSON.stringify(r.proposal)))
  ok('no cross-loan candidate hunt runs on a netting span',
    marchSpans.every((p: any) => !p.cross_loan_candidates || !p.cross_loan_candidates.length),
    JSON.stringify(marchSpans.map((p: any) => (p.cross_loan_candidates || []).length)))

  /* READS BOTH HALVES, and that is the point (the ce17 rule in
     tests/loan-bundle-balances.test.mts). When two or more "nothing to do"
     categories apply they collapse into one line and the unabridged sentences
     move to `no_action_detail` — which the modal shows behind "Show the working".
     An assertion that read only the visible half would go red on that relocation
     and green on a deletion, which is exactly backwards. */
  const visible = r.conclusions.join(' | ')
  const working = (r.no_action_detail || []).join(' | ')
  const said = `${visible} | ${working}`
  ok('one conclusion explains the shape and names March',
    /cancel out within/.test(said) && /March 2026/.test(said), said)
  ok('...and says what it is: a month-end correction landing in one week',
    /month-end correction landing in one week/.test(said), said)
  ok('...and the working really is carried, not just claimed',
    (r.no_action_detail || []).length >= 1, JSON.stringify(r.no_action_detail))

  // AND THE OTHER HALF: December does NOT net, and must still be reported.
  const dec = r.months.find((m: any) => m.month === '2025-12')
  ok('December does not net — its journal corrects months outside itself',
    dec.nets_internally === false && Math.abs(dec.diff) > 1000, JSON.stringify(dec))
  ok('...so December is still an open finding',
    r.periods.find((p: any) => p.to === '2025-12-31').month_nets === undefined)
}

section('THE WEEKS ARE STILL THE MAGNIFYING GLASS WHEN THE MONTH IS OFF')
{
  // One divergent span in a month that therefore does NOT tie: full treatment.
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const r = mod.analyzeWalk({
    ...BASE, usable: stmts, entries: ledgerFor(stmts, { '2026-08-19': 900 }),
    headline: { difference: 0 }, closeDate: '2025-01-31',
  })
  const aug = r.months.find((m: any) => m.month === '2026-08')
  ok('August does not net', aug.nets_internally === false, JSON.stringify(aug))
  ok('the span keeps its finding', r.divergent_count === 1, `divergent_count=${r.divergent_count}`)
  ok('...and is spelled out by week, not by month',
    r.conclusions.some((c: string) => c.includes('2026-08-19')), JSON.stringify(r.conclusions))
  ok('no month-nets line is invented', !r.conclusions.some((c: string) => /cancel out within/.test(c)))
}

section('THE ARITHMETIC IS UNTOUCHED BY THE MONTH RULE')
{
  const { stmts, entries } = pp2Inputs()
  const r = mod.analyzeWalk({ ...BASE, usable: stmts, entries, headline: { difference: 0 }, closeDate: '2025-01-31' })
  const spanSum = r.periods.reduce((t: number, p: any) => t + p.diff, 0)
  ok('total_period_diff still equals the sum of every span',
    Math.abs(r.total_period_diff - spanSum) < 0.02, `${r.total_period_diff} vs ${spanSum}`)
  const monthSum = r.months.reduce((t: number, m: any) => t + m.diff, 0)
  ok('the month rollup sums to the same number as the spans — the ruler changed, not the book',
    Math.abs(monthSum - spanSum) < 0.02, `${monthSum} vs ${spanSum}`)
  ok('every span belongs to exactly one month',
    r.months.reduce((t: number, m: any) => t + m.span_count, 0) === r.periods.length,
    `${r.months.reduce((t: number, m: any) => t + m.span_count, 0)} vs ${r.periods.length}`)
}

section('⚠ REVIEW FINDING 1 — a paired leg must not cancel a real error in the next month')
{
  // Reproduced from the review, exactly. An ordinary cutoff straddle parks one
  // leg's difference in the FOLLOWING month; a genuine error of the same size
  // lives in that month. Summing every span made April foot to zero and the walk
  // announced "the month ties to the cent — nothing to fix". April did not tie.
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const r = mod.analyzeWalk({
    ...BASE, usable: stmts,
    entries: ledgerFor(stmts, { '2026-03-25': -40.27, '2026-04-01': 40.27, '2026-04-15': -40.27 }),
    headline: { difference: 0 }, closeDate: '2025-01-31',
  })
  const apr = r.months.find((m: any) => m.month === '2026-04')
  const real = r.periods.find((p: any) => p.to === '2026-04-15')
  ok('the straddle is paired as before', !!r.periods.find((p: any) => p.to === '2026-04-01').timing_pair)
  ok('April\'s raw sum still nets to zero — the leak is real, not imagined',
    Math.abs(apr.diff) < 0.02, `diff=${apr.diff}`)
  ok('...but the question April is ASKED excludes the paired leg',
    Math.abs(Math.abs(apr.unexplained_diff) - 40.27) < 0.02, `unexplained_diff=${apr.unexplained_diff}`)
  ok('...so April does NOT net', apr.nets_internally === false, JSON.stringify(apr))
  ok('the genuine error survives as work', !real.month_nets && r.divergent_count >= 1,
    `month_nets=${JSON.stringify(real.month_nets)} divergent_count=${r.divergent_count}`)
  ok('...and is named to the reader',
    r.conclusions.some((c: string) => c.includes('2026-04-15')), JSON.stringify(r.conclusions))
  ok('no sentence claims April ties',
    !r.conclusions.concat(r.no_action_detail || []).some((c: string) => /April 2026/.test(c) && /cancel out within/.test(c)),
    JSON.stringify(r.conclusions))
}
{
  // And the inverse: with the old all-spans sum, the error IS suppressed.
  const broken = await loadWalk(src => src.replace(
    '    const nets = Math.abs(unexplainedDiff) < TOL && unexplained.length > 0',
    '    const nets = Math.abs(diff) < TOL && unexplained.length > 0'))
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const r = broken.analyzeWalk({
    ...BASE, usable: stmts,
    entries: ledgerFor(stmts, { '2026-03-25': -40.27, '2026-04-01': 40.27, '2026-04-15': -40.27 }),
    headline: { difference: 0 }, closeDate: '2025-01-31',
  })
  ok('with the all-spans sum, the real error is silently cleared',
    !!r.periods.find((p: any) => p.to === '2026-04-15').month_nets && r.divergent_count === 0,
    `divergent_count=${r.divergent_count}`)
}

section('⚠ REVIEW FINDING 2 — a pair straddling the close date is still spoken about')
{
  // One cutoff straddle with its first leg inside closed books and its second
  // outside. It used to fall between every filter: no count held it and no
  // sentence mentioned it, so the modal rendered two grey rows and an EMPTY
  // explanation box for $1,000 of movement.
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const r = mod.analyzeWalk({
    ...BASE, usable: stmts, entries: ledgerFor(stmts, { '2026-06-24': 1000, '2026-07-01': -1000 }),
    headline: { difference: 0 },   // closeDate 2026-06-30 from BASE
  })
  const first = r.periods.find((p: any) => p.to === '2026-06-24')
  const second = r.periods.find((p: any) => p.to === '2026-07-01')
  ok('the first leg really is inside closed books', first.closed_period === true)
  ok('...and the second is not', second.closed_period === false)
  ok('they are still paired', !!first.timing_pair && !!second.timing_pair)
  ok('THE WALK SAYS SOMETHING — an empty conclusions box is the bug',
    r.conclusions.length > 0, JSON.stringify(r.conclusions))
  const said = r.conclusions.concat(r.no_action_detail || []).join(' | ')
  ok('...and what it says is that they are timing, not errors',
    /timing, not errors|need no action/.test(said), said)
  ok('the open leg is counted as explained, not lost',
    r.timing_pair_span_count === 1, `timing_pair_span_count=${r.timing_pair_span_count}`)
  ok('flagged = work + explained still holds across the close boundary',
    r.flagged_span_count === r.divergent_count + r.timing_pair_span_count + r.month_netted_span_count,
    `flagged=${r.flagged_span_count} work=${r.divergent_count} pairs=${r.timing_pair_span_count} months=${r.month_netted_span_count}`)
}

section('⚠ REVIEW FINDING 5 — the focus line must not contradict the findings below it')
{
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const r = mod.analyzeWalk({
    ...BASE, usable: stmts, entries: ledgerFor(stmts, { '2026-07-15': 900, '2026-08-05': 700 }),
    headline: { difference: 0 }, closeDate: '2025-01-31', focusPeriod: '2026-10',
  })
  ok('there are real findings', r.divergent_count === 2, `divergent_count=${r.divergent_count}`)
  ok('the focus line does NOT say there is nothing to investigate',
    !/nothing here to investigate/.test(r.conclusions[0]), r.conclusions[0])
  ok('...it points at them instead',
    /still need a look|still needs a look/.test(r.conclusions[0]), r.conclusions[0])
  ok('and both findings survive the four-bullet cap',
    r.conclusions.some((c: string) => c.includes('2026-07-15'))
    && r.conclusions.some((c: string) => c.includes('2026-08-05')), JSON.stringify(r.conclusions))
  ok('the cap is still honoured', r.conclusions.length <= 4, String(r.conclusions.length))
}
{
  // ...and when there really is nothing, it still says so.
  const stmts = weekly('2025-12-17', 20, 154000, 3000)
  const r = mod.analyzeWalk({
    ...BASE, usable: stmts, entries: ledgerFor(stmts), headline: { difference: 0 },
    closeDate: '2025-01-31', focusPeriod: '2026-10',
  })
  ok('with a clean book the focus line keeps its plain answer',
    /nothing here to investigate/.test(r.conclusions[0]), r.conclusions[0])
}

section('⚠ REVIEW FINDING 6 — "nothing to do" never sits above a live Approve button')
{
  // A closed-span exception that PROPOSES a correction keeps its sentence: the
  // correction is legitimate (session 234 re-dates it into an open month), so
  // folding it into the closed-books line while the button stayed on screen was
  // a modal contradicting itself.
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const r = mod.analyzeWalk({
    ...BASE, usable: stmts, entries: ledgerFor(stmts, { '2026-02-25': 2544.96 }), headline: { difference: 0 },
  })
  // No exception is raised on this fixture, so the invariant is asserted directly
  // on the flag's definition: it may only fire when nothing is proposed.
  ok('the suppression flag is false whenever a correction is proposed',
    r.cpa_exception_closed === false || !r.cpa_exception?.proposed_entry,
    JSON.stringify({ closed: r.cpa_exception_closed, proposed: !!r.cpa_exception?.proposed_entry }))
}

// ═══════════════════════════════════════════════════════════════════════════
// PROVE IT DISCRIMINATES (session 245's rule). Re-load the SHIPPED source with
// the inverse of the fix applied and confirm the assertions go red. An assertion
// that passes against both the fixed and the broken code is decoration.
section('IT DISCRIMINATES — the gate removed, the witch hunt returns')
{
  const broken = await loadWalk(src => src.replace(
    'period.closed_period = !!(closeDate && B.statement_date <= closeDate)',
    'period.closed_period = false'))
  const r = run(broken, { breaks: { '2026-02-25': 2544.96 } })
  ok('without the gate, the closed span counts as open work', r.divergent_count === 1,
    `divergent_count=${r.divergent_count}`)
  ok('without the gate, nothing is filed as closed', r.closed_divergent_count === 0)
  ok('without the gate, the reader IS sent hunting in settled books',
    r.conclusions.some((c: string) => /2026-02-25 is off by/.test(c)),
    JSON.stringify(r.conclusions))
}

section('IT DISCRIMINATES — focus ordering removed, the row and the modal part ways')
{
  const broken = await loadWalk(src => src.replace(
    '    ? [...realDivergent.filter(p => p.in_focus), ...realDivergent.filter(p => !p.in_focus)]',
    '    ? realDivergent'))
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const r = broken.analyzeWalk({
    ...BASE, usable: stmts, entries: ledgerFor(stmts, { '2026-07-22': 700, '2026-08-19': 900 }),
    headline: { difference: 0 }, focusPeriod: '2026-08',
  })
  const iFocus = r.conclusions.findIndex((c: string) => c.includes('2026-08-19'))
  const iOther = r.conclusions.findIndex((c: string) => c.includes('2026-07-22'))
  ok('without the reorder, the earlier span leads instead of the row\'s own month',
    iOther < iFocus, `focus@${iFocus} other@${iOther}`)
}
{
  const broken = await loadWalk(src => src.replace(
    "  const focusSpans = focusPeriod ? periods.filter(p => p.in_focus) : []",
    "  const focusSpans = periods"))
  const stmts = weekly('2025-12-17', 20, 154000, 3000)
  const r = broken.analyzeWalk({
    ...BASE, usable: stmts, entries: ledgerFor(stmts), headline: { difference: 0 }, focusPeriod: '2026-08',
  })
  ok('without the empty-focus branch, a month with no spans is silently never mentioned',
    !r.conclusions.some((c: string) => /Nothing in this walk covers/.test(c)), JSON.stringify(r.conclusions))
}

section('NON-ADJACENT PAIRS — a REAL transposition, three weeks apart')
{
  // The shape from PayPal 2's screen: each span carries the OTHER'S lender
  // figure. Built on an amortizing schedule so the two figures actually differ,
  // and straddling a month boundary so the month rule cannot claim it.
  const stmts = amortizing('2025-12-17', 38, 154000, 2800, 1.0047)
  const A = '2026-07-22', B = '2026-08-12'
  const idx = (d: string) => stmts.findIndex(x => x.statement_date === d)
  const lenderOf = (d: string) => r2n(Number(stmts[idx(d) - 1].principal_balance) - Number(stmts[idx(d)].principal_balance))
  const la = lenderOf(A), lb = lenderOf(B)
  ok('the fixture can express a swap at all — the two lender figures differ',
    Math.abs(la - lb) > 0.02, `${la} vs ${lb}`)

  const r = mod.analyzeWalk({
    ...BASE, usable: stmts, entries: ledgerExact(stmts, { [A]: lb, [B]: la }),
    headline: { difference: 0 }, closeDate: '2025-01-31',
  })
  const a = r.periods.find((p: any) => p.to === A)
  const b = r.periods.find((p: any) => p.to === B)
  ok('neither month nets on its own — this is not the month rule\'s catch',
    r.months.find((m: any) => m.month === '2026-07').nets_internally === false
    && r.months.find((m: any) => m.month === '2026-08').nets_internally === false)
  ok('the two spans are paired', !!a.timing_pair && !!b.timing_pair,
    JSON.stringify([a.timing_pair, b.timing_pair]))
  ok('...marked as a distant pair, not a cutoff straddle', a.timing_pair.distant === true && a.timing_pair.kind === 'transposed')
  ok('...three spans apart', a.timing_pair.spans_apart === 3, `apart=${a.timing_pair.spans_apart}`)
  ok('...and the swap it claims is RECORDED, not merely asserted',
    !!a.timing_pair.verified_swap
    && Math.abs(a.timing_pair.verified_swap.a_lender - a.timing_pair.verified_swap.b_xero) < 0.02
    && Math.abs(a.timing_pair.verified_swap.b_lender - a.timing_pair.verified_swap.a_xero) < 0.02,
    JSON.stringify(a.timing_pair.verified_swap))
  ok('neither is an open finding any more', r.divergent_count === 0, `divergent_count=${r.divergent_count}`)
  ok('both keep their own figures — nothing is erased',
    Math.abs(a.diff) > 0.02 && Math.abs(b.diff) > 0.02, `${a.diff} / ${b.diff}`)
  const joined = r.conclusions.concat(r.no_action_detail || []).join(' | ')
  ok('the conclusion tells the RIGHT story — a wrong week, not a late payment',
    /wrong week rather than missing|pair off across the weeks/.test(joined), joined)
}

section('⚠ REVIEW FINDING 3 — cancellation alone must NOT dismiss two real errors')
{
  // Two unrelated $500 errors, three weeks apart, that happen to cancel. Before
  // the swap check this was reported as "each span carries the other's figure...
  // Nothing to fix" — two genuine misstatements erased by a coincidence, which is
  // exactly the amount-matching this module distrusts.
  const stmts = amortizing('2025-12-17', 38, 154000, 2800, 1.0047)
  const r = mod.analyzeWalk({
    ...BASE, usable: stmts, entries: ledgerExact(stmts, {}, { '2026-07-22': 500, '2026-08-12': -500 }),
    headline: { difference: 0 }, closeDate: '2025-01-31',
  })
  const a = r.periods.find((p: any) => p.to === '2026-07-22')
  const b = r.periods.find((p: any) => p.to === '2026-08-12')
  ok('they cancel exactly', Math.abs(a.diff + b.diff) < 0.02, `${a.diff} + ${b.diff}`)
  ok('...but neither is paired, because no swap actually happened',
    !a.timing_pair && !b.timing_pair, JSON.stringify([a.timing_pair, b.timing_pair]))
  ok('...and both remain open findings', r.divergent_count === 2, `divergent_count=${r.divergent_count}`)
}

section('AN AMBIGUOUS PAIR REFUSES — it does not guess')
{
  // Three spans of the same magnitude in the window: +500, −500, −500. Which −500
  // partners the +500 is not knowable, so nothing is paired. Session 245's rule
  // for dating a ledger, applied to pairing: an ambiguous tie refuses.
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const r = mod.analyzeWalk({
    ...BASE, usable: stmts,
    entries: ledgerFor(stmts, { '2026-07-22': 500, '2026-08-05': -500, '2026-08-12': -500 }),
    headline: { difference: 0 }, closeDate: '2025-01-31',
  })
  const a = r.periods.find((p: any) => p.to === '2026-07-22')
  ok('the ambiguous span is NOT paired', !a.timing_pair, JSON.stringify(a.timing_pair))
  ok('all three stay visible as findings', r.divergent_count === 3, `divergent_count=${r.divergent_count}`)
}

section('THE WINDOW IS BOUNDED — a coincidence months later is not a pair')
{
  // Same magnitude, but five months apart. Two unrelated differences that happen
  // to be equal and opposite must not cancel each other on that basis alone.
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const r = mod.analyzeWalk({
    ...BASE, usable: stmts, entries: ledgerFor(stmts, { '2026-03-04': 500, '2026-08-12': -500 }),
    headline: { difference: 0 }, closeDate: '2025-01-31',
  })
  const a = r.periods.find((p: any) => p.to === '2026-03-04')
  const b = r.periods.find((p: any) => p.to === '2026-08-12')
  ok('the distant coincidence is not paired', !a.timing_pair && !b.timing_pair)
  ok('both remain findings', r.divergent_count === 2, `divergent_count=${r.divergent_count}`)
}

// ═══════════════════════════════════════════════════════════════════════════
section('THE DENOMINATOR DOES NOT SHRINK — every flagged span is accounted for')
{
  // Four rules can now explain a span away (close date, timing pair, month
  // rollup, the accountant's own entry). Each one makes divergent_count smaller.
  // If the explained spans are not COUNTED somewhere the reader can see, the
  // product has learned to report a smaller problem rather than a solved one --
  // which is the exact failure session 262's close gate was written against.
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const r = mod.analyzeWalk({
    ...BASE, usable: stmts,
    entries: ledgerFor(stmts, {
      '2026-02-25': 2544.96,                    // closed books
      '2026-08-05': 100, '2026-08-12': 50, '2026-08-19': -150,   // month nets
      '2026-05-06': 500, '2026-05-27': -500,    // distant pair (books still closed here)
      '2026-07-15': 777,                        // genuine open work
    }),
    headline: { difference: 0 },
  })
  ok('exactly one span is real work', r.divergent_count === 1, `divergent_count=${r.divergent_count}`)
  const explained = r.timing_pair_span_count + r.month_netted_span_count
  ok('flagged = work + explained, exactly',
    r.flagged_span_count === r.divergent_count + explained,
    `flagged=${r.flagged_span_count} work=${r.divergent_count} explained=${explained}`)
  ok('the closed ones are counted separately and not lost',
    r.closed_divergent_count >= 1, `closed=${r.closed_divergent_count}`)
  ok('every span in the walk is in exactly one month bucket',
    r.months.reduce((t: number, m: any) => t + m.span_count, 0) === r.periods.length)
  ok('and the money still foots to the sum of every span',
    Math.abs(r.total_period_diff - r.periods.reduce((t: number, p: any) => t + p.diff, 0)) < 0.02)
}

section('IT DISCRIMINATES — month rule removed')
{
  /* The month rule and the non-adjacent pair rule overlap, so this has to test
     the case only the MONTH can explain: three spans in one month whose
     differences sum to zero but where no two of them cancel each other
     (+$100, +$50, −$150). No pairing rule of any width can see that; the month
     is the only ruler on which it disappears. */
  const broken = await loadWalk(src => src.replace(
    '    const nets = Math.abs(unexplainedDiff) < TOL && unexplained.length > 0',
    '    const nets = false'))
  const breaks = { '2026-08-05': 100, '2026-08-12': 50, '2026-08-19': -150 }
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const args = { ...BASE, usable: stmts, entries: ledgerFor(stmts, breaks), headline: { difference: 0 }, closeDate: '2025-01-31' }

  const good = mod.analyzeWalk({ ...args })
  ok('with the month rule, August ties and none of the three is work',
    good.months.find((m: any) => m.month === '2026-08').nets_internally === true && good.divergent_count === 0,
    `divergent_count=${good.divergent_count}`)

  const r = broken.analyzeWalk({ ...args })
  ok('without it, all three come back as open findings', r.divergent_count === 3, `divergent_count=${r.divergent_count}`)
  ok('...and the reader is sent after them',
    r.conclusions.some((c: string) => /is off by/.test(c)), JSON.stringify(r.conclusions))
  ok('...and no month-nets line is offered', !r.conclusions.some((c: string) => /cancel out within/.test(c)))
}

section('IT DISCRIMINATES — adjacency restored, the transposition returns as two errors')
{
  const broken = await loadWalk(src => src.replace(
    '  const PAIR_LOOKAHEAD_SPANS = 6', '  const PAIR_LOOKAHEAD_SPANS = 1'))
  const stmts = weekly('2025-12-17', 38, 154000, 3000)
  const r = broken.analyzeWalk({
    ...BASE, usable: stmts, entries: ledgerFor(stmts, { '2026-07-22': 500, '2026-08-12': -500 }),
    headline: { difference: 0 }, closeDate: '2025-01-31',
  })
  ok('with a one-span lookahead the pair is invisible again', r.divergent_count === 2,
    `divergent_count=${r.divergent_count}`)
  ok('...and both are reported as things to go and fix',
    r.conclusions.some((c: string) => /2026-07-22|2026-08-12/.test(c)), JSON.stringify(r.conclusions))
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail ? 1 : 0)
