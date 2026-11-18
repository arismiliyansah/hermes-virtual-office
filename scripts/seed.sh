#!/usr/bin/env bash
# Seed the owner account into D1.
#
# The checked-in scripts/seed.sql creates the local development user
# (hermes@hermes.local / hermes-dev). For a real deployment, replace its
# password_hash before running the remote mode.
#
# Usage:
#   ./scripts/seed.sh            # local D1 (development)
#   ./scripts/seed.sh --remote   # production D1
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="--local"
if [[ "$#" -gt 1 ]]; then
  echo "usage: ./scripts/seed.sh [--local|--remote]" >&2
  exit 2
fi

if [[ "$#" -eq 1 ]]; then
  case "$1" in
    --local|--remote) MODE="$1" ;;
    --help|-h)
      echo "usage: ./scripts/seed.sh [--local|--remote]"
      exit 0
      ;;
    *)
      echo "usage: ./scripts/seed.sh [--local|--remote]" >&2
      exit 2
      ;;
  esac
fi

if [[ "$MODE" == "--remote" ]]; then
  TARGET="remote D1 (production)"
else
  TARGET="local D1"
fi

echo "Seeding hermes-office on $TARGET from scripts/seed.sql ..."
pnpm exec wrangler d1 execute hermes-office "$MODE" --file=scripts/seed.sql

cat <<'EOF'

Seed applied. If you did not replace the password hash in scripts/seed.sql, the
credentials are hermes@hermes.local / hermes-dev — change them before exposing
production.

To use your own password instead:
  1. Generate a hash:
       node scripts/hash-password.mjs 'your-password'
  2. Replace the password_hash value in scripts/seed.sql with that output.
  3. Re-run ./scripts/seed.sh [--remote].

Note: users.id is fixed, so re-running the seed after the first insert fails
with a UNIQUE constraint error. Delete the row first if you need to reseed.
EOF
