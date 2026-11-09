// Maya's street check: the caller says the street name of a saved address, and we compare it with the
// address line. Pure functions, no I/O, so tests/maya-street.test.mts can run them directly.
//
// Words that only describe a street ("Street", "Ave", "West") and house/unit numbers are ignored; one letter of
// speech-to-text slip is tolerated on longer words.
//
// Two gaps fixed 2026-11-09 (David; Kate Pardi, 641 Boulevard Way, failed the check on Nov 8 — no answer could pass):
//  1. Numbered streets. "47th Street" used to drop "47th" (any word starting with a digit), leaving nothing to
//     match: 870 of 5,460 active addresses. Ordinals now count, and "forty-seventh" matches "47th". Plain numbers
//     ("1032", "Apt 4") are still ignored — that's the house number. Oakland has both 39th Street and 39th
//     Avenue, so when the caller names the type it must agree; "39th" alone still matches either.
//  2. Streets named only with describing words: "Boulevard Way", "West Street", "Terrace Street", "B Street" — 20
//     active addresses. When nothing distinctive is left, the whole name is compared instead ("boulevardway"), and
//     never a lone describing word, so saying just "Street" or "West" matches nobody.

const TYPES: Record<string, string> = {
  st: 'street', street: 'street', ave: 'avenue', av: 'avenue', avenue: 'avenue', blvd: 'boulevard',
  boulevard: 'boulevard', rd: 'road', road: 'road', dr: 'drive', drive: 'drive', way: 'way', ln: 'lane', lane: 'lane',
  ct: 'court', court: 'court', pl: 'place', place: 'place', ter: 'terrace', terrace: 'terrace', cir: 'circle',
  circle: 'circle', pkwy: 'parkway', parkway: 'parkway', hwy: 'highway', highway: 'highway',
};
const DIRS: Record<string, string> = {
  n: 'north', north: 'north', s: 'south', south: 'south', e: 'east', east: 'east', w: 'west', west: 'west',
};
const FILLER = new Set(['the', 'apt', 'unit', 'suite', 'calle', 'avenida', 'and']);

const CARD: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const ORD: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60,
  seventieth: 70, eightieth: 80, ninetieth: 90,
};

export type Street = { words: string[]; keys: string[] };

// words: the distinctive parts ("telegraph", "#47"). keys: the whole name, used only when words is empty.
export function streetParts(t: string): Street {
  const toks = String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const words: string[] = [], canon: string[] = [];
  let acc: number | null = null; // spelled-out number in progress: "one hundred" … "eighth"
  let num = -1; // index in words of a street number just read, so "39th Street" becomes "#39:street"
  for (const w of toks) {
    if (num >= 0 && TYPES[w]) { words[num] += ':' + TYPES[w]; num = -1; continue; }
    num = -1;
    const m = w.match(/^(\d+)(st|nd|rd|th)$/);
    const ordinal = (n: number) => { num = words.push('#' + n) - 1; acc = null; };
    if (m) { ordinal(Number(m[1])); continue; }
    if (w === 'hundred' && acc !== null) { acc *= 100; continue; }
    if (w === 'hundredth' && acc !== null) { ordinal(acc * 100); continue; }
    if (w in CARD) { acc = (acc ?? 0) + CARD[w]; continue; }
    if (w in ORD) { ordinal((acc ?? 0) + ORD[w]); continue; }
    if (w === 'and' && acc !== null) continue;
    acc = null; // a spelled number not ending in an ordinal is a house number: ignored, like digits
    if (/^\d/.test(w) || FILLER.has(w)) continue;
    const plain = TYPES[w] || DIRS[w];
    if (plain) { canon.push(plain); continue; }
    if (w.length >= 3) words.push(w);
    canon.push(w);
  }
  const lone = (k: string) => Object.values(TYPES).includes(k) || Object.values(DIRS).includes(k);
  const dirs = new Set(Object.values(DIRS));
  const keys = words.length ? [] : [...new Set([canon.join(''), canon.filter((w) => !dirs.has(w)).join('')])]
    .filter((k) => k && !lone(k));
  return { words, keys };
}

export function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith('#') || b.startsWith('#')) { // street numbers: the number must match exactly, and the type
    const [an, at] = a.split(':'), [bn, bt] = b.split(':'); // too when both were said ("39th St" ≠ "39th Ave")
    return an === bn && (!at || !bt || at === bt);
  }
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// What the caller said. "Foot hill" → also "foothill".
export function streetSaid(street: string): Street {
  const s = streetParts(street);
  const plain = s.words.filter((w) => !w.startsWith('#'));
  return plain.length > 1 ? { ...s, words: [...s.words, plain.join('')] } : s;
}

export const saidSomething = (said: Street) => said.words.length > 0 || said.keys.length > 0;

export function lineMatches(line1: string, said: Street): boolean {
  const known = streetParts(line1);
  if (said.words.length && known.words.length) return said.words.some((w) => known.words.some((k) => near(w, k)));
  // Whole-name keys must match exactly: "bstreet" and "dstreet" are one letter apart but different streets.
  if (!said.words.length && !known.words.length) return said.keys.some((w) => known.keys.includes(w));
  return false;
}
