#!/bin/bash
# WashRoute safe commit + push
# Usage: ./commit.sh "your commit message"

if [ -z "$1" ]; then
  echo "Usage: ./commit.sh \"your commit message\""
  exit 1
fi

# Clear any stale git lock files
find .git -name "*.lock" -delete 2>/dev/null

# Build version is bumped automatically by scripts/githooks/pre-commit whenever
# client code (admin/customer/driver/POS/assets) is staged — session 228. Kept
# out of here on purpose so plain `git commit` gets the same protection.

# Stage all tracked changes + untracked helper files
git add -u
git add commit.sh build-version.txt

git commit -m "$1"
git push
