#!/bin/bash
# Safe git commit helper for WashRoute (bindfs FUSE mount workaround)
#
# Usage: ./.git-commit.sh "commit message" file1 [file2 file3 ...]
#
# The standard `git add` fails on this bindfs mount with EPERM.
# This script works around it correctly by:
#   1. Seeding a temp index from the current HEAD tree (not empty!)
#   2. Hashing and adding only the changed files
#   3. Writing the full tree and creating the commit
#   4. Updating the branch ref and pushing
#
# NEVER use the old workaround (GIT_INDEX_FILE=/tmp/x git update-index --add FILE)
# without first seeding from HEAD — that creates a sparse tree with only the
# changed file, causing Vercel to deploy an empty repo (404 on all routes).

set -e

MSG="$1"
shift
FILES=("$@")

if [ -z "$MSG" ] || [ ${#FILES[@]} -eq 0 ]; then
  echo "Usage: $0 \"commit message\" file1 [file2 ...]"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
GIT_DIR="$REPO_ROOT/.git"
TEMP_INDEX="/tmp/git-index-$$"

export GIT_DIR
export GIT_INDEX_FILE="$TEMP_INDEX"
export GIT_WORK_TREE="$REPO_ROOT"

# Step 1: Seed temp index from current HEAD (full tree)
git read-tree HEAD
echo "✓ Seeded index from HEAD ($(git ls-files --cached | wc -l | tr -d ' ') files)"

# Step 2: Hash each changed file and update the index
for FILE in "${FILES[@]}"; do
  # Make path relative to repo root
  REL="${FILE#$REPO_ROOT/}"
  ABS="$REPO_ROOT/$REL"

  if [ ! -f "$ABS" ]; then
    echo "⚠ Skipping (not found): $REL"
    continue
  fi

  HASH=$(git hash-object -w "$ABS" 2>/dev/null || git hash-object -w --stdin < "$ABS")
  # Check if file is executable
  if [ -x "$ABS" ]; then
    MODE="100755"
  else
    MODE="100644"
  fi

  # Check if it's a new file or existing
  if git ls-files --cached "$REL" | grep -q .; then
    git update-index --cacheinfo "$MODE,$HASH,$REL"
    echo "✓ Updated: $REL"
  else
    git update-index --add --cacheinfo "$MODE,$HASH,$REL"
    echo "✓ Added:   $REL"
  fi
done

# Step 3: Write tree
TREE=$(git write-tree)
echo "✓ Tree: $TREE"

# Step 4: Create commit
COMMIT=$(git commit-tree "$TREE" -p HEAD -m "$MSG")
echo "✓ Commit: $COMMIT"

# Step 5: Update branch ref
echo "$COMMIT" > "$GIT_DIR/refs/heads/main"
echo "✓ main → $COMMIT"

# Step 6: Push
unset GIT_INDEX_FILE
git push origin main
echo "✓ Pushed to origin/main"

# Cleanup
rm -f "$TEMP_INDEX"
