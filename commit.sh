#!/bin/bash
# WashRoute safe commit + push
# Usage: ./commit.sh "your commit message"

if [ -z "$1" ]; then
  echo "Usage: ./commit.sh \"your commit message\""
  exit 1
fi

# Clear any stale git lock files
find .git -name "*.lock" -delete 2>/dev/null

# Bump build version — triggers auto-reload on all tablets/PWAs
date -u +"%Y%m%d%H%M%S" > build-version.txt

# Stage all tracked changes + untracked helper files
git add -u
git add commit.sh build-version.txt

git commit -m "$1"
git push
