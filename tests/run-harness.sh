#!/usr/bin/env bash
# Run the Bookkeeping browser harness on David's device VM.
#
# WHY THIS EXISTS (Tech Debt #37, closed session 265)
# ---------------------------------------------------
# `tests/bookkeeping-harness.mjs` loads the real admin-dashboard/index.html in
# headless Chromium. For months it could not run on the machine that SHIPS that
# file, so every dashboard change went out on source-text assertions alone —
# which prove the code is present and cannot prove it runs. A crash shipped that
# way in session 263 cont. 6.
#
# Two things blocked it, and neither is obvious:
#
#   1. `npx playwright install chromium` HANGS AT 0% on this VM. The network is
#      fine (curl pulls the same URL at ~6 MB/s); Playwright's own downloader
#      just never progresses. Do not sit and wait for it. The browser was
#      installed by fetching the zip with curl and unpacking it by hand.
#
#   2. The VM is missing exactly ONE system library, `libXdamage.so.1`, and
#      there is no root here so `apt-get install` / `playwright install-deps`
#      cannot be used. The .deb was extracted into ~/syslibs and is reached
#      through LD_LIBRARY_PATH below. `ldd <chrome> | grep "not found"` is how
#      you check whether a new build needs more.
#
# Both live under $HOME, OUTSIDE the mounted repo, so they survive here and
# never end up committed.
#
# Usage:  bash tests/run-harness.sh            # everything
#         bash tests/run-harness.sh --list     # group names
#         bash tests/run-harness.sh --only=g4  # one group
#
# Expected as of session 265: 1620 assertions, 1619 passed, 1 failed. The single
# red is `[history] s240 #10`, self-labelled REPORTED and red ON PURPOSE — it is
# where Tech Debt #19 is written down, and tuning it green deletes the only
# record of that finding. ANY OTHER RED IS A REAL FAILURE.
set -euo pipefail

CHROME="${WR_CHROMIUM:-$HOME/.cache/ms-playwright/chromium-1234/chrome-linux/chrome}"
LIBS="$HOME/syslibs/usr/lib/aarch64-linux-gnu"

if [ ! -x "$CHROME" ]; then
  echo "No Chromium at $CHROME" >&2
  echo "Install it (Playwright's own installer hangs on this VM — use curl):" >&2
  echo "  curl -sSL -C - -o ~/cr.zip https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1234/chromium-linux-arm64.zip" >&2
  echo "  mkdir -p ~/.cache/ms-playwright/chromium-1234 && unzip -q -o ~/cr.zip -d ~/.cache/ms-playwright/chromium-1234/" >&2
  exit 1
fi

if [ ! -d "$LIBS" ]; then
  echo "Missing $LIBS — chrome needs libXdamage.so.1 and this VM has no root." >&2
  echo "  mkdir -p ~/syslibs && cd ~/syslibs" >&2
  echo "  curl -sSLO http://ports.ubuntu.com/ubuntu-ports/pool/main/libx/libxdamage/libxdamage1_1.1.5-2build2_arm64.deb" >&2
  echo "  ar x libxdamage1_1.1.5-2build2_arm64.deb && tar xf data.tar.*" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
export LD_LIBRARY_PATH="$LIBS:${LD_LIBRARY_PATH:-}"
export WR_CHROMIUM="$CHROME"
exec node tests/bookkeeping-harness.mjs "$@"
