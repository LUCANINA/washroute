# Token baseline — measured 2026-09-02

Source: this session's own transcript on disk
(`~/.claude/projects/…scratch-2026-09-02-2d0677/f040a793-….jsonl`), first request.

## THE NUMBER (the "before")

**Preload = 72,163 tokens.** What every new session costs before David types a word.

| Component of the first request | Tokens |
|---|---|
| `input_tokens` | 2 |
| `cache_creation_input_tokens` | 33,232 |
| `cache_read_input_tokens` | 38,929 |
| **Total** | **72,163** |

Note: this session started with no project folder, so 72,163 covers the **global
layer only** (harness prompt, tool schemas, MCP servers, skill descriptions,
global CLAUDE.md). A real WashRoute session adds the repo's CLAUDE.md on top.

## Breakdown, largest-first

Measured on disk. Bytes / 4 ≈ tokens.

### Loads on EVERY session (the preload)
| Item | Size | ≈ tokens |
|---|---|---|
| Harness system prompt + loaded tool schemas + MCP server instructions | (remainder) | ~55,000 |
| Deferred MCP tool-name list (~250 names, 12 connectors) | ~14 KB | ~3,500 |
| Built-in skill descriptions (code-review, dataviz, artifact-*, design, loop…) | — | ~3,000 |
| Personal skill descriptions (21 skills) | 10,985 B | ~2,750 |
| WashRoute `CLAUDE.md` | 3,829 B | ~960 |
| Global `~/.claude/CLAUDE.md` (BuildPartner block) | 564 B | ~140 |

### Loads on INVOCATION (not preload, but paid the moment CLAUDE.md's table fires)
| Skill | Size | ≈ tokens |
|---|---|---|
| `washroute` | 102,319 B | **~25,600** |
| `washroute-audit` | 73,990 B | **~18,500** |
| `washroute-bookkeeping` | 46,402 B | ~11,600 |
| `washroute-migration-review` | 21,319 B | ~5,300 |
| `washroute-qa` | 14,200 B | ~3,550 |
| `washroute-preflight` | 11,493 B | ~2,870 |
| `washroute-changelog` | 8,914 B | ~2,230 |
| `washroute-test` | 4,835 B | ~1,210 |

CLAUDE.md routes *any* WashRoute session to `washroute`, and a start-of-day
session to `washroute-audit` as well: **72K preload + ~44K skills ≈ 116K tokens
before the first real instruction.**

### The landmine
| File | Size | ≈ tokens if read whole |
|---|---|---|
| `PROJECT-NOTES-ARCHIVE.md` | 1,096,010 B | ~274,000 |
| `PROJECT-NOTES.md` | 966,844 B | ~242,000 |
| `PROJECT-NOTES-BOOKKEEPING.md` | 935,541 B | ~234,000 |

CLAUDE.md already says "grep them, don't read them whole" — that rule is the
single most valuable line in the file. One accidental whole-file read of
`PROJECT-NOTES.md` costs more than three full sessions of preload.

## This session's spend (43 assistant turns, mostly small shell reads)
- cache creation: 102,956
- cache read: 3,440,691
- output: 17,093
- total input billed-ish: **3,543,733**

Cache read dominates: the 72K preload is re-read on every single turn. That is
exactly why shrinking the preload compounds — it is multiplied by turn count.

## Top limit-consumers, largest-first
1. Harness prompt + tool schemas + 12 MCP connectors — re-read every turn (~55K x turns)
2. `washroute` skill body (~25.6K) — loaded on essentially every session
3. `washroute-audit` skill body (~18.5K) — loaded at start of day
4. Whole-file reads of the ~1 MB PROJECT-NOTES files (~240K each) — rare but catastrophic
5. Deferred MCP tool-name list (~3.5K) from 12 connectors, most unused per session
