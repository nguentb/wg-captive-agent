#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d)"
supervisor=""
cleanup() {
  if [[ -n "$supervisor" ]]; then kill "$supervisor" 2>/dev/null || true; wait "$supervisor" 2>/dev/null || true; fi
  rm -rf "$test_dir"
}
trap cleanup EXIT
export XRAY_TEST_DIR="$test_dir"
export CONFIG_FILE="$test_dir/agent.env"
export XRAY_BIN="$test_dir/mock-xray"
export XRAY_HELPER="$test_dir/helper.js"
export XRAY_RUNTIME_DIR="$test_dir/runtime"
export AGENT_BIN="$test_dir/mock-agent"
export RELAY_ROUTE_FLAG="$test_dir/enabled"
printf 'WG_EASY_CONTAINER=wg-easy\n' > "$CONFIG_FILE"
touch "$RELAY_ROUTE_FLAG"
echo '{}' > "$test_dir/profile.json"
echo 1234 > "$test_dir/namespace"
cat > "$XRAY_BIN" <<'SH'
#!/usr/bin/env bash
if [[ "$*" == *'-test'* ]]; then
  [[ "$*" == *check.json* ]] || exit 1
  exit 0
fi
echo "$BASHPID" > "$XRAY_TEST_DIR/child.pid"
echo started >> "$XRAY_TEST_DIR/starts"
exec sleep 60
SH
cat > "$AGENT_BIN" <<'SH'
#!/usr/bin/env bash
[[ "$1" == relay-reapply ]] || exit 1
if [[ ! -f "$XRAY_TEST_DIR/busy" ]]; then touch "$XRAY_TEST_DIR/busy"; exit 75; fi
echo restored > "$XRAY_TEST_DIR/restored"
SH
chmod +x "$XRAY_BIN" "$AGENT_BIN"
sqlite3() { if [[ "$*" == *'SELECT protocol'* ]]; then echo xray; else echo "$XRAY_TEST_DIR/profile.json"; fi; }
node() { if [[ "$*" == *' endpoint '* ]]; then echo exit.example.com; else echo '{}'; fi; }
getent() { echo '203.0.113.10 STREAM exit.example.com'; }
docker() { cat "$XRAY_TEST_DIR/namespace"; }
nsenter() { shift 3; "$@"; }
ip() { return 0; }
install() { mkdir -p "${@: -1}"; }
export -f sqlite3 node getent docker nsenter ip install
bash "$repo/bin/wg-captive-xray" > "$test_dir/supervisor.log" 2>&1 &
supervisor="$!"
for attempt in {1..100}; do [[ ! -f "$test_dir/restored" ]] || break; sleep 0.1; done
[[ -f "$test_dir/restored" ]] || { cat "$test_dir/supervisor.log"; exit 1; }
[[ "$(wc -l < "$test_dir/starts")" == 1 ]]
started_at=$SECONDS
kill -TERM "$supervisor"
wait "$supervisor"
supervisor=""
(( SECONDS - started_at <= 2 ))
if kill -0 "$(cat "$test_dir/child.pid")" 2>/dev/null; then echo 'Xray child leaked' >&2; exit 1; fi
bash "$repo/bin/wg-captive-xray" >> "$test_dir/supervisor.log" 2>&1 &
supervisor="$!"
for attempt in {1..50}; do [[ "$(wc -l < "$test_dir/starts")" != 2 ]] || break; sleep 0.1; done
echo 5678 > "$test_dir/namespace"
if wait "$supervisor"; then echo 'Namespace change did not stop stale Xray' >&2; exit 1; fi
supervisor=""
if kill -0 "$(cat "$test_dir/child.pid")" 2>/dev/null; then echo 'Stale Xray child leaked' >&2; exit 1; fi
echo 'Xray supervisor: non-TUN validation, busy-lock retry, fast stop, namespace change and child cleanup passed'
