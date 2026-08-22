# Ford Pro FinSimple — what the full histories prove (2026-08-22)

Source: the five lender transaction-history PDFs (accounts ****4140, ****7019/E4-9744, ****4751, ****2094/E6-7410, ****8562), every balance walk verified internally to the cent.

## The answer to the big one

**The $7,687.53 payment (Xero: dated 2026-05-15, coded to 242 / E-Transit Loan - 4140) is the payoff of the N202 loan (****8562).** Proven to the cent from the lender's own records:

- 8562's balance after its last regular payment (04/26/2026) was **$12,653.54**.
- 05/05/2026: a **$5,000.00 principal payment** → balance $7,653.54.
- 05/14/2026: payoff of **$7,653.54 principal + $33.99 interest = $7,687.53** → balance **$0.00**. (Interest verified from the account's Interest-Paid-YTD figure: $371.52 − $337.53 of regular 2026 interest = $33.99.)

**Fix: recode the $7,687.53 bank line from 242 (4140) to 238 (E-Transit N202 Loan - 8562).** After that, 238 should sit at exactly $0.00 in Xero (the loan is closed at the lender), and 4140 loses the biggest wrong entry it was carrying. Also confirm the 05/05 $5,000 is on 238 — earlier analysis suggests it already is.

## Confirmed correct — do NOT move (the ruled-out list, now proven)

- **$135.64 and $132.81 journals (2026-05-18) on 4140** — these are exactly 4140's own May and June interest portions (05/17 payment: $1,044.68 P + **$135.64 I**; 06/17: $1,047.51 P + **$132.81 I**). The earlier per-loan cards suspected they belonged to E4/E5; the lender data says they're right where they belong.
- **$643.50 payments on E6-7410** — account ****2094's real monthly payment is $643.50. Those "worth checking" steps are cleared: correctly coded.
- **9744's $5,000 on 2026-05-27** — a real lender payment ($4,903.21 P + $96.79 I), covers the June invoice. Already ties in Xero.
- **4140's $5,000 principal payment on 2026-08-10** — real (balance 16,755.81 → 11,755.81); David already recoded it onto 242.

## The two smaller loans — month-offset interest splits (for Ramona)

The correct splits, from the lender:

| Loan | Month | Payment | Principal | Interest |
|---|---|---|---|---|
| E5-4751 | Mar (03/12) | $1,046.95 | $786.41 | $260.54 |
| E5-4751 | Apr (04/12) | $1,046.95 | $765.16 | **$281.79** |
| E5-4751 | May (05/12) | $1,046.95 | $780.53 | **$266.42** |
| E4-9744 | Apr (04/09) | $1,144.55 | $962.56 | **$181.99** |
| E4-9744 | May (05/09) | $1,144.55 | $975.78 | $168.77 |

The gaps the system flagged — E5 off by $15.37 and $281.79, E4 off by $181.97 — line up with these figures month-for-month (E5's April interest IS $281.79; E4's gap ≈ its April interest $181.99). The April/May payments in Xero appear split with the wrong month's numbers. Ramona re-splits them per this table; her entries, her call — nothing was changed for her.

## What was fed into WashRoute tonight

- **137 lender-verified principal balance anchors** inserted into the statements table (tagged `claude s229 ford_history_pdf`, fully removable with one delete on that tag): E4-9744 back to 02/2023, E5-4751 back to 05/2024, E6-7410 back to 01/2025, 8562's complete life 06/2022 → $0.00 payoff, plus 4140's 08/10 principal-payment point. 4140's history was already on file and matches the PDFs exactly.
- **Scheduled monthly payments corrected** to the lender's real figures: 4140 $1,180.32, E4 $1,144.55, E5 $1,046.95, E6 $643.50.

## Next clicks (5 minutes)

1. Drop the five PDFs into the Bookkeeping upload dropzone so the source documents are archived against each loan.
2. **Run Reconciliation Check.** Expect 8562 to join the Ford card (Xero's 238 isn't $0.00 yet — the payoff cash is sitting on 4140).
3. **Find the difference — all loans.** With 8562 now walkable, the $7,687.53 move should come back confirmed on both sides, with per-payment spans instead of monthly guesses.
4. Ramona: the one recode + the two re-splits above, then one re-run.

If 4140 still shows an old residual after all this, it's pre-Feb-2025 history (the engine walks 18 months at a time) — the deep-walk item on the shelf, now fully backed by lender data whenever we want it.
