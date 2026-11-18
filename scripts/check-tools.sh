#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/versions.env"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# bb falls back to the binary inside @aztec/bb.js, which is the same pinned version.
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.foundry/bin:$PATH:$ROOT/node_modules/.bin"
fail=0
nv=$(nargo --version 2>/dev/null | head -1 || true)
[[ "$nv" == *"$NARGO_VERSION"* ]] || { echo "nargo: want $NARGO_VERSION, got '$nv'"; fail=1; }
bv=$(bb --version 2>/dev/null | head -1 || true)
[[ "$bv" == *"$BB_VERSION"* ]] || { echo "bb: want $BB_VERSION, got '$bv'"; fail=1; }
command -v forge >/dev/null || { echo "forge missing"; fail=1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "node >= 20 required"; fail=1; }
[[ $fail == 0 ]] && echo "tools OK"
exit $fail
