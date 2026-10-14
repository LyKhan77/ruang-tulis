#!/bin/sh

CDPATH= cd -P "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js was not found. Install the current Node.js LTS release (22.12.0 or newer), then try again.' >&2
  exit 1
fi

exec node ./scripts/start-local.mjs "$@"
