#!/usr/bin/env bash
set -Eeuo pipefail

REGISTRY="${REGISTRY:-https://registry.tsniimash.ru:3001/api/packages/js/npm/}"

ROOT="$(pwd -P)"
MANIFEST="$ROOT/manifest.tsv"
TMP="$ROOT/pkg-tmp"

if [[ ! -f "$MANIFEST" ]]; then
    echo "ERROR: manifest.tsv not found in $ROOT" >&2
    exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
    echo "ERROR: bun not found" >&2
    exit 1
fi

if [[ -e "$TMP" ]]; then
    echo "ERROR: $TMP already exists; refusing to delete it" >&2
    exit 1
fi

cleanup() {
    cd "$ROOT" || true
    rm -rf -- "$TMP"
}

trap cleanup EXIT

mkdir -p "$TMP"

total=$(( $(wc -l < "$MANIFEST") - 1 ))
count=0

while IFS=$'\t' read -r name version file sha256 integrity; do
    # Skip header and empty lines.
    if [[ "$name" == "name" || -z "$name" ]]; then
        continue
    fi

    count=$((count + 1))

    SOURCE="$ROOT/$file"

    if [[ ! -f "$SOURCE" ]]; then
        echo "ERROR: missing archive: $SOURCE" >&2
        exit 1
    fi

    echo
    echo "[$count/$total] Publishing $name@$version"

    # Clean temporary directory before each package.
    rm -rf -- "$TMP"
    mkdir -p "$TMP"

    # Copy the original tarball without modifying it.
    cp -- "$SOURCE" "$TMP/package.tgz"

    # Extract ONLY package/package.json.
    mkdir -p "$TMP/package"

    tar -xzf "$TMP/package.tgz" \
        -C "$TMP" \
        package/package.json

    if [[ ! -f "$TMP/package/package.json" ]]; then
        echo "ERROR: package.json missing in $name@$version" >&2
        exit 1
    fi

    mv -- "$TMP/package/package.json" "$TMP/package.json"
    rmdir -- "$TMP/package"

    # Bun 1.4.4 requires package.json in CWD,
    # even when publishing an existing tarball.
    cd "$TMP"

    bun publish ./package.tgz \
        --registry "$REGISTRY" \
        --tag imported \
        --tolerate-republish \
        --ignore-scripts

    # Return to original working directory.
    cd "$ROOT"

    # Remove both copied tarball and package.json.
    rm -rf -- "$TMP"
    mkdir -p "$TMP"

    echo "OK: $name@$version"

done < "$MANIFEST"

echo
echo "Published $count packages successfully."
