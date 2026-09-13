#!/usr/bin/env bash
# Petri stage demo, in three steps:
#   1. Verify   a second key re-runs a version and signs the result.
#   2. World ID the verifier proves they are a unique human.
#   3. Hedera   the new records go to the public Hedera topic.
#
#   ./demo/verify-demo.sh [nodeId]        # default: ec1d39e6
#
# Step 2 is SIMULATED in this script. It shows the intended World ID flow with
# example values, and it writes nothing. The real check is src/trust/world.ts,
# which is off unless PETRI_WORLD_ID=1.
#
# Step 3 needs a topic (`pnpm petri anchor create`) and the Hedera account in .env:
#   HEDERA_OPERATOR_ID=0.0.xxxx
#   HEDERA_OPERATOR_KEY=302e...
set -euo pipefail
cd "$(dirname "$0")/.."

NODE="${1:-ec1d39e6}"
KEY="${PETRI_DEMO_KEY:-$HOME/petri-demo-keys/k3}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi

B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; P=$'\033[35m'; R=$'\033[0m'
step () { printf '\n%s━━ %s %s\n\n' "$P$B" "$1" "$R"; }
pause () { sleep "${DEMO_PAUSE:-1}"; }

# ---------------------------------------------------------------- 1. Verify
step "1/3  Verify $NODE"
echo "${D}\$ PETRI_HOME=$KEY pnpm petri verify $NODE${R}"
# The CLI's own World ID line is hidden here, because step 2 shows that flow.
PETRI_HOME="$KEY" PETRI_ANCHOR_AUTO=0 pnpm -s petri verify "$NODE" | grep -v '^world id'
pause

# ---------------------------------------------------------------- 2. World ID
step "2/3  World ID"
cat <<EOF
  ┌─ ${B}World ID · prove you are a unique human${R}
  │
  │  Verifier   ${KEY##*/}, the key that signed the report
  │  Action     petri-verify-${NODE}
  │
  │  ▄▄▄▄▄▄▄  ▄ ▄▄  ▄▄▄▄▄▄▄
  │  █ ▄▄▄ █  ▀█▄▀  █ ▄▄▄ █   Scan with World App
  │  █ ███ █ ▀▄ █▀▄ █ ███ █
  │  █▄▄▄▄▄█ █▀▄▀█▄ █▄▄▄▄▄█   world.org/verify?app=petri
  │  ▄▄ ▄▄▄▄ ▀▄█▀▄▄▄ ▄▄▄ ▄▄
  │  █▄▄▄▄▄█ ▄▀ ▀▄█ ▀█▄█▀▄█
  └─
EOF
printf '  Waiting for the proof from World App'
for _ in 1 2 3 4 5; do sleep 0.6; printf '.'; done
printf '\n\n'
echo "  ${G}✓ Verified: unique human${R}"
echo "    level       orb"
echo "    nullifier   0x2b7f9c41e0a35d8e6f14b09c77d2a8e1f53c6b90"
echo "    AgentBook   0x3f1a…9c2e -> human id 0x8e4c…71ab"
echo "  ${D}(Example values. This step is simulated in the demo script.)${R}"
pause

# ---------------------------------------------------------------- 3. Hedera
step "3/3  Hedera"
if [ ! -f .petri/anchor.json ]; then
  echo "No Hedera topic yet. Run: pnpm petri anchor create --network testnet"
  exit 0
fi
if [ -z "${HEDERA_OPERATOR_ID:-}" ] || [ -z "${HEDERA_OPERATOR_KEY:-}" ]; then
  echo "Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY in .env, then run: pnpm petri anchor push"
  exit 0
fi
echo "${D}\$ pnpm petri anchor push${R}"
pnpm -s petri anchor push
