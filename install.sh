#!/bin/sh
set -eu

if [ "$#" -ne 0 ]; then
  printf 'Usage: ./install.sh\n' >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  printf 'Install Bun 1.3.10 or newer from https://bun.sh, then run this script again.\n' >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  printf 'Install Git 2.40 or newer, then run this script again.\n' >&2
  exit 1
fi

turndiff_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$turndiff_dir"
bun install --frozen-lockfile
bun link

printf '\nturndiff is installed. Keep this directory in place.\n'
printf 'Run turndiff from a Git repository to open its review UI.\n'
printf 'Optional agent turn recording: run turndiff install.\n'
if ! command -v turndiff >/dev/null 2>&1; then
  printf 'Add Bun\047s bin directory (usually ~/.bun/bin) to your PATH first.\n'
fi
