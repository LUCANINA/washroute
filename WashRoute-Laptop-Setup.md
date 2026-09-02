# WashRoute — Laptop Setup Guide

Follow these steps in order. Open **Terminal** on your MacBook and paste each command one at a time.


## 1. Install Homebrew (Mac package manager)

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It will ask for your Mac password. Takes a few minutes. When it finishes, it may show "Next steps" telling you to run a command to add Homebrew to your PATH — run that too.


## 2. Install Git and Node.js

```
brew install git node
```


## 3. Set up your Git identity

```
git config --global user.name "David Macquart"
git config --global user.email "dmacquart@gmail.com"
```


## 4. Clone the WashRoute repo

```
mkdir -p ~/Projects
cd ~/Projects
git clone https://github.com/LUCANINA/washroute.git WashRoute
```

If it asks you to sign in to GitHub, follow the prompts. You may need to install the GitHub CLI (`brew install gh`) and run `gh auth login` first.


## 5. Run the apps locally

```
cd ~/Projects/WashRoute
npx serve . -p 3000
```

Say "y" if it asks to install the `serve` package.

Then open your browser to:

- Admin Dashboard: http://localhost:3000/admin-dashboard/
- Driver App: http://localhost:3000/driver-app/
- Customer App: http://localhost:3000/customer-app/

Press Ctrl+C in Terminal to stop the server when done.


## 6. Day-to-day commands

Pull latest changes (run before each work session):
```
cd ~/Projects/WashRoute
git pull
```

Start the local server:
```
cd ~/Projects/WashRoute
npx serve . -p 3000
```

Push your changes after a commit:
```
git push
```


## 7. Claude Code setup (do this once)

The repo carries most of the setup, but three things are installed **per machine**
and won't be there after a fresh clone. Without them Claude still works — it just
loses the project briefing and prints "command not found" for `rtk` commands.

### 7a. Install the three skills

`washroute`, `washroute-audit` and `washroute-changelog` live in this repo as
`.skill` files (they're zip archives). Claude Code reads skills from
`~/.claude/skills/`, so unzip them there:

```
cd ~/Projects/WashRoute
for s in washroute washroute-audit washroute-changelog; do
  rm -rf ~/.claude/skills/$s
  unzip -q -o $s.skill -d ~/.claude/skills/
done
ls ~/.claude/skills/
```

You should see the three names listed. Restart Claude Code afterwards.

**Why these aren't automatic:** they used to sync from your Claude account, but
that gave you two copies of each — the old one and the new one — both loading into
every session. They're now local-only, which means each machine installs them once.

The other skills (`washroute-bookkeeping`, `-qa`, `-preflight`,
`-migration-review`, `-test`) still sync from your account and need nothing here.

### 7b. Install rtk (optional but worth it)

`rtk` compresses command output before Claude reads it — measured on this repo:
`ls -laR` 75% smaller, `git status` 52%. Skip it and everything still works; the
project file tells Claude to fall back to plain commands.

```
brew install rtk
rtk --version
```

Then create `~/Library/Application Support/rtk/config.toml` with exactly this:

```
[hooks]
exclude_commands = ["grep", "rg"]
transparent_prefixes = []

[telemetry]
enabled = false
```

**That exclusion is not optional if you install rtk.** `rtk grep` truncates —
86 matches in `admin-dashboard/index.html` came back as 25 lines. Fine for "does
this exist", wrong for any audit. A missed caller before a schema change is
exactly the failure `docs/washroute/authorization.md` exists to prevent.

Then turn on the hook that applies rtk automatically:

```
rtk init -g --auto-patch
```

Restart Claude Code. Check it took with:

```
echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | rtk hook claude
echo '{"tool_name":"Bash","tool_input":{"command":"grep -rn foo x"}}' | rtk hook claude
```

The first should rewrite to `rtk git status`. The second should print **nothing** —
that means grep is correctly left alone.

### 7c. Copy the response rules

These live in `~/.claude/CLAUDE.md`, which is per-machine. Copy the `## Responses`
section from the Mac mini's `~/.claude/CLAUDE.md`, or skip it — it only affects how
wordy Claude is, nothing functional.

### What you do NOT need to install

All of this is in the repo and works straight after `git clone`:
`CLAUDE.md`, `docs/washroute/*.md`, `.claude/agents/` (the locator, verifier and
worker agents), `database/audits/daily_audit.sql`,
`scripts/audit-rpc-call-sites.sh`, and `docs/TOKEN-HABITS.md`.


## Notes

- The project is plain HTML/CSS/JS — no build step needed. Everything talks directly to Supabase.
- Vercel auto-deploys when you push to GitHub, so `git push` = live site updated.
- The local server is just for previewing — the apps connect to the same live Supabase database either way.
