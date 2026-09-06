#!/usr/bin/env bash
set -euo pipefail
export APIBEAM_RELAY_PORT="${APIBEAM_RELAY_PORT:-8788}"
exec node scripts/apibeam-relay.js
