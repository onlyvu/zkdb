#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/versions.env"
[ -x "$HOME/.nargo/bin/noirup" ] || curl -L https://raw.githubusercontent.com/noir-lang/noirup/refs/heads/main/install | bash
"$HOME/.nargo/bin/noirup" -v "$NARGO_VERSION"
[ -x "$HOME/.bb/bbup" ] || curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/refs/heads/next/barretenberg/bbup/install | bash
"$HOME/.bb/bbup" -v "$BB_VERSION"
[ -x "$HOME/.foundry/bin/foundryup" ] || curl -L https://foundry.paradigm.xyz | bash
"$HOME/.foundry/bin/foundryup"
