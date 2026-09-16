#!/usr/bin/env bash
# PhotoMap - one-click launcher (macOS)
# Double-click in Finder. Node.js preferred; python3 fallback.
cd "$(dirname "$0")" || exit 1
if command -v node >/dev/null 2>&1; then
  exec node tools/serve.js
fi
if command -v python3 >/dev/null 2>&1; then
  echo "[PhotoMap] Node.js not found, using python3 fallback."
  exec python3 tools/server.py
fi
echo "[PhotoMap] Needs Node.js (https://nodejs.org) or python3 to run."
read -r -p "Press Enter to close..." _
