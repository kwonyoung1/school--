#!/bin/sh
set -eu
# The free host has ephemeral storage. Never silently fall back to local SQLite.
if [ "${REQUIRE_REMOTE_DB:-true}" = "true" ]; then
  : "${TURSO_DATABASE_URL:?Enter your Turso database URL in the host Environment settings}"
  : "${TURSO_AUTH_TOKEN:?Enter your Turso token in the host Environment settings}"
  : "${ADMIN_PASSWORD:?Set an initial admin password in the host Environment settings}"
fi
npm run init
if [ "${SEED_DEMO_DATA:-false}" = "true" ]; then
  npm run seed
fi
exec node --experimental-strip-types server/index.ts
