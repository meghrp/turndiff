#!/bin/sh
set -eu

turndiff_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$turndiff_dir"
git diff --exit-code --quiet
git diff --cached --exit-code --quiet
version=$(git show HEAD:package.json | bun -e 'process.stdout.write((await Bun.stdin.json()).version)')
name="turndiff-v$version"
mkdir -p dist/release
git archive --format=tar.gz --prefix="$name/" -o "dist/release/$name.tar.gz" HEAD
git archive --format=zip --prefix="$name/" -o "dist/release/$name.zip" HEAD
cd dist/release
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$name.tar.gz" "$name.zip" > SHA256SUMS
else
  shasum -a 256 "$name.tar.gz" "$name.zip" > SHA256SUMS
fi
printf 'Release archives and checksums are in dist/release/\n'
