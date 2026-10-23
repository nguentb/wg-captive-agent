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
export AWG_TEST_DIR="$test_dir" CONFIG_FILE="$test_dir/agent.env"
export AMNEZIAWG_RUNTIME_DIR="$test_dir/runtime" AGENT_BIN="$test_dir/agent"
export RELAY_ROUTE_FLAG="$test_dir/enabled"
printf 'WG_EASY_CONTAINER=wg-easy\n' > "$CONFIG_FILE"
echo 1234 > "$test_dir/container-pid"
printf '[Interface]\n' > "$test_dir/profile.conf"
touch "$RELAY_ROUTE_FLAG"
cat > "$AGENT_BIN" <<'SH'
#!/usr/bin/env bash
[[ "$1" == relay-reapply ]] || exit 1
if [[ ! -f "$AWG_TEST_DIR/busy-once" ]]; then
  touch "$AWG_TEST_DIR/busy-once"
  echo deferred >> "$AWG_TEST_DIR/restore"
  exit 75
fi
echo restored >> "$AWG_TEST_DIR/restore"
SH
chmod +x "$AGENT_BIN"
sqlite3() {
  if [[ "$*" == *'SELECT protocol'* ]]; then echo amneziawg; else echo "$AWG_TEST_DIR/profile.conf"; fi
}
docker() { cat "$AWG_TEST_DIR/container-pid"; }
node() { printf 'Table = off\n' > "${@: -1}"; }
install() { mkdir -p "${@: -1}"; }
nsenter() { printf '%s\n' "$*" >> "$AWG_TEST_DIR/netns"; shift 3; "$@"; }
timeout() { shift; "$@"; }
awg-quick() {
  echo "$1" >> "$AWG_TEST_DIR/quick"
  if [[ "$1" == up ]]; then touch "$AWG_TEST_DIR/link"; else rm -f "$AWG_TEST_DIR/link"; fi
}
ip() { [[ -f "$AWG_TEST_DIR/link" ]]; }
export -f sqlite3 docker node install nsenter timeout awg-quick ip
start_supervisor() {
  rm -f "$test_dir/restore"
  bash "$repo/bin/wg-captive-amneziawg" > "$test_dir/log" 2>&1 &
  supervisor="$!"
  for attempt in {1..100}; do
    if [[ -f "$test_dir/restore" ]] && grep -q restored "$test_dir/restore"; then return; fi
    sleep 0.1
  done
  cat "$test_dir/log" >&2
  exit 1
}
start_supervisor
grep -q deferred "$test_dir/restore"
grep -qF -- '-t 1234 -n' "$test_dir/netns"
[[ "$(grep -c '^up$' "$test_dir/quick")" == 1 ]]
started_at=$SECONDS
kill -TERM "$supervisor"
wait "$supervisor"
supervisor=""
(( SECONDS - started_at <= 2 ))
grep -q '^down$' "$test_dir/quick"
[[ ! -f "$AMNEZIAWG_RUNTIME_DIR/awg-exit.conf" && ! -f "$test_dir/link" ]]
start_supervisor
echo 1235 > "$test_dir/container-pid"
for attempt in {1..60}; do kill -0 "$supervisor" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$supervisor" 2>/dev/null; then echo 'AWG ignored namespace change' >&2; exit 1; fi
if wait "$supervisor"; then echo 'AWG namespace change must request systemd restart' >&2; exit 1; fi
supervisor=""
[[ ! -f "$test_dir/link" ]]
echo 'AmneziaWG supervisor: netns isolation, busy-lock retry, fast stop and container replacement passed'
