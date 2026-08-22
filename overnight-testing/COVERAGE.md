# Coverage Scoreboard — Loan Ingestion Torture Test

Last updated: 2026-08-22, after wave 1 (6 fixtures run against WashRoute Staging).

| Area | Tested | Target |
|---|---:|---:|
| Document structures | 0 | 30 |
| Loan types | 0 | 25 |
| Payment structures | 0 | 30 |
| Interest models | 0 | 20 |
| Balance ambiguity | 0 | 25 |
| Date edge cases | 0 | 20 |
| Cross-document conflicts | 1 | 25 |
| Duplicate scenarios | 1 | 20 |
| Missing-data scenarios | 1 | 20 |
| Metamorphic tests | 0 | 40 |
| Multi-period tests | 1 | 30 |
| Plausible-wrong-result tests | 2 | 50 |

These targets are floors, not stopping rules. Wave 1 deliberately went narrow and
deep on a handful of high-value adversarial cases (per the mission's Test Designer
guidance) rather than spreading thin across all 12 categories — 2 of 6 fixtures
turned up real, reproducible bugs, so that trade-off paid off. Untouched categories
(document structures, loan types, payment structures, interest models, balance
ambiguity, date edge cases, metamorphic tests) are open ground for wave 2.
