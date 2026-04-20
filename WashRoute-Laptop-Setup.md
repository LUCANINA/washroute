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


## Notes

- The project is plain HTML/CSS/JS — no build step needed. Everything talks directly to Supabase.
- Vercel auto-deploys when you push to GitHub, so `git push` = live site updated.
- The local server is just for previewing — the apps connect to the same live Supabase database either way.
