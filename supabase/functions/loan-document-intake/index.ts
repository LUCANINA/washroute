// loan-document-intake — v1, DRY RUN ONLY
// =============================================================================
// Session 221, build step 3 of the Document Intake & Cross-Validation plan.
//
// WHAT THIS IS: the server-side half of document intake. Takes an uploaded file,
// extracts its text, classifies what the document IS, extracts structured facts
// WITH PER-FIGURE PROVENANCE, and matches it to a loan. It returns a PROPOSAL.
//
// WHAT THIS IS NOT: a writer. v1 writes NOTHING, ever. There is no `confirm`
// parameter to find. Storage, loan_statements, loan_splits, loan_documents and
// reconciliation_findings are all untouched. Writing arrives in a later version,
// only after the parallel-diff below proves this extractor agrees with the
// browser's on real files.
//
// ---------------------------------------------------------------------------
// THE ONE CONSTRAINT THAT MATTERS MOST — READ BEFORE CHANGING ANY IMPORT:
//
// This MUST use pdf.js at the SAME VERSION the browser uses (3.11.174, see
// admin-dashboard/index.html line ~26) and MUST join text with the SAME
// semantics (`items.map(it => it.str).join(' ')` per page, pages joined by
// '\n'). Session 220 lost hours to three separate parser bugs that existed ONLY
// because offline `pdftotext -layout` output did not match what pdf.js actually
// produces in a browser -- pdf.js interleaves labels with values inline and can
// emit multiple spaces between words, and every regex tuned against pdftotext
// silently failed on the real thing.
//
// Swapping to a different PDF library -- or even a different pdf.js MAJOR
// version -- re-opens that exact wound and invalidates the live verification of
// all six shipped parsers at once. If this import ever has to change, every
// parser must be re-verified against real files in a real browser first. Do not
// treat "it still extracts text" as evidence; the bugs were all in the SPACING
// AND ORDERING of that text, not in whether text came out.
// ---------------------------------------------------------------------------
//
// PROVENANCE IS THE POINT. Every figure returned carries `basis` (what the
// number MEASURES -- principal_only / total_payback / payoff_quote), `as_of`,
// and `source_text` (the literal substring it was read from). Session 221 found
// a live type error where `balance` meant three different things across three
// tables and the reconciliation engine compared them interchangeably, which left
// PayPal carrying an unexplainable discrepancy for nine months. An extracted
// number without a basis is not usable data, so this never emits one.
//
// AUTH: verify_jwt:false at the platform (project convention), enforced
// in-function against profiles.role -- admin/manager/cpa only. CPA is included
// deliberately: this is a read-only advisory endpoint, which is exactly a CPA's
// job, and it cannot write.

import { createClient } from 'jsr:@supabase/supabase-js@2'
// pdfjs-dist 3.x legacy is CommonJS. Under Deno's npm: interop a NAMESPACE import
// yields a binding without getDocument (verified empirically via temp-pdfjs-probe-221 --
// namespace_keys had no getDocument, default_keys did). Use the DEFAULT import and
// resolve defensively, so a future interop change surfaces as a clear error rather
// than a silently-empty extractor.
import pdfjsDefault from 'npm:pdfjs-dist@3.11.174/legacy/build/pdf.js'
const pdfjsLib: any = (pdfjsDefault && typeof (pdfjsDefault as any).getDocument === 'function')
  ? (pdfjsDefault as any)
  : ((pdfjsDefault as any)?.default && typeof (pdfjsDefault as any).default.getDocument === 'function'
      ? (pdfjsDefault as any).default
      : null)

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const EXTRACTOR_ID = 'pdfjs-dist@3.11.174/legacy (deno)'
const PINNED_PDFJS_VERSION = '3.11.174'  // MUST equal the browser's build (index.html ~line 26)
const BROWSER_EXTRACTOR_ID = 'pdf.js 3.11.174 (cdnjs, browser)'

// ── date helpers (ported verbatim from admin-dashboard/index.html) ────────────
function mdyToIso(mdy: string): string {
  const [mm, dd, yyyy] = mdy.split('/')
  return `${yyyy}-${mm}-${dd}`
}
function mdy2ToIso(mdy: string): string {
  const [m, d, yy] = mdy.split('/')
  const yyyy = Number(yy) < 70 ? `20${yy.padStart(2, '0')}` : `19${yy.padStart(2, '0')}`
  return `${yyyy}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
}
const money = (s: string) => parseFloat(String(s).replace(/[$,]/g, ''))

// `fact()` is the only way a number leaves this function. Forcing basis + source
// text through one constructor is what makes an untyped figure unrepresentable.
type Basis = 'principal_only' | 'total_payback' | 'payoff_quote' | 'unknown'
interface Fact {
  field: string
  value: number | string | null
  basis: Basis | null
  as_of: string | null
  source_text: string | null
  confidence: 'high' | 'medium' | 'low'
}
function fact(
  field: string, value: number | string | null, basis: Basis | null,
  as_of: string | null, source_text: string | null,
  confidence: 'high' | 'medium' | 'low' = 'high',
): Fact {
  return { field, value, basis, as_of, source_text, confidence }
}

// ── PDF text extraction ──────────────────────────────────────────────────────
// Join semantics are byte-identical to the browser's _extractPdfText. Do not
// "improve" them (e.g. sorting items by position, collapsing runs of spaces):
// every shipped parser regex is tuned to THIS output, multiple spaces included.
async function extractPdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  // Fail loudly. A null lib here previously would have produced empty text, which is
  // indistinguishable from a scanned/image PDF -- and "couldn't auto-read" is a silent,
  // plausible-looking outcome. An infrastructure failure must never be mistaken for a
  // document that simply had no text.
  if (!pdfjsLib) throw new Error('pdf.js failed to resolve from npm:pdfjs-dist@3.11.174 (CJS interop changed?)')
  const doc = await pdfjsLib.getDocument({
    data: bytes,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise
  let text = ''
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    text += content.items.map((it: any) => it.str).join(' ') + '\n'
  }
  return { text, pages: doc.numPages }
}

async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── Lender statement parsers ─────────────────────────────────────────────────
// Ported VERBATIM from admin-dashboard/index.html (LOAN_PDF_PARSERS). Every
// regex is byte-for-byte identical to the live-verified browser versions --
// this is a port, not a rewrite. `balanceBasis` is the one addition: it records
// which quantity each parser deliberately reads. All six read the lender's
// stated PRINCIPAL balance, never the payoff quote (Ford Pro prints both).
interface ParserResult {
  statementDate: string
  principalBalance: string
  accountNumber: string | null
  explicitSplit?: { principal: number; interest: number }
  totalAmountDue?: number | null
  transactions?: { payments: any[]; fees: any[] } | null
  extraFacts?: Fact[]
}
interface LenderParser {
  lenderLabel: string
  balanceBasis: Basis
  detect: (t: string) => boolean
  extract: (t: string) => ParserResult | null
}

const LOAN_PDF_PARSERS: LenderParser[] = [
  {
    lenderLabel: 'Rapid Finance statement',
    balanceBasis: 'principal_only',
    detect: (text) => /rapidfinance\.com/i.test(text) && /Account ID\s*\d+/i.test(text),
    extract: (text) => {
      const bal = text.match(/Remaining Balance:?\s*\$?([\d,]+\.\d{2})/i)
      const dateRange = text.match(/For Dates:?\s*(\d{2}\/\d{2}\/\d{4})[\s\S]{0,6}?(\d{2}\/\d{2}\/\d{4})/i)
      const acct = text.match(/Account ID\s*(\d+)/i)
      if (!bal || !dateRange) return null
      const txnRe = /(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+\(?\$?([\d,]+\.\d{2})\)?\s+\$?[\d,]+\.\d{2}\s+(Payment|Draw)\b/g
      const feeRe = /(\d{2}\/\d{2}\/\d{4})\s+\$?([\d,]+\.\d{2})\s+(Balance Fee|Draw Fee)\b/g
      const seenTxn = new Set<string>(); const payments: any[] = []; let m
      while ((m = txnRe.exec(text))) {
        const [, date, , amtStr, type] = m
        if (type !== 'Payment') continue
        const key = `${date}|${amtStr}`
        if (seenTxn.has(key)) continue
        seenTxn.add(key)
        payments.push({ date: mdyToIso(date), amount: parseFloat(amtStr.replace(/,/g, '')) })
      }
      const seenFee = new Set<string>(); const fees: any[] = []
      while ((m = feeRe.exec(text))) {
        const [, date, amtStr] = m
        const key = `${date}|${amtStr}`
        if (seenFee.has(key)) continue
        seenFee.add(key)
        fees.push({ date: mdyToIso(date), amount: parseFloat(amtStr.replace(/,/g, '')) })
      }
      const [mm, dd, yyyy] = dateRange[2].split('/')
      return {
        statementDate: `${yyyy}-${mm}-${dd}`,
        principalBalance: bal[1].replace(/,/g, ''),
        accountNumber: acct ? acct[1] : null,
        transactions: (payments.length || fees.length) ? { payments, fees } : null,
      }
    },
  },
  {
    lenderLabel: 'BayFirst SBA statement',
    balanceBasis: 'principal_only',
    detect: (text) => /BAYFIRST\s+NATIONAL\s+BANK/i.test(text) && /SBA\s+LOAN\b/i.test(text),
    extract: (text) => {
      const acct = text.match(/ACCOUNT\s+NUMBER\s+(\d+)/i)
      const balAfter = text.match(/PRINCIPAL\s+BALANCE\s+([\d,]+\.\d{2})/i)
      const principalRow = text.match(/(\d{1,2}\/\d{1,2}\/\d{2})\s+Principal\s+Payment\s+Split\s+Out\s+([\d,]+\.\d{2})/i)
      const interestRow = text.match(/(\d{1,2}\/\d{1,2}\/\d{2})\s+Interest\s+Payment\s+Split\s+Out\s+([\d,]+\.\d{2})/i)
      if (!acct || !balAfter || !principalRow || !interestRow) return null
      return {
        statementDate: mdy2ToIso(principalRow[1]),
        principalBalance: balAfter[1].replace(/,/g, ''),
        accountNumber: acct[1],
        explicitSplit: {
          principal: parseFloat(principalRow[2].replace(/,/g, '')),
          interest: parseFloat(interestRow[2].replace(/,/g, '')),
        },
      }
    },
  },
  {
    lenderLabel: 'iBusiness Funding / FC Marketplace statement',
    balanceBasis: 'principal_only',
    detect: (text) => /FC\s+Marketplace/i.test(text) && /ibusinessfunding\.com/i.test(text),
    extract: (text) => {
      const loanNum = text.match(/Loan\s+Number:\s*(\d+)/i)
      const billingDate = text.match(/Billing\s+Statement\s+Date:\s*(\d{2}\/\d{2}\/\d{4})/i)
      const principalBalance = text.match(/Current\s+Principal\s+Balance:\s*\$?([\d,]+\.\d{2})/i)
      const principalSplit = text.match(/Principal:\s+\$?([\d,]+\.\d{2})/i)
      const interestSplit = text.match(/Interest:\s+\$?([\d,]+\.\d{2})/i)
      if (!loanNum || !billingDate || !principalBalance || !principalSplit || !interestSplit) return null
      const [mm, , yyyy] = billingDate[1].split('/')
      let py = Number(yyyy); let pm = Number(mm) - 1
      if (pm === 0) { pm = 12; py -= 1 }
      return {
        statementDate: `${py}-${String(pm).padStart(2, '0')}-01`,
        principalBalance: principalBalance[1].replace(/,/g, ''),
        accountNumber: loanNum[1],
        explicitSplit: {
          principal: parseFloat(principalSplit[1].replace(/,/g, '')),
          interest: parseFloat(interestSplit[1].replace(/,/g, '')),
        },
      }
    },
  },
  {
    lenderLabel: 'SBA EIDL statement',
    balanceBasis: 'principal_only',
    detect: (text) => /Small\s+Business\s+Administration/i.test(text) && /SBA\s+Loan\s+#/i.test(text),
    extract: (text) => {
      const loanNum = text.match(/SBA\s+Loan\s+#:\s*(\d+)/i)
      const statementDate = text.match(/Statement\s+Date:\s*(\d{2}\/\d{2}\/\d{4})/i)
      const appliedPrincipal = text.match(/Applied\s+to\s+Principal\s+\$?([\d,]+\.\d{2})/i)
      const appliedInterest = text.match(/Applied\s+to\s+Interest\s+\$?([\d,]+\.\d{2})/i)
      const outstandingBalance = text.match(/Outstanding\s+Balance\s+\$?([\d,]+\.\d{2})/i)
      const paymentDue = text.match(/Payment\s+Due\s+\$?([\d,]+\.\d{2})/i)
      if (!loanNum || !statementDate || !appliedPrincipal || !appliedInterest || !outstandingBalance) return null
      return {
        statementDate: mdyToIso(statementDate[1]),
        principalBalance: outstandingBalance[1].replace(/,/g, ''),
        accountNumber: loanNum[1],
        explicitSplit: {
          principal: parseFloat(appliedPrincipal[1].replace(/,/g, '')),
          interest: parseFloat(appliedInterest[1].replace(/,/g, '')),
        },
        totalAmountDue: paymentDue ? parseFloat(paymentDue[1].replace(/,/g, '')) : null,
      }
    },
  },
  {
    lenderLabel: 'Pacific Community Ventures statement',
    balanceBasis: 'principal_only',
    detect: (text) => /myloanpanel\.com/i.test(text) && /Loan\s+ID:/i.test(text),
    extract: (text) => {
      const loanId = text.match(/Loan\s+ID:\s*(\d+)/i)
      const lastPaymentDate = text.match(/Last\s+payment\s+received:\s*(\d{2}\/\d{2}\/\d{4})/i)
      const interest = text.match(/\bInterest:\s+([\d,]+\.\d{2})/i)
      const principal = text.match(/\bPrincipal:\s+([\d,]+\.\d{2})/i)
      const totalReceived = text.match(/Total\s+received:\s+([\d,]+\.\d{2})/i)
      const balance = text.match(/Latest\s+account\s+balance\s*\(before\s+current\s+interest\s+charges\)\s*([\d,]+\.\d{2})/i)
      if (!loanId || !lastPaymentDate || !interest || !principal || !balance) return null
      return {
        statementDate: mdyToIso(lastPaymentDate[1]),
        principalBalance: balance[1].replace(/,/g, ''),
        accountNumber: loanId[1],
        explicitSplit: {
          principal: parseFloat(principal[1].replace(/,/g, '')),
          interest: parseFloat(interest[1].replace(/,/g, '')),
        },
        totalAmountDue: totalReceived ? parseFloat(totalReceived[1].replace(/,/g, '')) : null,
      }
    },
  },
  {
    lenderLabel: 'Ford Pro FinSimple statement (PDF)',
    balanceBasis: 'principal_only',
    detect: (text) => /ford\.com\/finance/i.test(text) && /Your\s+Transactions\s+Since\s+Last\s+Statement/i.test(text),
    extract: (text) => {
      const acct = text.match(/Account\s+Number:\s*(\d+)/i)
      const principalBal = text.match(/Principal\s+Balance:\s*\$?([\d,]+\.\d{2})/i)
      const principalSplit = text.match(/\bPrincipal\s+\$?([\d,]+\.\d{2})/i)
      const interestSplit = text.match(/\bInterest\s+\$?([\d,]+\.\d{2})/i)
      const paymentDate = text.match(/(\d{2}\/\d{2}\/\d{4})\s+Payment\s+Received/i)
      if (!acct || !principalBal || !principalSplit || !interestSplit || !paymentDate) return null
      // Ford Pro prints a PAYOFF QUOTE on the same page as the principal balance
      // ($16,873.78 vs $16,755.81 on the July 2026 statement). The parser
      // deliberately reads the principal balance -- but the payoff figure is
      // surfaced here as its own separately-based fact rather than discarded,
      // so a later cross-check can use it without any risk of the two being
      // confused for one another.
      const payoff = text.match(/Payoff\s+Amount:\*?\s*\$?([\d,]+\.\d{2})/i)
      const goodThru = text.match(/Good\s+Thru:\s*(\d{2}\/\d{2}\/\d{4})/i)
      const extraFacts: Fact[] = []
      if (payoff) {
        extraFacts.push(fact(
          'payoff_amount', money(payoff[1]), 'payoff_quote',
          goodThru ? mdyToIso(goodThru[1]) : null, payoff[0],
        ))
      }
      return {
        statementDate: mdyToIso(paymentDate[1]),
        principalBalance: principalBal[1].replace(/,/g, ''),
        accountNumber: acct[1],
        explicitSplit: {
          principal: parseFloat(principalSplit[1].replace(/,/g, '')),
          interest: parseFloat(interestSplit[1].replace(/,/g, '')),
        },
        extraFacts,
      }
    },
  },
]

// ── CSV parsers (ported verbatim) ────────────────────────────────────────────
function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let inQuotes = false
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue }
    if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur); return out
}

function parsePayPalHistoryCsv(text: string) {
  const lines = text.trim().split(/\r?\n/)
  const header = lines[0].split(',').map((h) => h.trim())
  const need = ['Date', 'Description', 'Amount', 'Principal', 'Fee']
  if (!need.every((h) => header.includes(h))) return null
  const idx: Record<string, number> = Object.fromEntries(header.map((h, i) => [h, i]))
  const m = (s: string) => parseFloat(String(s).replace(/\$/g, '').replace(/,/g, '')) || 0
  const rows = lines.slice(1).map(splitCsvLine).map((cols) => ({
    date: cols[idx.Date],
    description: (cols[idx.Description] || '').trim(),
    amount: m(cols[idx.Amount]),
    principal: m(cols[idx.Principal]),
    fee: m(cols[idx.Fee]),
  })).filter((r) => r.date)
  if (!rows.length) return null
  const chrono = [...rows].reverse()
  let balance = 0
  const periods: any[] = []
  for (const row of chrono) {
    balance += row.principal
    if (row.description === 'Wire' || row.description === 'Total Loan Fee') continue
    periods.push({
      statementDate: mdyToIso(row.date),
      principalBalance: balance.toFixed(2),
      explicitSplit: { principal: Math.abs(row.principal), interest: Math.abs(row.fee) },
      totalAmountDue: Math.abs(row.amount),
    })
  }
  return periods.length ? periods : null
}

function parseFordProCsv(text: string) {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return null
  const header = lines[0].split(',').map((h) => h.trim())
  const vals = splitCsvLine(lines[1])
  const row: Record<string, string> = Object.fromEntries(header.map((h, i) => [h, (vals[i] || '').trim()]))
  if (!row.Principal_Balance || !row.Account_Number || !row.Statement_Date) return null
  return row
}

// ── Document classification ──────────────────────────────────────────────────
// v1 is deliberately deterministic-only. A document this cannot positively
// identify comes back `unknown` with needs_human -- it is NEVER guessed at.
// AI-assisted routing for unrecognised documents is build step 7, and even then
// it will only ever choose a ROUTE, never originate a figure.
const KIND_HEURISTICS: Array<{ kind: string; confidence: 'medium' | 'low'; test: (t: string) => boolean }> = [
  { kind: 'payoff_letter', confidence: 'medium',
    test: (t) => /payoff\s+(letter|quote|statement|amount)/i.test(t) && /good\s+(thru|through)|valid\s+(thru|through|until)/i.test(t) },
  { kind: 'amortization_schedule', confidence: 'medium',
    test: (t) => /amortization\s+(schedule|table)/i.test(t) || (/\bPmt\s*(No|#)/i.test(t) && /\bBalance\b/i.test(t) && /\bInterest\b/i.test(t)) },
  { kind: 'agreement', confidence: 'low',
    test: (t) => /(loan|credit|security)\s+agreement/i.test(t) && /borrower/i.test(t) && /lender/i.test(t) },
  { kind: 'correspondence', confidence: 'low',
    test: (t) => /dear\s+(borrower|customer|sir|madam)/i.test(t) },
]

Deno.serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Content-Type': 'application/json',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: cors })
    }

    // ── auth: in-function role check (platform verify_jwt is false by project
    //    convention). cpa is allowed -- this endpoint cannot write.
    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (!token) return new Response(JSON.stringify({ error: 'Missing Authorization' }), { status: 401, headers: cors })
    const anon = createClient(SUPABASE_URL, ANON_KEY)
    const { data: userData, error: userErr } = await anon.auth.getUser(token)
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: cors })
    }
    const supa = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const { data: prof } = await supa.from('profiles').select('role').eq('id', userData.user.id).single()
    const role = prof?.role
    if (!['admin', 'manager', 'cpa'].includes(role)) {
      return new Response(JSON.stringify({ error: `Forbidden (role: ${role ?? 'none'})` }), { status: 403, headers: cors })
    }

    const body = await req.json()
    const { base64, filename, loan_account_id, return_text } = body
    if (!base64 || !filename) {
      return new Response(JSON.stringify({ error: 'base64 and filename are required' }), { status: 400, headers: cors })
    }
    // Refuse loudly if a caller tries to make this write. There is no write path
    // in v1; a silent no-op would be worse than an error, because the caller
    // would believe something was saved.
    if (body.confirm === true || body.dry_run === false) {
      return new Response(JSON.stringify({
        error: 'loan-document-intake v1 is DRY RUN ONLY and has no write path. ' +
               'Remove `confirm`/`dry_run:false`. Writing is a later version, gated on the ' +
               'browser/server extraction parallel-diff passing first.',
      }), { status: 400, headers: cors })
    }

    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const fileSha = await sha256Hex(bytes)
    const isPdf = /\.pdf$/i.test(filename)
    const isCsv = /\.csv$/i.test(filename)

    let text = ''
    let pages: number | null = null
    let extractionError: string | null = null
    if (isPdf) {
      try {
        const r = await extractPdfText(bytes)
        text = r.text; pages = r.pages
      } catch (e) {
        extractionError = String(e)
      }
    } else if (isCsv) {
      text = new TextDecoder().decode(bytes)
    } else {
      extractionError = `Unsupported file type for text extraction: ${filename}`
    }

    const textSha = text ? await sha256Hex(text) : null

    // ── classify + extract ────────────────────────────────────────────────────
    let kind = 'unknown'
    let lenderLabel: string | null = null
    let confidence: 'high' | 'medium' | 'low' = 'low'
    let method = 'none'
    const facts: Fact[] = []
    let accountNumber: string | null = null
    let periodCount: number | null = null

    if (isPdf && text) {
      for (const p of LOAN_PDF_PARSERS) {
        if (!p.detect(text)) continue
        const r = p.extract(text)
        if (!r) continue
        kind = 'lender_statement'; lenderLabel = p.lenderLabel
        confidence = 'high'; method = 'deterministic_lender_parser'
        accountNumber = r.accountNumber
        facts.push(fact('statement_date', r.statementDate, null, r.statementDate, null))
        facts.push(fact('principal_balance', Number(r.principalBalance), p.balanceBasis, r.statementDate, null))
        if (r.explicitSplit) {
          facts.push(fact('applied_principal', r.explicitSplit.principal, null, r.statementDate, null))
          facts.push(fact('applied_interest', r.explicitSplit.interest, null, r.statementDate, null))
        }
        if (r.totalAmountDue != null) facts.push(fact('total_amount_due', r.totalAmountDue, null, r.statementDate, null))
        if (r.transactions) {
          facts.push(fact('transaction_count',
            (r.transactions.payments?.length || 0) + (r.transactions.fees?.length || 0), null, r.statementDate, null))
        }
        if (r.extraFacts) facts.push(...r.extraFacts)
        break
      }
    } else if (isCsv && text) {
      const pp = parsePayPalHistoryCsv(text)
      if (pp) {
        kind = 'transaction_history'; lenderLabel = 'PayPal loan history CSV'
        confidence = 'high'; method = 'deterministic_csv_parser'
        periodCount = pp.length
        const last = pp[pp.length - 1]
        facts.push(fact('period_count', pp.length, null, null, null))
        facts.push(fact('period_range', `${pp[0].statementDate} .. ${last.statementDate}`, null, null, null))
        // Derived from the file's own Principal column, so this is principal
        // basis -- NOT the total_payback basis PayPal's amortization schedule
        // uses. That distinction is exactly what the basis field exists for.
        facts.push(fact('principal_balance', Number(last.principalBalance), 'principal_only', last.statementDate, null))
      } else {
        const fp = parseFordProCsv(text)
        if (fp) {
          kind = 'lender_statement'; lenderLabel = 'Ford Pro FinSimple statement (CSV)'
          confidence = 'high'; method = 'deterministic_csv_parser'
          accountNumber = fp.Account_Number
          facts.push(fact('statement_date', fp.Statement_Date, null, fp.Statement_Date, null))
          facts.push(fact('principal_balance', money(fp.Principal_Balance), 'principal_only', fp.Statement_Date, null))
          if (fp.Total_Amount_Due) facts.push(fact('total_amount_due', money(fp.Total_Amount_Due), null, fp.Statement_Date, null))
        }
      }
    }

    // Heuristic kind hints, only when no deterministic parser claimed the file.
    // These are explicitly NOT authoritative -- they never carry high confidence
    // and never produce a financial figure.
    if (kind === 'unknown' && text) {
      for (const h of KIND_HEURISTICS) {
        if (h.test(text)) { kind = h.kind; confidence = h.confidence; method = 'heuristic_text_match'; break }
      }
    }

    // ── loan matching ─────────────────────────────────────────────────────────
    const { data: loans } = await supa.from('loan_accounts')
      .select('id, lender, lender_account_number, status, ingestion_method, xero_account_code')
    let loanMatch: any = { matched: false, matched_on: null, loan_account_id: null, candidates: [] }
    if (accountNumber && loans) {
      const exact = loans.filter((l: any) => l.lender_account_number === accountNumber)
      if (exact.length === 1) {
        loanMatch = {
          matched: true, matched_on: 'account_number_exact',
          loan_account_id: exact[0].id, lender: exact[0].lender,
          lender_account_number: exact[0].lender_account_number, candidates: [],
        }
      } else if (exact.length > 1) {
        loanMatch = { matched: false, matched_on: 'account_number_ambiguous', loan_account_id: null,
          candidates: exact.map((l: any) => ({ id: l.id, lender: l.lender, acct: l.lender_account_number })) }
      }
    }
    if (!loanMatch.matched && loan_account_id && loans) {
      const supplied = loans.find((l: any) => l.id === loan_account_id)
      if (supplied) {
        loanMatch = {
          matched: true, matched_on: 'caller_supplied', loan_account_id: supplied.id,
          lender: supplied.lender, lender_account_number: supplied.lender_account_number,
          candidates: [],
          // A caller-supplied loan is an assertion, not evidence. If the document
          // also states an account number and it disagrees, say so loudly rather
          // than trusting the dropdown.
          conflict: accountNumber && supplied.lender_account_number !== accountNumber
            ? { document_states: accountNumber, selected_loan_is: supplied.lender_account_number }
            : null,
        }
      }
    }

    const needsHuman = kind === 'unknown' || confidence !== 'high' || !loanMatch.matched

    return new Response(JSON.stringify({
      ok: true,
      dry_run: true,
      wrote_nothing: true,
      file: { filename, bytes: bytes.length, sha256: fileSha },
      extraction: {
        engine: EXTRACTOR_ID,
        browser_engine_for_diff: BROWSER_EXTRACTOR_ID,
        // Reported from the LOADED library, not the pinned string, so a silent
        // version drift (npm resolution changing under us) is visible in every
        // response instead of only surfacing as mysterious parser failures.
        resolved_pdfjs_version: pdfjsLib?.version ?? null,
        version_matches_browser: (pdfjsLib?.version ?? null) === PINNED_PDFJS_VERSION,
        pages, text_length: text.length, text_sha256: textSha,
        error: extractionError,
        // Returned only on request so the browser can byte-diff its own
        // extraction against this one during the parallel-diff rollout.
        text: return_text ? text : null,
      },
      classification: { kind, lender_label: lenderLabel, confidence, method },
      loan_match: loanMatch,
      facts,
      period_count: periodCount,
      needs_human: needsHuman,
      notes: [
        'v1 is dry-run only and wrote nothing.',
        needsHuman
          ? 'This document could not be positively identified and matched; a human must confirm before anything is filed.'
          : 'Deterministically identified and matched. Still requires human approval before any write, by design.',
      ],
    }), { status: 200, headers: cors })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), wrote_nothing: true }), { status: 500, headers: cors })
  }
})
