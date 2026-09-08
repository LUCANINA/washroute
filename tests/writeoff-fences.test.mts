/* ── session 284: THE WRITE-OFF, AND EVERY FENCE AROUND IT ──────────────────
   David: "person clicks Find the fix, sees a history and/or explanation, is
   proposed a one-time post/adjustment, clicks Post or Ignore."

   This is the one correcting entry in the module NOT derived from a diagnosis,
   so it is the one capable of becoming a plug machine. These assertions are
   almost entirely about REFUSAL, and each refusal test changes exactly ONE
   input away from the eligible fixture — otherwise a test proving "it refused"
   proves only that something, somewhere, was wrong.

   The fixture is EIDL's real shape: books $960,000.00, lender $960,005.00,
   $0.00 applied to principal for months, no cause findable anywhere. */
import assert from 'node:assert'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

let pass = 0, fail = 0
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log('  ok  ' + name) }
  catch (e: any) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.message || e)) }
}
const h = (s: string) => console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 58 - s.length)))

const FN_DIR = new URL('../supabase/functions/loan-find-difference/', import.meta.url)
const SHARED = new URL('../supabase/functions/_shared/', import.meta.url)

/* The loader drives the SHIPPED source. `mutate` applies the inverse of a fence
   so we can watch an assertion go red — a fence that cannot be removed and
   observed is not being tested, it is being described. */
async function load(mutate?: (src: string) => string) {
  let src = readFileSync(new URL('index.ts', FN_DIR), 'utf8')
  if (mutate) {
    const before = src
    src = mutate(src)
    if (src === before) throw new Error('mutation did not apply — the anchor text has moved')
  }
  src = src
    .replace(/^import "jsr:@supabase\/functions-js\/edge-runtime\.d\.ts"\s*$/m, '')
    .replace(/^import \{ createClient \} from "jsr:@supabase\/supabase-js@2"\s*$/m,
      `const createClient = () => { throw new Error('createClient must not be reached') }`)
    .replace(/^import \{ getXeroAuth \} from '\.\.\/_shared\/xero-auth\.ts'\s*$/m,
      `const getXeroAuth = () => { throw new Error('getXeroAuth must not be reached') }`)
    .replace(/from '\.\.\/_shared\/close-date\.ts'/, `from '${new URL('close-date.ts', SHARED).href}'`)
    .replace(/from '\.\.\/_shared\/statement-period\.ts'/, `from '${new URL('statement-period.ts', SHARED).href}'`)
    // Loaded for real, deliberately: the ceiling IS this policy, and a stub
    // here would test the stub rather than the number that governs a posting.
    .replace(/from '\.\.\/_shared\/materiality\.ts'/, `from '${new URL('materiality.ts', SHARED).href}'`)
    .replace(/from '\.\/diagnose-exception\.ts'/, `from '${new URL('diagnose-exception.ts', FN_DIR).href}'`)
  src = `globalThis.Deno = { serve: () => {}, env: { get: () => '' } };\n` + src
  src += `\nexport { buildWriteoff, WRITEOFF_REAL_ANCHORS };\n`
  const js = stripTypeScriptTypes(src, { mode: 'transform', sourceMap: false })
  const dir = mkdtempSync(join(tmpdir(), 'wo-'))
  const file = join(dir, 'under-test.mjs')
  writeFileSync(file, js)
  return await import(pathToFileURL(file).href + `?v=${Math.random()}`)
}

const { buildWriteoff } = await load()

const TODAY = '2026-09-08'
const CLOSE = '2026-06-30'
// NOT merely "after the close date": postingDateFor clears the closed month AND
// the month being closed, so with books closed through 2026-06-30 the first date
// a correction may carry is this month's end. Hardcoding 2026-07-31 here made
// every eligible-case assertion fail on the close-date fence — the fixture was
// wrong, the code was right, which is the good failure.
const POSTING = '2026-09-30'

/* EIDL's real numbers. difference = books - lender = 960000 - 960005 = -5. */
const base = () => ({
  loan: { id: 'loan-eidl', xero_account_name: 'EIDL SBA Loan', lender: 'SBA' },
  code: '299',
  headline: { difference: -5, as_of: '2026-08-24' },
  detail: {
    code: '299', difference: -5, xero_balance: 960000, lender_balance: 960005,
    anchor_date: '2026-08-24', anchor_source: 'portal_manual_pull',
    self_diagnosis: null, still_unexplained: -5, entries_after_anchor: 0,
  },
  proposal: null, cpaException: null, totalPeriodDiff: 0, hunt: null,
  postingDate: POSTING, postingWhy: 'books are closed through 2026-06-30', closeDate: CLOSE, today: TODAY,
  writeoffAccount: '449', acctMap: { '299': 'EIDL SBA Loan', '449': 'Loan balance adjustments' },
})
const build = (over: any = {}) => buildWriteoff({ ...base(), ...over })

h('the eligible case — EIDL, $5, nothing findable')
const ok0 = build()
t('it is offered', () => assert.equal(ok0.eligible, true, JSON.stringify(ok0.why)))
t('for the difference the reader is looking at, to the cent', () => assert.equal(ok0.amount, -5))
t('dated into the open period, never the closed one', () => assert.equal(ok0.journal.Date, POSTING))
t('two legs, and only two', () => assert.equal(ok0.journal.JournalLines.length, 2))

h('the SIGN — measured, not assumed')
/* Xero credits a liability with a NEGATIVE LineAmount. Measured on the real
   2024-03-31 EIDL journal: -10,280.81 to account 299 raised the balance from
   949,719.19 to 960,000.00. Books BELOW the lender must therefore post the
   difference itself to the loan leg. Getting this backwards moves the books
   $5 the wrong way and reports a $10 gap next month — silently. */
t('books below the lender ⇒ the loan leg is negative, which RAISES the liability', () => {
  const loanLeg = ok0.journal.JournalLines.find((l: any) => l.AccountCode === '299')
  assert.equal(loanLeg.LineAmount, -5)
})
t('...and the offset is its exact negation, so the journal balances', () => {
  const sum = ok0.journal.JournalLines.reduce((a: number, l: any) => a + l.LineAmount, 0)
  assert.equal(Math.round(sum * 100) / 100, 0)
})
t('the offset goes to the NOMINATED account, never a hardcoded one', () => {
  const off = ok0.journal.JournalLines.find((l: any) => l.AccountCode !== '299')
  assert.equal(off.AccountCode, '449')
})
t('books ABOVE the lender flips both legs', () => {
  const up = build({ headline: { difference: 5, as_of: '2026-08-24' },
                     detail: { ...base().detail, difference: 5, xero_balance: 960010, still_unexplained: 5 } })
  assert.equal(up.eligible, true, JSON.stringify(up.why))
  assert.equal(up.journal.JournalLines.find((l: any) => l.AccountCode === '299').LineAmount, 5)
})
t('⭐ and the card states the RESULT in words, so a sign error reads wrong instead of posting quietly', () => {
  assert.ok(/960,005\.00/.test(ok0.result_sentence), ok0.result_sentence)
  assert.ok(/same as the lender/i.test(ok0.result_sentence))
})

h('the narration — the entire long-term value of the entry')
t('⭐ it says the cause is UNKNOWN, in those words', () =>
  assert.ok(/CAUSE UNKNOWN/.test(ok0.journal.Narration), ok0.journal.Narration))
t('it carries BOTH balances and the date they were compared', () => {
  assert.ok(/\$960,000\.00/.test(ok0.journal.Narration))
  assert.ok(/\$960,005\.00/.test(ok0.journal.Narration))
  assert.ok(/2026-08-24/.test(ok0.journal.Narration))
})
t('it names what was looked for and not found', () =>
  assert.ok(/No cause was found/.test(ok0.journal.Narration) && /walk attributed nothing/.test(ok0.journal.Narration)))
t('it never calls itself an "adjustment"', () =>
  assert.ok(!/adjustment/i.test(ok0.journal.Narration), ok0.journal.Narration))
t('it is greppable in Xero, loan and date included', () =>
  assert.ok(/\[WR-WRITEOFF 299 2026-09-30\]/.test(ok0.journal.Narration)))
t('the searched list reaches the reader too, not just the journal', () =>
  assert.ok(Array.isArray(ok0.searched) && ok0.searched.length >= 4))

h('THE CEILING — and it is deliberately STRICTER than !isMaterialGap')
/* isMaterialGap is an AND, so NOT-material is an OR: under the floor OR under
   the share. On a $960,005 loan 0.25% is $2,400, so the loose reading would
   have offered a one-click write-off on anything up to ~$2,400 with no cause.
   That is the plug machine arriving through its own fence. */
const overFloor = (amt: number) => build({
  headline: { difference: amt, as_of: '2026-08-24' },
  detail: { ...base().detail, difference: amt, xero_balance: 960005 + amt, still_unexplained: amt },
})
t('$24.99 is inside the cap', () => assert.equal(overFloor(-24.99).eligible, true))
t('⭐ $25.00 is not — the floor binds even though it is 0.0026% of this loan', () => {
  const r = overFloor(-25)
  assert.equal(r.eligible, false)
  assert.ok(/ceiling/.test(r.why), r.why)
})
t('⭐⭐ $2,000 is REFUSED, which the loose reading would have allowed', () => {
  const r = overFloor(-2000)
  assert.equal(r.eligible, false)
  assert.ok(/over the \$25\.00 cap/.test(r.why), r.why)
})
t('...and the share test still bites on a SMALL loan, where the floor would not', () => {
  // $20 on a $1,000 loan is under the floor but 2% of the balance.
  const r = build({
    headline: { difference: -20, as_of: '2026-08-24' },
    detail: { ...base().detail, difference: -20, xero_balance: 980, lender_balance: 1000, still_unexplained: -20 },
  })
  assert.equal(r.eligible, false)
  assert.ok(/% of the balance/.test(r.why), r.why)
})

h('the refusals — each changes exactly ONE thing from the eligible fixture')
const refuses = (name: string, over: any, re: RegExp) => t(name, () => {
  const r = build(over)
  assert.equal(r.eligible, false, 'expected a refusal, got an offer')
  assert.ok(re.test(r.why), `why: ${r.why}`)
})
refuses('no account nominated ⇒ the feature is simply off',
  { writeoffAccount: null }, /no write-off account/)
refuses('a real correction was found ⇒ post that instead',
  { proposal: { token: 'x' } }, /already been identified/)
refuses('a CPA exception was prepared ⇒ post that instead',
  { cpaException: { proposed_entry: { Date: '2026-07-31' } } }, /CPA exception/)
refuses('the check already named a cause',
  { detail: { ...base().detail, self_diagnosis: 'settlement lag' } }, /already named a cause/)
refuses('later entries explain part of it ⇒ the remainder is a different question',
  { detail: { ...base().detail, still_unexplained: -2 } }, /different question/)
refuses('the walk found something to attribute ⇒ that is the lead',
  { totalPeriodDiff: -5 }, /the lead, not a write-off/)
refuses('⭐ a live Xero transaction of exactly this amount exists ⇒ look at that first',
  { hunt: { amount: 5, matches: [{ id: 'bt-1' }] } }, /look at that before writing/)
refuses('⭐ the balance did not come from a lender document ⇒ it would be circular',
  { detail: { ...base().detail, anchor_source: 'xero_derived' } }, /did not come from a lender document/)
refuses('the only postable date is inside closed books',
  { postingDate: '2026-05-31' }, /closed/)
refuses('there is no open difference at all',
  { headline: null }, /no open books-vs-lender difference/)
refuses('the books already agree',
  { headline: { difference: 0, as_of: '2026-08-24' } }, /already agree/)

h('a refusal EXPLAINS itself — a missing button teaches nobody anything')
t('every refusal carries a `why`', () => {
  for (const over of [{ writeoffAccount: null }, { proposal: { token: 'x' } }, { totalPeriodDiff: -5 }]) {
    const r = build(over)
    assert.ok(typeof r.why === 'string' && r.why.length > 20, JSON.stringify(r))
  }
})

h('the token pins the figure a person actually read')
t('a different amount is a different token', () => {
  assert.notEqual(build().token, overFloor(-4).token)
})
t('a different posting date is a different token', () => {
  assert.notEqual(build().token, build({ postingDate: '2026-10-31' }).token)
})
t('the same analysis twice is the same token — approval is not a one-shot nonce', () => {
  assert.equal(build().token, build().token)
})

h('IT DISCRIMINATES — remove a fence and the assertion must go red')
{
  /* The ceiling, reverted to the loose `!isMaterialGap` reading that this
     session replaced. If $2,000 is still refused afterwards, the assertion
     above was passing for some other reason and proves nothing. */
  const loose = await load(src => src.replace(
    'if (!withinFloor || !withinShare) {',
    'if (mat.material) {'))
  const r = loose.buildWriteoff({ ...base(),
    headline: { difference: -2000, as_of: '2026-08-24' },
    detail: { ...base().detail, difference: -2000, xero_balance: 958005, still_unexplained: -2000 } })
  t('⭐ WITHOUT the strict ceiling, $2,000 on this loan is OFFERED as a one-click write-off',
    () => assert.equal(r.eligible, true, `expected the old behaviour to offer it; why: ${r.why}`))
}
{
  /* The lender-document fence. */
  const noAnchor = await load(src => src.replace(
    "if (!WRITEOFF_REAL_ANCHORS.includes(String(detail?.anchor_source ?? ''))) {",
    'if (false) {'))
  const r = noAnchor.buildWriteoff({ ...base(), detail: { ...base().detail, anchor_source: 'xero_derived' } })
  t('⭐ WITHOUT it, a difference measured against OUR OWN record is offered',
    () => assert.equal(r.eligible, true, `why: ${r.why}`))
}
{
  /* The sign. Flipping it must break the stated result, which is the assertion
     a reader of the card would also catch. */
  const flipped = await load(src => src.replace(
    '{ LineAmount: difference, AccountCode: String(code),',
    '{ LineAmount: r2(-difference), AccountCode: String(code),'))
  const r = flipped.buildWriteoff(base())
  t('⭐ WITH the sign flipped the loan leg moves the wrong way',
    () => assert.equal(r.journal.JournalLines.find((l: any) => l.AccountCode === '299').LineAmount, 5))
}

console.log('\n' + '='.repeat(64))
console.log(`  ${pass} passed, ${fail} failed`)
console.log('='.repeat(64))
if (fail) process.exit(1)
