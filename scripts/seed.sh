#!/usr/bin/env bash
# Seed the owner account into D1.
#
# The checked-in scripts/seed.sql creates the local development user
# (hermes@hermes.local / hermes-dev). For a real deployment, replace its
# password_hash before running this against the remote database.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Seeding hermes-office (local D1) from scripts/seed.sql ..."
pnpm exec wrangler d1 execute hermes-office --local --file=scripts/seed.sql

# Production: same seed file, remote database. Uncomment after replacing the
# dev password hash in scripts/seed.sql.
# pnpm exec wrangler d1 execute hermes-office --remote --file=scripts/seed.sql

cat <<'EOF'

Seed applied. If you did not edit scripts/seed.sql, the local credentials are
hermes@hermes.local / hermes-dev.

To use your own password instead:
  1. Generate a hash:
       node scripts/hash-password.mjs 'your-password'
  2. Replace the password_hash value in scripts/seed.sql with that output.
  3. Re-run this script (or the commented --remote command above).

Note: users.id is fixed, so re-running the seed after the first insert fails
with a UNIQUE constraint error. Delete the row first if you need to reseed.
EOF
