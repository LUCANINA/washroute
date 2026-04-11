#!/bin/bash
# WashRoute safe commit + push
# Usage: ./commit.sh "your commit message"

if [ -z "$1" ]; then
  echo "Usage: ./commit.sh \"your commit message\""
  exit 1
fi

# Clear any stale git lock files
find .git -name "*.lock" -delete 2>/dev/null

# Stage all tracked changes + commit.sh itself
git add -u
git add commit.sh

git commit -m "$1"
git push
