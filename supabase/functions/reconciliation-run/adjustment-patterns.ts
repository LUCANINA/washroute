// ============================================================================
// Learned per-loan adjustment patterns (session 258).
//
// Motivation: Paypal 2's CPA hand-posted the same kind of correction seven times
// over seven months ("to match end balance", "to reclass the payment made for
// paypal") because Xero's bank rule applied every auto-draft entirely to
// principal at draft time. Each one sat in unexplained_ledger_adjustment forever
// -- the check is honest ("I can't explain this") but never learns, so the same
// explainable thing gets re-flagged as a fresh mystery every month, on every
// loan, for every different CPA's habits.
//
// This module is the middle layer: PURE functions only, same discipline as
// double-reallocation.ts, so matching logic can be unit-tested without booting
// the whole edge function. reconciliation-run/index.ts owns all the DB IO --
// this file only ever answers "does this journal match that pattern" and
// "do these journals look like a new pattern", never touches a client.
//
// The guardrail that matters most: narration text is a LABEL, never proof.
// matchAgainstPatterns only recognizes a journal when its account pair AND its
// narration both agree, and its two lines net to zero -- the same three-part
// evidence bar double-reallocation.ts insists on, for the same reason: a false
// "this is explained" is worse than an honest "still unexplained", because it
// teaches the reader to stop looking. A journal that fails any one of those
// three checks stays exactly where it is today -- flagged, not silently
// absorbed.
// ============================================================================

export type PatternJournalLine = { c: string; a: number }
export type PatternJournal = {
  srcId: string
  date: string
  narration?: string | null
  lines: PatternJournalLine[]
}

export type AdjustmentPattern = {
  id: string
  loan_account_id: string
  label: string
  debit_account_code: string
  credit_account_code: string
  narration_signatures: string[]
  status: 'active' | 'dormant' | 'retired'
}

export type Finding = {
  fingerprint: string; check_key: string; severity: 'info' | 'warn' | 'error'
  loan_account_id: string | null; title: string; plain_english: string
  detail: any; proposed_action?: any
}

const norm = (s: unknown) => String(s ?? '').toLowerCase()
const EPS = 0.01

// The exact "which hand-posted journals are unexplained" computation
// checkUnexplainedLedgerAdjustment (index.ts) has always used, pulled out here
// so the pattern-matching pre-step and that check can never silently diverge
// on what counts as unexplained.
export function unexplainedHandPosted(
  loan: { xero_account_code: string; ingestion_method?: string; status?: string },
  ledger: any, splits: any[], windowFrom: string,
): PatternJournal[] {
  if (loan.ingestion_method === 'automatic') return []
  if (loan.status === 'paid_off') return []
  const code = loan.xero_account_code
  const ours = new Set((splits || [])
    .map((sp: any) => sp.xero_manual_journal_id)
    .filter(Boolean)
    .map((id: any) => String(id).toLowerCase()))
  return (ledger[code] || []).filter((r: any) =>
    r.srcType === 'ManualJournal'
    && r.date >= windowFrom
    && !ours.has(String(r.srcId || '').toLowerCase()))
}

// A pure two-line reclassification: exactly one line on each side of the pair,
// net to zero. Anything with a third line, or that doesn't net to zero, is not
// the shape any confirmed pattern here has ever had -- treat it as a one-off,
// not a candidate.
function asCleanReclass(j: PatternJournal, debitCode: string, creditCode: string) {
  if (j.lines.length !== 2) return null
  const debitLine = j.lines.find(l => l.c === debitCode)
  const creditLine = j.lines.find(l => l.c == creditCode)
  if (!debitLine || !creditLine) return null
  if (Math.abs(Number(debitLine.a) + Number(creditLine.a)) > EPS) return null
  return { debitLine, creditLine }
}

// ── Matching against already-confirmed patterns ──────────────────────────
export function matchAgainstPatterns(journals: PatternJournal[], patterns: AdjustmentPattern[]) {
  const active = patterns.filter(p => p.status === 'active')
  const matched: { journal: PatternJournal; pattern: AdjustmentPattern }[] = []
  const unmatched: PatternJournal[] = []

  for (const j of journals) {
    const narr = norm(j.narration)
    const hit = active.find(p =>
      asCleanReclass(j, p.debit_account_code, p.credit_account_code)
      && p.narration_signatures.some(sig => narr.includes(norm(sig))))
    if (hit) matched.push({ journal: j, pattern: hit })
    else unmatched.push(j)
  }
  return { matched, unmatched }
}

// Given a matched journal and the loan's own account code, the split row this
// journal represents. Sign convention matches every other loan_splits row:
// principal_amount is what moved the LOAN's own liability (positive = paid
// down further), interest_amount is the offsetting move in the other account,
// total_amount is always 0 -- this is a reclassification, not a payment
// (split_invariant_check's own 'reclassification' shape, added for this).
export function splitRowForMatch(loanCode: string, journal: PatternJournal) {
  const loanLine = journal.lines.find(l => l.c === loanCode)
  if (!loanLine) return null
  const principal = Number(loanLine.a)
  return {
    period_label: `${journal.date}-adj`,
    principal_amount: Math.round(principal * 100) / 100,
    interest_amount: Math.round(-principal * 100) / 100,
    total_amount: 0,
    xero_manual_journal_id: journal.srcId,
    status: 'already_in_xero' as const,
    source: 'manual_adjustment' as const,
    posting_method: 'manual_journal' as const,
  }
}

// ── Proposing NEW patterns from journals nothing already explains ─────────
const STOPWORDS = new Set([
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'the', 'to', 'of', 'a', 'an', 'and', 'for', 'in', 'on', 'at', 'from',
])
const words = (s: string) => norm(s).split(/[^a-z]+/).filter(w => w.length >= 4 && !STOPWORDS.has(w))

export type PatternCandidate = {
  debit_account_code: string
  credit_account_code: string
  shared_words: string[]
  journals: PatternJournal[]
}

// Groups unexplained journals by (the two accounts involved, EITHER direction)
// + (shared vocabulary in the narration), keeping only groups with at least
// `minCount` members and at least `minSharedWords` words in common -- two
// different one-off narrations that happen to touch the same two accounts must
// NOT merge into a false pattern. Grouping is direction-agnostic on purpose:
// Paypal 2's own true-up sometimes credited 284 and sometimes debited it,
// depending which way that month's drift ran, and it is still one habit
// between the same two accounts -- April's negative instance is exactly the
// case that first caught this (see adjustment-patterns.test.ts).
//
// This deliberately does NOT try to guess that differently-worded narrations
// describe the same underlying habit (Paypal 2's CPA used three different
// phrasings for one habit; this groups the five that share "match end
// balance" and leaves the other two as their own singletons, below minCount)
// -- that judgement call is for the human confirming it, who can widen
// narration_signatures by hand once they recognize the connection.
export function clusterCandidates(
  journals: PatternJournal[], loanCode: string,
  opts: { minCount?: number; minSharedWords?: number } = {},
): PatternCandidate[] {
  const minCount = opts.minCount ?? 2
  const minSharedWords = opts.minSharedWords ?? 2

  type Group = { other: string; tokens: Set<string>; journals: PatternJournal[] }
  const groups: Group[] = []

  for (const j of journals) {
    const loanLine = j.lines.find(l => l.c === loanCode)
    const otherLine = j.lines.find(l => l.c !== loanCode)
    if (j.lines.length !== 2 || !loanLine || !otherLine) continue
    if (Math.abs(Number(loanLine.a) + Number(otherLine.a)) > EPS) continue

    const other = otherLine.c
    const w = new Set(words(j.narration ?? ''))
    if (!w.size) continue

    let best: Group | null = null
    let bestOverlap = 0
    for (const g of groups) {
      if (g.other !== other) continue
      const overlap = [...g.tokens].filter(t => w.has(t)).length
      if (overlap > bestOverlap) { best = g; bestOverlap = overlap }
    }
    if (best && bestOverlap >= minSharedWords) {
      best.tokens = new Set([...best.tokens].filter(t => w.has(t)))
      best.journals.push(j)
    } else {
      groups.push({ other, tokens: w, journals: [j] })
    }
  }

  return groups
    .filter(g => g.journals.length >= minCount && g.tokens.size >= minSharedWords)
    .map(g => ({
      // Convention only, matching how a confirmed pattern row is stored: the
      // loan's own account first, its counterpart second. matchAgainstPatterns
      // does not care which line is which -- see asCleanReclass.
      debit_account_code: loanCode, credit_account_code: g.other,
      shared_words: [...g.tokens].sort(), journals: g.journals,
    }))
}

export function candidateLabel(c: PatternCandidate, loanName: string): string {
  const phrase = c.shared_words.join(' ')
  return `Recurring hand adjustment on ${loanName}: narration repeatedly mentions "${phrase}" `
    + `(seen ${c.journals.length} times). Confirm what this represents and I'll recognize it `
    + `automatically going forward instead of re-flagging it each time.`
}

// One finding per proposed pattern, on the Approvals queue (recon_finding-style,
// not Issues -- Issues stays loan-variance-only). severity 'info': this is a
// proposal, not a problem. proposed_action.kind='confirm_adjustment_pattern'
// carries everything admin-dashboard needs to insert the loan_adjustment_patterns
// row in one click if the CPA/David agrees, or to ignore it if not -- nothing
// is recognized automatically until a human confirms it once.
export function checkAdjustmentPatternCandidates(
  loan: { id: string; xero_account_code: string; xero_account_name: string },
  candidates: PatternCandidate[],
): Finding[] {
  return candidates.map(c => {
    const ids = c.journals.map(j => j.srcId)
    const dates = c.journals.map(j => j.date).sort()
    const phrase = c.shared_words.join(' ')
    return {
      fingerprint: `adjustment_pattern_candidate:${loan.xero_account_code}:${phrase.replace(/\s+/g, '-')}`,
      check_key: 'adjustment_pattern_candidate',
      severity: 'info',
      loan_account_id: loan.id,
      title: `${loan.xero_account_name} — ${c.journals.length} hand-posted corrections look like the same recurring habit`,
      plain_english: candidateLabel(c, loan.xero_account_name),
      detail: {
        code: loan.xero_account_code,
        date: dates[dates.length - 1],
        shared_words: c.shared_words,
        debit_account_code: c.debit_account_code,
        credit_account_code: c.credit_account_code,
        journal_ids: ids,
        examples: c.journals.slice(0, 4).map(j => ({ date: j.date, narration: j.narration })),
      },
      proposed_action: {
        kind: 'confirm_adjustment_pattern',
        note: `Confirm this is one recurring habit and it'll be recognized automatically going forward instead of being flagged each time it happens.`,
        payload: {
          loan_account_id: loan.id,
          debit_account_code: c.debit_account_code,
          credit_account_code: c.credit_account_code,
          narration_signatures: c.shared_words,
          example_journal_ids: ids,
        },
      },
    }
  })
}
