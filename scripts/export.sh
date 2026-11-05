#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/project" "$tmp/export/tgz"
cp scripts/collect.mjs "$tmp/collect.mjs"
cp scripts/import.sh "$tmp/export/import.sh"
# Create a synthetic project from an allowlisted list of public names/versions.
bun "$root/scripts/make-project.mjs" "$root/packages.txt" "$tmp/project/package.json"
(cd "$tmp/project" && bun install --ignore-scripts --no-save)
bun "$tmp/collect.mjs" "$tmp/project/bun.lock" "$tmp/export"
chmod +x "$tmp/export/import.sh"
tar -C "$tmp/export" -czf "$root/bun-registry-export.tar.gz" .
