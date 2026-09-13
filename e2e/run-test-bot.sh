#!/usr/bin/env bash
# Starts the bot against an isolated home so e2e runs never touch the real
# .env / settings.json / logs of the working copy.
#
# POSIX counterpart of run-test-bot.ps1.
#
# Usage:
#   ./e2e/run-test-bot.sh
#   ./e2e/run-test-bot.sh --skip-build

set -euo pipefail

skip_build=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) skip_build=1 ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--skip-build]" >&2
      exit 2
      ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(dirname "$script_dir")"
test_home="$project_root/.tmp/e2e/home"
source_env="$script_dir/.env"
runtime_env="$test_home/.env"

if [ ! -d "$test_home" ]; then
  mkdir -p "$test_home"
  echo "Created test home: $test_home"
fi

if [ ! -f "$source_env" ]; then
  cp "$script_dir/.env.example" "$source_env"
  echo "Created $source_env from e2e/.env.example."
  echo "Fill in TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID, then run again."
  exit 1
fi

# e2e/.env is the single source of truth. The test home holds runtime state
# only (settings.json, logs), so the config is re-synced on every launch.
cp "$source_env" "$runtime_env"

# dotenv does not override variables that already exist in the environment, so
# anything inherited from the parent shell would silently win over the test
# config. Clear every key the test .env defines.
while IFS= read -r line; do
  case "$line" in
    [A-Za-z_]*=*) unset "${line%%=*}" 2>/dev/null || true ;;
  esac
done < "$runtime_env"

if [ "$skip_build" -eq 0 ]; then
  echo "Building..."
  (cd "$project_root" && npm run build)
fi

export OPENCODE_TELEGRAM_HOME="$test_home"

echo
echo "Test home : $test_home"
echo "Logs      : $test_home/logs"
echo "Settings  : $test_home/settings.json"
echo

exec node "$project_root/dist/index.js"
