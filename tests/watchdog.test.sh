#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
export CONFIG_FILE="$test_dir/absent.env" STATE_DB="$test_dir/absent.db"
export AGENT_BIN="$repo/bin/wg-captive-agent" WATCHDOG_LIBRARY=1
export RELAY_WATCHDOG_DIR="$test_dir" RELAY_TUNNEL_FLAG="$test_dir/intent" RELAY_HEALTH_FILE="$test_dir/health"
source "$repo/bin/wg-captive-watchdog"
RELAY_PROTOCOL=wireguard
RELAY_EXIT_IF=wg-exit
WG_EASY_CONTAINER=wg-easy
RELAY_ROUTE_FLAG="$test_dir/route"
log="$test_dir/log"
rx_value=100
probe_result=1
timestamp=1000
date() { echo "$timestamp"; }
resolve_netns() { NETNS_PID=1234; }
watchdog_rx() { echo "$rx_value"; }
original_probe="$(declare -f watchdog_probe)"
watchdog_probe() { echo probe >> "$log"; echo "probe_mode ${1:-0}" >> "$log"; return "$probe_result"; }
timeout() { echo "$*" >> "$log"; }
echo 'enabled:wireguard:1:2' > "$RELAY_TUNNEL_FLAG"
watchdog_tick
grep -q 'watchdog_failures: 1' "$RELAY_HEALTH_FILE"
watchdog_tick
grep -q 'watchdog_failures: 2' "$RELAY_HEALTH_FILE"
if grep -q relay-recover "$log"; then echo 'restart before three failures' >&2; exit 1; fi
watchdog_tick
[[ "$(grep -c relay-recover "$log")" == 1 ]]
watchdog_tick
[[ "$(grep -c relay-recover "$log")" == 1 ]]
grep -q '^probe_mode 1$' "$log"
timestamp=1029
watchdog_tick
[[ "$(grep -c relay-recover "$log")" == 1 ]]
timestamp=1030
watchdog_tick
[[ "$(grep -c relay-recover "$log")" == 2 ]]
rx_value=0
timestamp=1060
watchdog_tick
[[ "$(grep -c relay-recover "$log")" == 3 ]]
probe_result=0
watchdog_tick
grep -q 'watchdog_state: healthy_probe' "$RELAY_HEALTH_FILE"
grep -q 'watchdog_failures: 0' "$RELAY_HEALTH_FILE"
rx_value=1
probe_result=1
before="$(grep -c '^probe$' "$log")"
watchdog_tick
grep -q 'watchdog_state: healthy_rx' "$RELAY_HEALTH_FILE"
[[ "$(grep -c '^probe$' "$log")" == "$before" ]]
probe_result=2
watchdog_tick
grep -q 'watchdog_state: probe_setup_error' "$RELAY_HEALTH_FILE"
[[ "$(grep -c relay-recover "$log")" == 3 ]]
echo 'disabled:wireguard:2:3' > "$RELAY_TUNNEL_FLAG"
watchdog_tick
grep -q 'watchdog_state: idle' "$RELAY_HEALTH_FILE"
[[ "$(grep -c relay-recover "$log")" == 3 ]]
echo 'enabled:amneziawg:3:4' > "$RELAY_TUNNEL_FLAG"
RELAY_PROTOCOL=amneziawg
RELAY_EXIT_IF=awg-exit
probe_result=1
watchdog_tick
grep -q 'watchdog_failures: 1' "$RELAY_HEALTH_FILE"
RELAY_PROTOCOL=openvpn
watchdog_tick
grep -q 'watchdog_state: idle' "$RELAY_HEALTH_FILE"

# Actual probe orchestration must fan out, stop on success, and always clean up.
eval "$original_probe"
watchdog_probe_setup() { echo setup >> "$log"; }
watchdog_cleanup() { echo cleanup >> "$log"; }
watchdog_probe_target() { echo "target $1" >> "$log"; [[ "$1" == 8.8.8.8 ]]; }
watchdog_probe
grep -q 'target 1.1.1.1' "$log"
grep -q 'target 8.8.8.8' "$log"
if grep -q 'target 9.9.9.9' "$log"; then echo 'probing continued after success' >&2; exit 1; fi
watchdog_probe_target() { echo "target $1" >> "$log"; return 1; }
if watchdog_probe; then echo 'all failing targets marked healthy' >&2; exit 1; fi
grep -q 'target 9.9.9.9' "$log"
[[ "$(grep -c '^cleanup$' "$log")" == 2 ]]
secondary_before="$(grep -c '^target 8.8.8.8$' "$log")"
if watchdog_probe 1; then echo 'failed reconnect probe marked healthy' >&2; exit 1; fi
[[ "$(grep -c '^target 8.8.8.8$' "$log")" == "$secondary_before" ]]
[[ "$(grep -c '^cleanup$' "$log")" == 3 ]]

# Recovery must re-check operator intent under the agent's lock.
RELAY_PROTOCOL=wireguard
relay_tunnel_down() { echo down >> "$log"; }
relay_tunnel_up() { echo up >> "$log"; }
relay_route_on() { echo route >> "$log"; }
echo 'disabled:wireguard:4:5' > "$RELAY_TUNNEL_FLAG"
relay_recover 'enabled:wireguard:1:2'
if grep -q '^up$' "$log"; then echo 'recovery undid manual stop' >&2; exit 1; fi
echo 'enabled:wireguard:4:6' > "$RELAY_TUNNEL_FLAG"
relay_recover 'enabled:wireguard:1:2'
if grep -q '^up$' "$log"; then echo 'stale generation restarted new tunnel' >&2; exit 1; fi
touch "$RELAY_ROUTE_FLAG"
relay_recover 'enabled:wireguard:4:6'
grep -q '^down$' "$log"
grep -q '^up$' "$log"
grep -q '^route$' "$log"
echo 'Watchdog: RX delta, probes, three failures, repeated recovery, cooldown, stop and generation safety passed'
