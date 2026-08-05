#!/usr/bin/env bash

set -u

missing_required=0

printf 'Agent Console system check\n\n'

for command_name in node npm; do
  if command -v "$command_name" >/dev/null 2>&1; then
    printf '  [OK] %-18s %s\n' "$command_name" "$(command -v "$command_name")"
  else
    printf '  [MISSING] %s\n' "$command_name"
    missing_required=1
  fi
done

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$node_major" -lt 20 ]; then
    printf '  [UPDATE] Node.js 20 or newer is required; current version is %s\n' "$(node --version)"
    missing_required=1
  else
    printf '  [OK] Node version       %s\n' "$(node --version)"
  fi
fi

printf '\nRecommended local tools\n'
for command_name in tmux wmctrl docker; do
  if command -v "$command_name" >/dev/null 2>&1; then
    printf '  [OK] %-18s %s\n' "$command_name" "$(command -v "$command_name")"
  else
    printf '  [OPTIONAL] %-12s not installed\n' "$command_name"
  fi
done

terminal_found=0
for command_name in ghostty gnome-terminal kitty konsole xfce4-terminal x-terminal-emulator; do
  if command -v "$command_name" >/dev/null 2>&1; then
    printf '  [OK] Terminal           %s\n' "$command_name"
    terminal_found=1
  fi
done

if [ "$terminal_found" -eq 0 ]; then
  printf '  [MISSING] No supported terminal found\n'
  missing_required=1
fi

printf '\n'
if [ "$missing_required" -ne 0 ]; then
  printf 'The required environment is not ready. Follow README.md before continuing.\n'
  exit 1
fi

printf 'The required environment is ready.\n'
if ! command -v tmux >/dev/null 2>&1 || ! command -v wmctrl >/dev/null 2>&1; then
  printf 'For the full experience, install tmux and wmctrl:\n'
  printf '  sudo apt install -y tmux wmctrl gnome-terminal\n'
fi
