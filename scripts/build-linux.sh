#!/usr/bin/env bash

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_directory="$(cd -- "$script_directory/.." && pwd)"

cd "$project_directory"
"$script_directory/check-system.sh"

printf '\nInstalling project dependencies...\n'
npm ci

printf '\nRunning tests and building Linux packages...\n'
npm test
npm run typecheck
npm run package:linux

printf '\nBuild complete. Open this folder:\n  %s/release\n' "$project_directory"
