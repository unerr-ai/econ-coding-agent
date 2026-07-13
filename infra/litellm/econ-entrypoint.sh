#!/usr/bin/env sh
# econ gateway entrypoint wrapper — OPTIONAL conductor-tier flip to a dedicated
# Fireworks deployment, chained in front of the base litellm image entrypoint.
#
# Default (secret unset): a no-op — config.yaml is served verbatim (conductor on
# Fireworks SERVERLESS), so nothing about the committed dumb-pipe config or the
# OL-8.B2 drift test changes. The flip is done at RUNTIME, in the container's copy
# of config.yaml only, never in the repo file.
#
# When CONDUCTOR_DEPLOYMENT_PATH is set (by the benchmark runner's
# DEDICATED_CONDUCTOR=1 flag, via `fly secrets set`), rewrite ONLY the conductor
# entry's upstream path (minimax-m3 serverless -> the dedicated `#deployments/...`
# form) before launching. The runner sets the secret when it brings the dedicated
# GPU up and unsets it at teardown, so the gateway auto-reverts to serverless.
#
# We CHAIN the base image entrypoint (/app/docker/entrypoint.sh) rather than exec
# litellm directly so its startup work (prisma / spend-logs DB setup) still runs.
set -eu

CONFIG="${ECON_CONFIG_PATH:-/app/config.yaml}"

if [ -n "${CONDUCTOR_DEPLOYMENT_PATH:-}" ]; then
  # Match ONLY the conductor's litellm_params.model line: `  model: fireworks_ai/accounts/fireworks/models/minimax-m3`
  # (anchored end-of-line so no other tier / the model_name slug is touched). `|`
  # delimiter because the dedicated path contains `#` (and `/`, but never `|`).
  if grep -qE '^[[:space:]]*model:[[:space:]]*fireworks_ai/accounts/fireworks/models/minimax-m3[[:space:]]*$' "$CONFIG"; then
    sed -i -E "s|^([[:space:]]*model:[[:space:]]*)fireworks_ai/accounts/fireworks/models/minimax-m3[[:space:]]*\$|\1${CONDUCTOR_DEPLOYMENT_PATH}|" "$CONFIG"
    echo "[econ-entrypoint] conductor flipped to DEDICATED: ${CONDUCTOR_DEPLOYMENT_PATH}"
  else
    echo "[econ-entrypoint] WARN: CONDUCTOR_DEPLOYMENT_PATH set but the serverless conductor line was not found in $CONFIG — serving config as-is" >&2
  fi
else
  echo "[econ-entrypoint] conductor on serverless (CONDUCTOR_DEPLOYMENT_PATH unset)"
fi

# Hand off to the base image's REAL server entrypoint. In the berriai/litellm image
# `docker/prod_entrypoint.sh` is the ENTRYPOINT (`exec litellm "$@"`, which runs the
# prisma migration internally on boot then serves); `docker/entrypoint.sh` is a
# migration-ONLY helper that exits without starting the server — do NOT chain to it.
if [ -x /app/docker/prod_entrypoint.sh ]; then
  exec /app/docker/prod_entrypoint.sh "$@"
else
  exec litellm "$@"
fi
