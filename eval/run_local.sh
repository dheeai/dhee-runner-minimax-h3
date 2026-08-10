#!/bin/bash
# Run the full eval against a LOCAL model on the 5090 llama.cpp gateway.
# Usage: ./run_local.sh [model-slug]
set -u
cd "$(dirname "$0")"

export H3_BASE="${H3_BASE:-http://5090.tail3cca41.ts.net:9000/llama/v1}"
export H3_MODEL="${1:-huihui-thinkingcap-27b}"
export H3_CONCURRENCY="${H3_CONCURRENCY:-2}"

echo "model=$H3_MODEL base=$H3_BASE concurrency=$H3_CONCURRENCY"

for arm in asis ctx fix2; do
  echo ""
  echo "########## arm: $arm ##########"
  start=$(date +%s)
  if [ "$arm" = "fix2" ]; then
    H3_ARM=fix node run.mjs "$arm"
  else
    node run.mjs "$arm"
  fi
  echo "### arm $arm wall-clock: $(( $(date +%s) - start ))s"
done
echo ""
echo ALLDONE
