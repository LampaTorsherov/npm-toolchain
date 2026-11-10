#!/usr/bin/env bash
set -Eeuo pipefail

REGISTRY="${REGISTRY:-https://registry.tsniimash.ru:3001/api/packages/js/npm/}"
ROOT="$(pwd -P)"
MANIFEST="$ROOT/manifest.tsv"

[[ -f "$MANIFEST" ]] || {
    echo "ERROR: missing $MANIFEST" >&2
    exit 1
}

command -v npm >/dev/null 2>&1 || {
    echo "ERROR: npm not found in PATH" >&2
    exit 1
}

total=$(awk 'NR > 1 && NF { n++ } END { print n+0 }' "$MANIFEST")
count=0
published=0
skipped=0

while IFS=$'\t' read -r name version file sha256 integrity || [[ -n "$name" ]]; do
    [[ -n "$name" && "$name" != "name" ]] || continue

    count=$((count + 1))
    archive="$ROOT/$file"

    [[ -f "$archive" ]] || {
        echo "ERROR: missing $archive" >&2
        exit 1
    }

    echo "[$count/$total] $name@$version"

    # Skip versions already present in Gitea.
    existing=$(npm view "$name@$version" version \
        --registry="$REGISTRY" \
        --json \
        --loglevel=silent 2>/dev/null) || existing=""

    if [[ "$existing" == "\"$version\"" ]]; then
        echo "SKIP: already published $name@$version"
        skipped=$((skipped + 1))
        continue
    fi

    # Publish the original tarball directly.
    npm publish "$archive" \
        --registry="$REGISTRY" \
        --tag=imported \
        --ignore-scripts

    published=$((published + 1))
    echo "OK: $name@$version"

done < "$MANIFEST"

echo "DONE: processed=$count published=$published skipped=$skipped"
