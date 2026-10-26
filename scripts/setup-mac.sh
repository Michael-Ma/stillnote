#!/bin/bash
# Install this checkout as a normal Mac app. Never changes the user's notebook or fetches Git refs.
set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "Stillnote requires macOS."

command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 ||
  fail "Install Node.js 24 or later from https://nodejs.org/en/download, reopen Terminal, then run this script again."
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
[[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 24 )) ||
  fail "Stillnote needs Node.js 24 or later. Update Node.js, reopen Terminal, then try again."

sdk_version="$(xcrun --sdk macosx --show-sdk-version 2>/dev/null || true)"
sdk_major="${sdk_version%%.*}"
[[ "$sdk_major" =~ ^[0-9]+$ ]] && (( sdk_major >= 26 )) ||
  fail "Install or update Apple's Command Line Tools (macOS SDK 26+), or Xcode 26+. Start with: xcode-select --install. If already installed, check Software Update, then rerun this script."

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

printf '\nInstalling dependencies…\n'
npm ci --no-audit --no-fund

printf '\nBuilding and signing Stillnote…\n'
npm run package

printf '\nChecking the packaged app with a temporary notebook…\n'
npm run test:package

printf '\nInstalling in Applications…\n'
npm run install:app

printf '\nReady. Open Stillnote from Applications. In Settings, connect your AI plan, then choose New note → Record.\n'
