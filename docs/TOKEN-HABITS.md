# Token habit card — pin this

Compute budget = **tokens used x model used**. Every habit below moves one of the two.

---

## The four habits

### 1. `/clear` when you switch tasks
Context is cumulative. Finishing loans and starting on route stops without
clearing means every route-stop turn re-reads the entire loan conversation.
**Clear between unrelated tasks. Not between steps of the same task.**

### 2. Work in focus blocks
Cached context is far cheaper to re-read than fresh context, and the cache stays
warm for an hour. Four sessions on WashRoute in one afternoon cost much less than
the same four spread across a week. **Batch work on one project into one sitting.**

### 3. Dial effort to the task
Renaming a variable does not need the same reasoning depth as designing a
migration. Say "quick fix, don't overthink it" for mechanical work — you pay for
thinking tokens too.

### 4. `/compact` around 60% context
Waiting until you are nearly full means compaction happens under pressure and
loses more. **Compact at ~60%, before it is urgent.** After a compact, re-state
the one or two facts that matter most — cheaper than making Claude re-derive them.

---

## WashRoute-specific

### Never read a PROJECT-NOTES file whole
| File | Size | Cost if read whole |
|---|---|---|
| `PROJECT-NOTES-ARCHIVE.md` | 1.1 MB | ~274,000 tokens |
| `PROJECT-NOTES.md` | 967 KB | ~242,000 tokens |
| `PROJECT-NOTES-BOOKKEEPING.md` | 936 KB | ~234,000 tokens |

One accidental full read costs **more than three entire sessions** of preload.
Always `grep -n "<topic>"` first, then read around the hits. Sessions are logged
newest-first, so the top ~300 lines cover recent work.

### Load the narrow skill, not the wide one
`washroute-bookkeeping` **instead of** `washroute` for Loans / Payroll /
Reconciliation work — not on top of it.

### Say which area you're in
"I'm working on authorization" lets Claude read one `docs/washroute/` file
instead of guessing across several.

---

## What NOT to cut

Concise means less filler, not less explanation. Keep asking for plain-language
reasoning and step-by-step instructions — that is the part worth paying for.
The savings come from preamble, restated questions, unrequested option lists,
and victory laps.

Never trim these to save tokens:
- Trigger phrases in a safety skill's description (`washroute-preflight`)
- Migration review, preflight checks, or QA passes
- The "why" behind a change you will have to maintain

---

## Scoreboard

| | Tokens |
|---|---|
| Preload measured 2026-09-02 | **72,163** |
| After removing 13 unused connectors | ~68,000 |
| `washroute` skill: 25,600 -> 1,850 | **-23,750** |
| **Typical session start: ~97,800 -> ~69,850** | **~29% cut** |

Re-measure in a week: read the first request's usage block in this session's
transcript under `~/.claude/projects/`, and add
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
Full method in `TOKEN-BASELINE.md`.
