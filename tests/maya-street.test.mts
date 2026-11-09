// maya-street.test.mts — 2026-11-09
// ============================================================================
// Maya verifies a known caller by the street name of their saved address. On Nov 8 Kate Pardi
// (641 Boulevard Way) failed it: "Boulevard" and "Way" were both ignored as describing words, so nothing was
// left to match and no answer could pass. Replaying all 5,460 active addresses found 890 that could never
// pass — 870 numbered streets ("47th Street": words starting with a digit were dropped) and 20 like
// "West Street", "B Street", "Terrace Street".
//
// Replay on that day's addresses (saying the full line, the line without the house number, and the
// abbreviated form): old 4,570 / 5,460 pass, new 5,460 / 5,460, no address that passed before fails now.
// It's a security check, so the NEGATIVE cases below matter as much as the positive ones.
// Run: node --experimental-strip-types tests/maya-street.test.mts
// ============================================================================
import { streetSaid, lineMatches, saidSomething } from '../supabase/functions/maya/street.ts'

let pass = 0, fail = 0
const ok = (c: unknown, name: string) => {
  if (c) { pass++; console.log(`  ok  ${name}`) } else { fail++; console.log(`FAIL  ${name}`) }
}
const m = (line: string, said: string) => { const s = streetSaid(said); return saidSomething(s) && lineMatches(line, s) }
const yes = (line: string, said: string) => ok(m(line, said), `"${said}" matches ${line}`)
const no = (line: string, said: string) => ok(!m(line, said), `"${said}" does NOT match ${line}`)

console.log('named streets (unchanged)')
yes('5521 Telegraph Avenue', 'Telegraph')
yes('5521 Telegraph Avenue', 'telegraph ave')
yes('5521 Telegraph Avenue', 'Telegrph')            // one-letter speech-to-text slip
yes('120 Foothill Blvd', 'Foot hill')
no('5521 Telegraph Avenue', 'Broadway')
no('5521 Telegraph Avenue', '5521')                 // the house number alone is not the street

console.log('Kate Pardi: streets made only of describing words')
yes('641 Boulevard Way', 'Boulevard Way')
yes('641 Boulevard Way', '641 Boulevard Way')
yes('641 Boulevard Way', 'Blvd Way')
yes('3130 West Street', 'West Street')
yes('3130 West Street', 'West St')
yes('4108 Terrace Street', 'Terrace Street')
yes('1318 B Street', 'B Street')
yes('816 West A Street', 'A Street')
no('641 Boulevard Way', 'Boulevard')                // a lone describing word matches nobody
no('3130 West Street', 'Street')
no('3130 West Street', 'West')
no('1318 B Street', 'D Street')                     // one letter apart, different streets
no('1318 B Street', 'Telegraph')
no('5521 Telegraph Avenue', 'Boulevard Way')

console.log('numbered streets')
yes('1032 47th Street', '47th Street')
yes('1032 47th Street', '47th')
yes('1032 47th Street', 'forty-seventh street')
yes('1032 47th Street', 'Forty Seventh')
yes('1601 36th Avenue', '36th Ave')
yes('1715 East 15th Street', 'East 15th Street')
yes('1715 East 15th Street', '15th Street')
yes('10520 108th Avenue', 'one hundred eighth avenue')
yes('500 1st Street', 'First Street')
no('1032 47th Street', '46th Street')
no('1032 47th Street', '1032')                      // house number, not the street
no('1032 47th Street', 'one thousand thirty two')
no('693 39th Street', '39th Avenue')                // Oakland has both: the type must agree when said
no('1032 47th Street', 'Telegraph')
no('5521 Telegraph Avenue', '47th Street')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
