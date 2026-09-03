// tests/transcriber-instructions.test.mts — the three places that tell the
// screenshot transcriber what to do must agree with the schema it is given.
//
// WHY THIS FILE EXISTS
// `lender_account_ref` was added to PORTAL_TOOL's schema, and the account number
// went unread twice in a row anyway. The schema asked for an identifier while
// the SYSTEM PROMPT said "report only figures"; that was fixed, and it went
// unread a THIRD time because two other instructions — the tool's own
// `description` and the user turn beside the image — still said the same thing.
// Three instructions, one changed, and the model quite reasonably followed the
// two that still said numbers.
//
// A model's output cannot be asserted offline. What CAN be asserted is that the
// instructions do not contradict the schema, which is the actual defect both
// times. This reads the source as text on purpose: loan-bundle/index.ts pulls in
// pdf.js and cannot be imported here.
//
// Run:  npx tsx tests/transcriber-instructions.test.mts

import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

const src = readFileSync(new URL('../supabase/functions/loan-bundle/index.ts', import.meta.url), 'utf8')

section('every instruction agrees with the schema it is given')
{
  // 1. the schema still asks for it
  ok('the schema carries lender_account_ref',
     /lender_account_ref:\s*\{\s*type:\s*'string'/.test(src))

  // 2. the tool's own description
  const desc = src.match(/description:\s*'Transcribe[^']*'/)?.[0] ?? ''
  ok('the tool description exists', desc.length > 0)
  ok('...and it asks for the identifier too',
     /identifier/i.test(desc), desc)

  // 3. the user turn beside the image
  const userTurn = src.match(/text:\s*'Transcribe the labelled totals on this lender portal screenshot[^']*'/)?.[0] ?? ''
  ok('the user turn exists', userTurn.length > 0)
  ok('...and it asks for the identifier too',
     /identifier/i.test(userTurn), userTurn)

  // 4. the system prompt
  ok('the system prompt names the identifier',
     /Report it in\\n' \+\s*'lender_account_ref/.test(src) || /lender_account_ref, exactly as printed/.test(src))
}

section('nothing tells it to report numbers ONLY')
{
  // The exact wording that caused this, in any of the three places. "Report only
  // figures printed on the image" reads as "numbers only" and silently excludes
  // an account number sitting in plain sight.
  ok('no instruction says "only figures"',
     !/only figures printed/i.test(src),
     (src.match(/.{60}only figures printed.{40}/i) || [''])[0])
  ok('no instruction says "figures only"', !/figures only/i.test(src))

  // The replacement wording is deliberately about WHAT IS PRINTED, not about
  // what kind of thing it is.
  ok('the surviving rule is about what is printed',
     /Report ONLY what is printed on the image/.test(src))
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
