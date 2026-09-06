# Shipping without David — a release pipeline

**Written session 279 (2026-09-06), after a session that produced four commits and shipped
none of them.** David: *"we need a better solution than me pushing every time."*

Status: **DESIGNED, NOT BUILT.** Nothing in here has been set up. Read §6 for what to do.

---

## 1. The problem, as measured rather than assumed

At the end of session 279, four commits sat unpushed and two edge functions sat undeployed,
and this sandbox could do neither. Each route was tried, not guessed:

| Route | What happened |
|---|---|
| `git push` from the device VM | **No credentials of any kind.** No `credential.helper`, no `~/.ssh`, no `~/.git-credentials`, no `~/.netrc`, no token in the environment, no `gh`. The network is fine — GitHub answers 200 and `git ls-remote` succeeds anonymously because the repo is public. **Authentication is what is missing.** |
| MCP `deploy_edge_function` | **Over the size ceiling, definitively.** `reconciliation-run/index.ts` is 158,825 bytes *on its own*, before ~120KB of `_shared` dependencies and two local modules. The ceiling is ~100–130KB of file content per call. `loan-bundle`'s bundle is ~404KB. The only way through would be truncating a file, which is the one thing never to do. |
| Computer use on the Mac | Terminal has the Mac's own credentials, but the granted-app list is empty and granting prompts **on the machine**, which is useless when David is away from it. A person approving is not automation. |

**This is not a one-off.** Every session ends the same way, and the cost is not the typing:

* **The deploy state in START HERE has been wrong on eight separate days**, every time written
  by the session that had just changed it. §0z, §0x, §0w, §0t and §0r are all corrections of a
  previous session's deploy claim.
* **Session 261 lost three round trips** to `git push` not deploying an edge function.
* **Session 264 shipped a function that never booted** — a duplicate `const` was a SyntaxError,
  so every call 503'd on the CORS preflight for eighteen hours, while everything reported
  success.

Every one of those is a *manual, unverified, human-in-the-loop* deploy. The fix is not to give
Claude a bigger hammer; it is to stop deploying by hand.

---

## 2. What actually needs to change

Two separate problems, and conflating them is why this has stayed unsolved:

1. **Claude cannot push.** Needs one credential, scoped as tightly as possible.
2. **A push does not deploy an edge function.** This is a repo fact, not a Claude limitation —
   Vercel auto-deploys the four SPAs on push and Supabase functions have never been wired to
   anything. Giving Claude a Supabase token would paper over it and leave the same manual step
   for David, the CPA, and every future session.

**Solve (2) with CI and (1) shrinks to almost nothing.** If pushing to `main` deploys the
functions, then Claude only ever needs push, and the Supabase credential lives in GitHub where
neither Claude nor the device VM can read it.

---

## 3. Recommended: a repo-scoped deploy key + GitHub Actions

### 3a. Push — a **deploy key**, not a personal access token

A deploy key is an SSH key registered against **this one repository** with write access. A
personal access token, even fine-grained, is an account credential: it is a bigger blast radius
for exactly the same capability.

| | Deploy key | Fine-grained PAT |
|---|---|---|
| Reaches other repos | Never | Only if scoped correctly, and scope drifts |
| Reaches the GitHub account | No | Potentially |
| Revoking it | Delete one key on one repo | Rotate a token used in several places |
| If it leaks | Someone can push to washroute | Depends entirely on the scopes |

**Where it lives matters as much as what it is.** It must NOT be inside
`~/Projects/WashRoute` — anything in the repo can be committed by accident, and this repo has
a pre-commit hook that stages tracked changes. Put it in a **separate folder connected to the
session**:

```
~/WashRoute-Secrets/           <- connect this folder in the Claude desktop app
  id_ed25519_washroute         <- the private key, chmod 600
```

Claude reads it, points git at it for one command, and never copies it anywhere:

```
GIT_SSH_COMMAND="ssh -i ~/mnt/WashRoute-Secrets/id_ed25519_washroute -o IdentitiesOnly=yes" \
  git push origin main
```

The remote also has to be SSH rather than HTTPS for this to work — a one-line change David
makes once (§6).

**Be clear-eyed about what this grants.** Any session with that folder connected can push to
`main`, unattended, without asking. That is the point, and it is also the risk: a bad commit
reaches production in about thirty seconds via Vercel. §5 is how that risk is bounded.

### 3b. Deploy — **GitHub Actions**, triggered by the push

Add `.github/workflows/deploy-functions.yml`. On a push to `main` that touches
`supabase/functions/**`, it runs the same CLI command David runs by hand today:

```yaml
name: Deploy edge functions
on:
  push:
    branches: [main]
    paths: ['supabase/functions/**']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 2 }
      - name: Deploy the functions this push actually changed
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
        run: |
          # Only what changed. Deploying all ~90 functions on every push is slow,
          # noisy, and would silently reset verify_jwt across the board.
          CHANGED=$(git diff --name-only HEAD^ HEAD \
            | grep '^supabase/functions/' \
            | cut -d/ -f3 | grep -v '^_shared$' | sort -u)
          # A _shared change can affect any function that imports it; grep for
          # the importers rather than guessing.
          SHARED=$(git diff --name-only HEAD^ HEAD | grep '^supabase/functions/_shared/' || true)
          if [ -n "$SHARED" ]; then
            for f in $SHARED; do
              base=$(basename "$f")
              CHANGED="$CHANGED $(grep -rl "_shared/$base" supabase/functions --include=index.ts \
                | cut -d/ -f3 | sort -u)"
            done
          fi
          for fn in $(echo $CHANGED | tr ' ' '\n' | sort -u); do
            [ -f "supabase/functions/$fn/index.ts" ] || continue
            echo "::group::$fn"
            npx -y supabase@latest functions deploy "$fn" \
              --project-ref umjpbuxrdydwejqtensq --no-verify-jwt
            echo "::endgroup::"
          done
```

**Three things in that script are load-bearing and must not be simplified away:**

1. **`--no-verify-jwt`.** Every function this repo deploys is currently `verify_jwt: false`.
   Omitting the flag flips it to requiring a JWT and breaks every caller — session 260 nearly
   killed the Stripe payout webhook this way. ⚠️ **If a function is ever added that SHOULD
   verify JWT, this loop is wrong for it and needs a per-function exception**, not a blanket
   removal of the flag.
2. **The `_shared` fan-out.** `_shared/gap-closure.ts` changing means `reconciliation-run` has
   to redeploy; nothing about the path tells you that. Grepping the importers is the same
   discipline as `docs/washroute/authorization.md`'s "find ALL callers".
3. **Changed-only.** Deploying everything on every push would take many minutes and touch
   functions nobody reviewed.

`SUPABASE_ACCESS_TOKEN` is a GitHub repository secret. **Claude never sees it and neither does
the device VM** — which is the real security win, and the reason this beats handing Claude a
Supabase token.

---

## 4. Rejected alternatives, and why

* **A Supabase access token on disk beside the deploy key.** Would let Claude deploy directly,
  and it is tempting because it is less setup. Rejected: it leaves problem (2) unsolved for
  everyone else, keeps the deploy manual and therefore unverified, and puts an
  account-scoped Supabase credential on a laptop. CI is barely more work and fixes it for good.
* **A GitHub App / OAuth flow.** Correct in a larger org, disproportionate here — more moving
  parts to understand and maintain than a deploy key on one repo.
* **Claude driving Terminal on the Mac via computer use.** Works, and needs a person at the
  machine to approve. That is the problem restated, not solved.
* **Committing a token into the repo.** Never. It would reach a public GitHub repo.
* **Making Claude's push go through a PR instead of `main`.** Genuinely worth considering later
  (see §5), but as the *first* step it just moves the manual click from `git push` to "merge",
  which is the same interruption wearing a hat.

---

## 5. The safety question, honestly

Automating the push means **an unattended session can put code in front of customers in about
thirty seconds.** That deserves a straight answer rather than reassurance.

What already bounds it, and none of it is new:

* **Nothing may be pushed that has not passed the suite.** The Node tests and the browser
  harness run in the sandbox today; they must be run *before* the push, not after.
* **`washroute-preflight` and `washroute-migration-review` are unchanged and still mandatory.**
  Automating the push does not automate the judgement.
* **The pre-commit hook still bumps `build-version.txt`**, so open tabs still reload.
* **Deploy state is still checked by BEHAVIOUR, never inferred.** A green Actions run proves the
  deploy was *accepted*, not that the function *runs* — session 264's function was accepted and
  never booted. **The rule survives CI completely intact:** probe the function, and for a
  data-writing change check that the ROWS carry the new fields.

What would harden it further, in rough order of value:

1. **Run the suite in Actions too**, and make the deploy job depend on it. Then a red suite
   blocks the deploy even if a session pushed carelessly.
2. **Protect `main`** so a force-push is impossible.
3. **A push notification to David on every deploy**, so an unattended ship is never a surprise.
4. Eventually, **PRs for anything touching money-posting paths** (`loan-xero-post`,
   `payroll-xero-post`, `charge-order`), with straight-to-`main` for everything else.

**A standing rule to add to the skill once this exists:** *Claude may push its own work. Claude
may not push someone else's uncommitted work, and commits by path when the working copy is
shared* — session 279 had two sessions editing one working copy at the same time, and a blanket
`git add` would have swept half-finished work into production.

---

## 6. Setup — for David, once

**Part A — the deploy key (about 5 minutes).** In Terminal on the Mac:

1. `mkdir -p ~/WashRoute-Secrets && chmod 700 ~/WashRoute-Secrets`
2. `ssh-keygen -t ed25519 -f ~/WashRoute-Secrets/id_ed25519_washroute -N "" -C "washroute-claude-deploy"`
   (press Enter at any prompt)
3. `chmod 600 ~/WashRoute-Secrets/id_ed25519_washroute`
4. `cat ~/WashRoute-Secrets/id_ed25519_washroute.pub` — copy the whole line
5. In a browser: **github.com/LUCANINA/washroute → Settings → Deploy keys → Add deploy key**.
   Title `claude-deploy`, paste the key, **tick "Allow write access"**, Add.
6. Point the repo at SSH: `cd ~/Projects/WashRoute && git remote set-url origin git@github.com:LUCANINA/washroute.git`
7. In the Claude desktop app, **connect the folder `~/WashRoute-Secrets`** to the session.

**Part B — the Actions secret (about 3 minutes).**

8. Get a Supabase access token: **supabase.com/dashboard → account → Access Tokens → Generate**.
   Name it `github-actions-deploy`. Copy it — it is shown once.
9. **github.com/LUCANINA/washroute → Settings → Secrets and variables → Actions → New
   repository secret.** Name `SUPABASE_ACCESS_TOKEN`, paste, Add.

**Part C — leave to Claude.** Next session writes `.github/workflows/deploy-functions.yml`,
pushes it using the new key, and then **proves the whole chain on something harmless** — a
comment-only change to one small function — checking that Actions ran, that the function still
answers, and that `verify_jwt` is still `false`. Only after that green run does the pipeline
get trusted with real work.

---

## 7. What this changes in the skills, afterwards

Both of these are currently stated as absolutes and both become wrong the day this ships. They
must be edited in the same session that proves the pipeline, not later:

* `washroute-bookkeeping`: *"Never run `git push` from this sandbox — it has no network access
  and will always fail with a 403."* Two things wrong with that sentence even today: the device
  VM **does** have network, and the failure is authentication, not a 403.
* `washroute` / `CLAUDE.md`: *"A `git push` does NOT deploy an edge function."* Becomes: a push
  to `main` deploys the functions it changed, via Actions — **and the deploy is still checked by
  behaviour, never inferred from a green tick.**

Until then, both rules stand exactly as written.
