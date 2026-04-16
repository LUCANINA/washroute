# Skills update — paste into washroute-preflight SKILL.md

**Where to paste:** At the top of `washroute-preflight/SKILL.md`, immediately after the existing "Golden Rule" block, add this new section. Also consider adding a shorter reference in `washroute/SKILL.md` under "Working Style Notes" so it surfaces on every session boot.

**File paths on your machine:** likely `~/.claude/skills/washroute-preflight/SKILL.md` and `~/.claude/skills/washroute/SKILL.md`.

---

## The Widespread-Issue Rule

**If an audit or investigation surfaces a lot of rows — tens, hundreds, or a recognizable share of the whole dataset — stop and verify before acting. Scale is a strong signal that the "bug" may be intentional behavior you don't understand yet.**

Rule of thumb:

- **0–5 affected rows** → probably a real edge-case bug. Normal fix flow.
- **10–50 rows** → pause. Check if there's a shared pattern (same zone, same template, same source). If the pattern matches an intentional business rule, reclassify before touching data.
- **50+ rows, or more than ~5% of the affected table** → **very likely a false positive**. The threshold or criterion used by the check is probably wrong. Do not apply a bulk fix until you've proven the pattern is genuinely broken.

What "double check" means in practice:

1. **Re-state the check's assumption in plain English.** Example: "I'm assuming `delivery_window_start` must exactly equal `route_template.window_start`." Now ask David (or ask yourself): is that assumption actually the business rule, or is there a narrower valid class I'm missing (sub-windows, overrides, seasonal routes, commercial accounts)?
2. **Sample the flagged rows by hand.** Pull 5–10 representative rows with surrounding context (customer type, source, route template shape, arrival window hours). Do any of them look legitimate when you read the actual data?
3. **Classify before fixing.** Split the flagged rows into categories: *genuinely wrong*, *possibly legitimate*, *definitely legitimate*. Only touch the first category on the first pass. If "possibly legitimate" is non-empty, ask David before batching them.
4. **Run the opposite check.** If an issue looks widespread, also run the audit on the "control" side — another table, another column, another route type. If the same pattern appears everywhere, the criterion is too strict, not the data.
5. **Prefer reversible fixes.** When you do apply a bulk change, snapshot old values into a timestamped table (`_resync_<thing>_<yyyymmdd>`) so you can undo selectively if classification was wrong.

The session-113 lesson: the first pass flagged 153 delivery rows. I assumed they were all wrong and bulk-UPDATEd them. Running the pickup equivalent revealed 88 of 90 flagged rows were legitimate customer sub-windows — which meant my delivery criterion was also overly strict, and 106 of the 153 delivery rows I "fixed" were actually legitimate sub-windows I'd just widened. Restoring them from the snapshot took seconds; noticing the problem took a lucky second check. If the pickup sweep hadn't been run, the regression would have shipped silently and customers would have seen wider delivery windows in SMS than they'd booked.

**Never accept "there are a lot of these, so the fix must be urgent" as a reason to skip re-verification. Scale of the symptom is almost always a scale of the misunderstanding, not the bug.**

---
