#!/usr/bin/env bash
# Local macOS release build: produces the .app and .dmg bundles plus the
# signed updater artifacts (hzkcode_*.app.tar.gz + .sig) that a GitHub
# Release must carry so installed clients can auto-update.
#
# The bundle is UNSIGNED (this project holds no Apple Developer certificate):
# users opening the downloaded DMG for the first time must right-click the
# app → Open. Only the updater artifacts carry a signature, made with the
# project's own minisign key.
#
# Prerequisite — the updater key, generated once with:
#   pnpm exec tauri signer generate -w ~/.tauri/hzkcode.key -p ""
# TAURI_SIGNING_PRIVATE_KEY expects the key file's base64 blob as-is; do NOT
# decode it. The matching public key lives in src-tauri/tauri.conf.json
# (plugins.updater.pubkey); losing the private key breaks every client update.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  KEY_FILE="$HOME/.tauri/hzkcode.key"
  [ -f "$KEY_FILE" ] || { echo "error: updater key not found: $KEY_FILE" >&2; exit 1; }
  TAURI_SIGNING_PRIVATE_KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
  export TAURI_SIGNING_PRIVATE_KEY
fi

# The updater key carries an EMPTY password (`-p ""` at generation). Export it
# so the bundler never tries to prompt — without a TTY the prompt fails
# ("Device not configured") and the updater artifacts stay unsigned.
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

pnpm exec tauri build --bundles app,dmg
