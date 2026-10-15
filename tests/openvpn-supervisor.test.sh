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
export OPENVPN_TEST_DIR="$test_dir"
export CONFIG_FILE="$test_dir/agent.env"
printf 'WG_EASY_CONTAINER=host\n' > "$CONFIG_FILE"
export OPENVPN_RUNTIME_DIR="$test_dir/runtime"
export RELAY_ROUTE_FLAG="$test_dir/relay.enabled"
export AGENT_BIN="$test_dir/mock-agent"
touch "$RELAY_ROUTE_FLAG"
printf 'remote exit.example.com 8443 tcp4-client\n' > "$test_dir/profile.ovpn"
cat > "$AGENT_BIN" <<'SH'
#!/usr/bin/env bash
[[ "$1" == relay-reapply ]] || exit 1
if [[ ! -f "$OPENVPN_TEST_DIR/busy-once" ]]; then
  touch "$OPENVPN_TEST_DIR/busy-once"
  echo deferred >> "$OPENVPN_TEST_DIR/reapply.log"
  exit 75
fi
echo restored >> "$OPENVPN_TEST_DIR/reapply.log"
SH
chmod +x "$AGENT_BIN"
sqlite3() {
  if [[ "$*" == *'SELECT protocol'* ]]; then echo openvpn; else echo "$OPENVPN_TEST_DIR/profile.ovpn"; fi
}
getent() { printf '203.0.113.10 STREAM exit.example.com\n203.0.113.10 DGRAM exit.example.com\n203.0.113.11 STREAM exit.example.com\n'; }
node() { [[ ! -f "$OPENVPN_TEST_DIR/disconnected" ]]; }
ip() { echo 'inet 10.250.240.2/24'; }
install() { mkdir -p "${@: -1}"; }
openvpn() {
  printf '%s\n' "$*" > "$OPENVPN_TEST_DIR/args"
  echo started >> "$OPENVPN_TEST_DIR/starts.log"
  echo "$BASHPID" > "$OPENVPN_TEST_DIR/child.pid"
  exec sleep 60
}
export -f sqlite3 getent ip openvpn install node
bash "$repo/bin/wg-captive-openvpn" > "$test_dir/supervisor.log" 2>&1 &
supervisor="$!"
for attempt in {1..100}; do
  if [[ -f "$test_dir/reapply.log" ]] && grep -q restored "$test_dir/reapply.log"; then break; fi
  sleep 0.1
done
if [[ ! -f "$test_dir/reapply.log" ]]; then
  cat "$test_dir/supervisor.log" >&2
  echo 'supervisor did not attempt route restore' >&2
  exit 1
fi
grep -q deferred "$test_dir/reapply.log"
grep -q restored "$test_dir/reapply.log"
[[ "$(wc -l < "$test_dir/starts.log")" == 1 ]]
[[ "$(grep -c '^remote ' "$OPENVPN_RUNTIME_DIR/client.ovpn")" == 2 ]]
grep -q '^remote 203.0.113.11 8443 tcp4-client$' "$OPENVPN_RUNTIME_DIR/client.ovpn"
grep -qF -- '--connect-timeout 10 --connect-retry 1 5' "$test_dir/args"
grep -qF -- '--management-client-user root' "$test_dir/args"
touch "$OPENVPN_TEST_DIR/disconnected"
sleep 3
rm -f "$test_dir/reapply.log"
rm -f "$OPENVPN_TEST_DIR/disconnected"
for attempt in {1..50}; do [[ ! -f "$test_dir/reapply.log" ]] || break; sleep 0.1; done
grep -q restored "$test_dir/reapply.log"
[[ "$(wc -l < "$test_dir/starts.log")" == 1 ]]
started_at=$SECONDS
kill -TERM "$supervisor"
wait "$supervisor"
supervisor=""
(( SECONDS - started_at <= 2 ))
if kill -0 "$(cat "$test_dir/child.pid")" 2>/dev/null; then echo 'OpenVPN child leaked after stop' >&2; exit 1; fi
echo 'OpenVPN supervisor: address fallback, handshake readiness, reconnect reapply, busy-lock retry and fast stop passed'
