#!/usr/bin/env bash
# Bump build-version.txt to trigger auto-reload on all open admin/customer/driver/POS tabs.
# Run this AFTER any code change that needs to reach already-loaded SPA sessions
# (especially anything affecting the laundry team's intake station, drivers, or POS).
# The 4 SPAs poll /build-version.txt every 5 min and on tab focus, then location.reload(true)
# when the value changes. See admin-dashboard/index.html ~line 4566 for the polling code.
set -euo pipefail
NEW_VER=$(date -u +%Y%m%d%H%M%S)
echo "$NEW_VER" > build-version.txt
echo "build-version.txt bumped to $NEW_VER"
echo "Commit + push to ship: git add build-version.txt && git commit -m 'bump version' && git push"
