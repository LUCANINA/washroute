#!/usr/bin/env bash
# WashRoute — push to GitHub from a Claude session, safely.
#
# WHY THIS EXISTS (session 280)
# -----------------------------
# Shipping used to depend on David being at his desk: the device VM carries no
# git credentials of any kind, so every commit sat unpushed until he ran
# `git push` himself. Session 279 produced four commits and shipped none of them.
# docs/washroute/DESIGN-RELEASE-PIPELINE.md is the full design; this is the push
# half of it.
#
# WHERE THE KEY LIVES, AND WHY THERE
# ----------------------------------
#   .git/wr-deploy-key
#
# Inside the repo FOLDER, but inside `.git/` — which git will not add to a commit
# under any circumstances, because it refuses to track its own directory. That is
# a stronger guarantee than .gitignore, which one `git add -f` or a rewritten
# ignore file defeats. It also survives, which the VM's own $HOME does not: that
# is a per-session sandbox and anything written there is gone next session.
#
# It is a DEPLOY KEY, not a personal access token: scoped to this one repository,
# and revocable from the repo's own settings without touching anything else David
# owns. The private half never leaves his machine.
#
# ⚠️ WHAT A PUSH DOES, and nobody should run this without knowing it:
#   · Vercel auto-deploys the four SPAs from `main`. Live in about 30 seconds.
#   · The pre-commit hook has already bumped build-version.txt, so every open
#     tab — the rack station included — RELOADS onto the new code.
#   · It does NOT deploy edge functions. It never has. See CLAUDE.md.
#
# Usage:  bash scripts/push.sh            # push main
#         bash scripts/push.sh --dry-run  # say what would go, push nothing
set -euo pipefail

cd "$(dirname "$0")/.."
KEY=".git/wr-deploy-key"
SSH_URL="git@github.com:LUCANINA/washroute.git"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

fail() { echo "✗ $*" >&2; exit 1; }

# ── 1. The key has to exist and be registered ───────────────────────────────
if [ ! -f "$KEY" ]; then
  cat >&2 <<'MSG'
✗ No deploy key at .git/wr-deploy-key

  Generate one:
    ssh-keygen -t ed25519 -f .git/wr-deploy-key -N "" -C "washroute-claude-deploy"

  Then add the PUBLIC half (.git/wr-deploy-key.pub) at
    github.com/LUCANINA/washroute -> Settings -> Deploy keys -> Add deploy key
  with "Allow write access" TICKED.
MSG
  exit 1
fi
chmod 600 "$KEY"
export GIT_SSH_COMMAND="ssh -i $PWD/$KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

# ── 2. Refuse to push anything nobody looked at ─────────────────────────────
# Every guard here is a state where pushing would ship something unintended, and
# a push reaches customers in thirty seconds. Read-only git commands use
# --no-optional-locks: every lock-taking command leaves an undeletable .git/*.lock
# on this FUSE mount and the next one then dies claiming git is already running.
BRANCH="$(git --no-optional-locks rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || fail "on branch '$BRANCH', not main. Pushing a side branch from a script is never what was meant."

if [ -n "$(git --no-optional-locks status --porcelain)" ]; then
  git --no-optional-locks status --short >&2
  fail "the working tree is dirty. Commit or stash first — a push that leaves edits behind ships a half-change."
fi

AHEAD="$(git --no-optional-locks log origin/main..main --oneline 2>/dev/null || true)"
[ -n "$AHEAD" ] || { echo "✓ Nothing to push — origin/main already has everything."; exit 0; }

# ── 3. Say what is about to ship, in the terms that matter ──────────────────
echo "Commits to push:"
echo "$AHEAD" | sed 's/^/  /'
CLIENT="$(git --no-optional-locks diff --name-only origin/main..main -- \
  admin-dashboard customer-app driver-app pos assets 2>/dev/null || true)"
if [ -n "$CLIENT" ]; then
  echo ""
  echo "⚠️  Client code changed — Vercel deploys these to production and every open"
  echo "    tab reloads within ~30s:"
  echo "$CLIENT" | sed 's/^/      /'
fi
FUNCS="$(git --no-optional-locks diff --name-only origin/main..main -- supabase/functions 2>/dev/null | cut -d/ -f3 | sort -u || true)"
if [ -n "$FUNCS" ]; then
  echo ""
  echo "⚠️  Edge functions changed. A PUSH DOES NOT DEPLOY THEM — it never has."
  echo "    Deploy each one yourself, and verify by BEHAVIOUR, not by git:"
  for f in $FUNCS; do
    echo "      npx -y supabase@latest functions deploy $f --project-ref umjpbuxrdydwejqtensq --no-verify-jwt"
  done
  echo "    (--no-verify-jwt is not optional on a function currently set verify_jwt:false)"
fi

if [ "$DRY" = "1" ]; then echo ""; echo "--dry-run: nothing pushed."; exit 0; fi

# ── 4. Push ─────────────────────────────────────────────────────────────────
# An explicit SSH URL rather than rewriting origin: origin stays https so
# anonymous fetch keeps working and nothing else in the repo changes behaviour.
echo ""
git push "$SSH_URL" main:main
echo ""
echo "✓ Pushed. Vercel builds from main; give it ~30s, then confirm by BEHAVIOUR:"
echo "    curl -s https://admin.familylaundry.com/build-version.txt"
echo "    (it should equal $(cat build-version.txt 2>/dev/null || echo '<build-version.txt>'))"
