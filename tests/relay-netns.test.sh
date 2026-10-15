#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
export CONFIG_FILE="$test_dir/absent.env" STATE_DB="$test_dir/absent.db"
source <(sed '$d' "$repo/bin/wg-captive-agent")
WG_EASY_CONTAINER=wg-easy
export RELAY_TEST_LOG="$test_dir/commands"
export RELAY_TEST_IPSET_MISSING=0
docker() {
  printf 'docker %s\n' "$*" >> "$RELAY_TEST_LOG"
  if [[ "$1" == inspect ]]; then echo 1234; return; fi
  [[ "$1" == exec ]] || return 1
}
nsenter() {
  printf 'nsenter %s\n' "$*" >> "$RELAY_TEST_LOG"
  [[ "$1" == -t && "$2" == 1234 && "$3" == -n ]]
  shift 3
  "$@"
}
ipset() {
  printf 'host ipset %s\n' "$*" >> "$RELAY_TEST_LOG"
  [[ "$RELAY_TEST_IPSET_MISSING" == 0 ]] || return 127
}
export -f docker nsenter ipset
relay_exec 'ipset create test-set hash:ip -exist'
grep -qF 'nsenter -t 1234 -n sh -ec' "$RELAY_TEST_LOG"
grep -qF 'host ipset create test-set hash:ip -exist' "$RELAY_TEST_LOG"
if grep -qF 'docker exec' "$RELAY_TEST_LOG"; then echo 'network command used container tools' >&2; exit 1; fi
export RELAY_TEST_IPSET_MISSING=1
if relay_exec 'ipset create missing hash:ip; echo incorrectly-enabled' > "$test_dir/failure.log"; then echo 'missing host ipset was ignored' >&2; exit 1; fi
if grep -qF 'incorrectly-enabled' "$test_dir/failure.log"; then exit 1; fi
relay_wg_exec 'wg-quick up wg-exit'
grep -qF 'docker exec wg-easy sh -ec wg-quick up wg-exit' "$RELAY_TEST_LOG"
echo 'Relay namespace: host ipset, fail-fast shell and container WireGuard lifecycle passed'
