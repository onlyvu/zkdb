#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/check-tools.sh"
# bb: the pinned CLI if installed, otherwise the same 5.0.0 binary that ships inside @aztec/bb.js (after npm ci).
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.foundry/bin:$PATH:$ROOT/node_modules/.bin"
cd "$ROOT/circuits"
nargo compile --workspace
mkdir -p "$ROOT/contracts/src/verifiers"

# build_verifier <circuit-name> <Prefix>: writes contracts/src/verifiers/<Prefix>Verifier.sol
build_verifier() {
  local name="$1" prefix="$2"
  mkdir -p "target/$name"
  bb write_vk -b "target/$name.json" -o "target/$name" --verifier_target evm
  bb write_solidity_verifier -k "target/$name/vk" -o "target/$name/Verifier.sol" --optimized
  perl -pe "s/\bHonkVerifier\b/${prefix}Verifier/g; s/\bZKTranscriptLib\b/${prefix}ZKTranscriptLib/g; s/\bRelationsLib\b/${prefix}RelationsLib/g" \
    "target/$name/Verifier.sol" > "$ROOT/contracts/src/verifiers/${prefix}Verifier.sol"
  echo "verifier: contracts/src/verifiers/${prefix}Verifier.sol"
}

build_verifier batch Batch
build_verifier claim Claim
