# Lender access on the loan card — a decision, not a feature

**Status:** ✅ **DECIDED — Option A.** ⏸️ **NOT A PRIORITY. Do not build it yet.**
David, session 290, 2026-09-09: *"ok for option A, but this feature is not a
priority yet."*

The decision is settled so it does not have to be re-litigated when the work
comes up; the SCHEDULING is deliberate. **Do not open this because the card looks
unfinished without it** — an empty access section is not a defect, and §3's own
argument says the eight ordinary fields carry the value while the secret carries
the risk. When it is picked up, §4 is the migration sketch and
`washroute-migration-review` runs first. **Option B is closed** — reopening it
needs a new conversation, not a quiet upgrade of `portal_secret_ref` into a place
a password will fit.

**Raised:** session 290, 2026-09-09 — *"this is where we could keep password
information and integrations with the banks."*

---

## 1. What is actually being asked for

The loan card now answers *what are the terms* and *what evidence do we hold*.
The missing third question is **how do I get to this lender** — which a
bookkeeper asks at 4pm on close day, when a statement is missing and the month
cannot close without it.

Concretely, the things a person needs in that moment:

| | Why it matters on close day |
|---|---|
| Portal URL | Where the statement lives |
| Username | Which account to sign in as — often not a personal one |
| Second factor | Whose phone the code goes to; this is what actually blocks people |
| Who may sign in | So the right person is asked instead of the credential being shared |
| Statements arrive by email? | If yes, the answer is "search the inbox", not "log in" |
| Auto-file on? | Whether the app already has it |
| Bank feed connected? | Whether payments match themselves or are coded by hand |
| Last successful sign-in | A credential that lapsed surfaces BEFORE close day, not during |
| The password | …see below |

Eight of those nine are ordinary business facts. One is a secret, and it is the
only one that changes the shape of the project.

---

## 2. The two options

### Option A — record the ROUTE IN; the password stays in the password manager

Add plain columns to `loan_accounts` (or a small `loan_access` table if we want
history). The password field holds a **pointer** — "1Password → Family Laundry →
Ford Pro" — rendered as a link, not a value. WashRoute never holds the secret.

**Cost:** one migration, a form, a card section. A day, including tests.

**What it gives up:** a person still needs 1Password open. That is one extra
click, and it is the click that keeps the secret out of this system.

**What it protects:** everything below.

### Option B — WashRoute stores the credentials themselves

This is not "add an encrypted column". Done properly it is:

* encryption with a key held **outside** the database (Supabase Vault or an edge
  function secret), so a database dump is not a credential dump;
* decrypt **only** inside an edge function, never in `admin-dashboard/index.html`
  — anything the browser can decrypt, any admin session can exfiltrate;
* an **access log** — who revealed which credential, when. Without it there is no
  answer to "who saw it", which is the first question after any incident;
* a **role that is not plain admin**. Today every admin sees everything on this
  page, including staff who have no business holding lender logins;
* a rotation story — when someone leaves, which credentials must change, and how
  the app helps rather than hides them;
* and a decision about **what happens on export**. The CSV exports on this module
  are deliberate and useful; a credential store means every export path needs
  auditing.

**Cost:** realistically a week, and it is security-critical code in a codebase
whose author does not write code. It also permanently raises the stakes of every
future bug on this page.

---

## 3. Why Option A is the recommendation

Three reasons, in order of weight.

**1. The blast radius is wrong.** A password in a `loan_accounts` column is
readable by every admin session, by anything holding the service-role key, by any
database export or backup, and by any future bug that returns a row it should
not. WashRoute is a laundry-route app that grew a bookkeeping module; it is not
built to be a credential store, and making it one is a promise about every future
change to it.

**2. It never expires.** 1Password knows when a password was rotated and can tell
someone it is stale. A column does not — it will confidently show a bookkeeper a
password that stopped working in March, and the failure will look like the
lender's fault.

**3. It does not solve the actual close-day problem.** The thing that blocks
people is almost never "I don't know the password" — it is "the code went to a
phone I don't have" or "I didn't know this one arrives by email". **Option A
answers those and Option B does not answer them any better.** The eight ordinary
fields carry nearly all the value; the secret carries nearly all the risk.

**The honest counter-argument**, so it is on the record: Ramona is external, and
telling a CPA "it's in David's 1Password" is a dead end for her. That is real —
and the answer is a 1Password **shared vault** she has access to, which is what
that product exists for, rather than a second credential store in WashRoute.

---

## 4. If Option A is chosen — what the migration looks like

Sketch only; `washroute-migration-review` runs before anything is applied.

* `loan_accounts.portal_url` — text
* `loan_accounts.portal_username` — text
* `loan_accounts.portal_secret_ref` — text, a POINTER (vault path or URL), never a secret
* `loan_accounts.portal_mfa` — text, in plain words ("text to the office line, ends 4417")
* `loan_accounts.portal_holders` — text, who may sign in
* `loan_accounts.statement_delivery` — enum-ish text: `email` / `portal` / `mail` / `none`
* `loan_accounts.bank_feed_connected` — boolean, nullable (null = nobody has said)
* `loan_accounts.portal_last_login` — date, set by a person, not inferred

**Two rules to carry into the build:**

* **`portal_secret_ref` must never accept something that looks like a password.**
  A field that CAN hold one eventually will. Reject on save anything that is not a
  URL or a vault path, and say why.
* **Null is not false.** `bank_feed_connected` unset means nobody has checked, and
  it must render as "not recorded" — the same first-class absence the terms card
  already uses. Rendering unknown as "not connected" is a claim we have not earned.

---

## 5. What is NOT in scope here

"Integrations with the banks" could also mean pulling statements automatically
rather than recording how a human gets them. That is a genuinely different
project (per-lender scraping or an aggregator like Plaid, plus everything above
about credential custody, plus the Xero quota lesson from this same session about
what happens when a product spends an external budget it cannot see). Worth
wanting; not worth conflating with this.
