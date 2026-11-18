#!/usr/bin/env bash
# Seed the owner account into D1.
#
# The checked-in scripts/seed.sql creates the local development user
# (hermes@hermes.local / hermes-dev). Remote seeding refuses that default
# password hash unless --allow-dev-password is passed explicitly.
#
# Usage:
#   ./scripts/seed.sh                              # local D1 (development)
#   ./scripts/seed.sh --remote                     # production D1
#   ./scripts/seed.sh --remote --allow-dev-password
set -euo pipefail

cd "$(dirname "$0")/.."

# Keep in sync with scripts/seed.sql and scripts/hash-password.mjs hermes-dev.
DEFAULT_PASSWORD_HASH='pbkdf2$100000$Z8KAEVrAJZH-F3_Ohb8m0A$Ny41DkuDd8tZUJwoKwYfqZIFDPzi9JiPhD7yj8664uU'

usage() {
  echo "usage: ./scripts/seed.sh [--local|--remote] [--allow-dev-password]" >&2
}

MODE="--local"
ALLOW_DEV_PASSWORD=0

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --local|--remote) MODE="$1" ;;
    --allow-dev-password) ALLOW_DEV_PASSWORD=1 ;;
    --help|-h)
      echo "usage: ./scripts/seed.sh [--local|--remote] [--allow-dev-password]"
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
  shift
done

if [[ "$MODE" == "--remote" && "$ALLOW_DEV_PASSWORD" -ne 1 ]]; then
  if grep -qF "$DEFAULT_PASSWORD_HASH" scripts/seed.sql; then
    cat >&2 <<'EOF'
Refusing to seed production with the default development password hash.

Replace password_hash in scripts/seed.sql with:
  node scripts/hash-password.mjs 'your-password'

Then re-run ./scripts/seed.sh --remote.
Pass --allow-dev-password only if you really intend to expose
hermes@hermes.local / hermes-dev to the internet.
EOF
    exit 1
  fi
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
