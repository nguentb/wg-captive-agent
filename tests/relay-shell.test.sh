#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
export CONFIG_FILE="$test_dir/absent.env" STATE_DB="$test_dir/absent.db"
source <(sed '$d' "$repo/bin/wg-captive-agent")
RELAY_ROUTE_FLAG="$test_dir/enabled"
RELAY_EXIT_CONF="$test_dir/exit.conf"
RELAY_PROTOCOL=wireguard
RELAY_EXIT_IF=wg-exit
RELAY_WG_EXIT_IF=wg-exit
printf 'test\n' > "$RELAY_EXIT_CONF"
log="$test_dir/commands"
touch "$log"
link_exists=1
tcp_ready=1
service_active=0
fail_mark=0
fail_apply=0
relay_exec() {
  printf '%s\n' "$1" >> "$log"
  if [[ "$fail_mark" == 1 && "$1" == *'ipset create'* ]]; then return 127; fi
  if [[ "$fail_apply" == 1 && "$1" == *'ip route add default'* ]]; then return 1; fi
  if [[ "$1" == *'ip link show'* ]]; then [[ "$link_exists" == 1 ]]; return; fi
  if [[ "$1" == *'ip -4 addr show'* ]]; then [[ "$tcp_ready" == 1 ]]; return; fi
  if [[ "$1" == *'ip rule show'* ]]; then return 1; fi
  return 0
}
systemctl() {
  printf 'systemctl %s\n' "$*" >> "$log"
  if [[ "$1" == is-active ]]; then [[ "$service_active" == 1 ]]; return; fi
  return 0
}
openvpn() { :; }
sleep() { :; }
relay_ensure_forward() { :; }
resolve_netns() { :; }
sync_blocked_dest_ipset() { :; }
db_write_relay_conf() { :; }
db_exec() { :; }

relay_route_on >/dev/null
grep -qF "ip route add default dev 'wg-exit'" "$log"
grep -qF -- "--match-set 'wg_expired' src -j RETURN" "$log"
grep -qF -- "--match-set 'wg_blocked_dst' dst -j RETURN" "$log"
grep -qF -- "-p udp --dport 53 -j RETURN" "$log" || exit 1
relay_route_off >/dev/null
[[ ! -f "$RELAY_ROUTE_FLAG" ]]
RELAY_PROTOCOL=openvpn
RELAY_EXIT_IF=tun-exit
relay_tunnel_up >/dev/null
grep -qF 'systemctl start wg-captive-openvpn.service' "$log"
starts="$(grep -cF 'systemctl start wg-captive-openvpn.service' "$log")"
service_active=1
relay_enable >/dev/null
[[ "$(grep -cF 'systemctl start wg-captive-openvpn.service' "$log")" == "$starts" ]]
if grep -qF 'systemctl restart wg-captive-openvpn.service' "$log"; then echo 'enable restarted an active TCP tunnel' >&2; exit 1; fi
service_active=0
relay_route_on >/dev/null
grep -qF "ip route add default dev 'tun-exit'" "$log"
grep -qF -- "-o 'tun-exit' -j MASQUERADE" "$log" || exit 1
if (relay_select wireguard) 2>/dev/null; then echo 'selection allowed with active route' >&2; exit 1; fi
relay_route_off >/dev/null
if (relay_select wireguard) 2>/dev/null; then echo 'selection allowed with active tunnel' >&2; exit 1; fi
fail_mark=1
if relay_route_on > "$test_dir/failed-mark.log" 2>&1; then echo 'missing ipset was reported as enabled' >&2; exit 1; fi
[[ ! -f "$RELAY_ROUTE_FLAG" ]]
fail_mark=0
fail_apply=1
if relay_route_on > "$test_dir/failed-route.log" 2>&1; then echo 'failed route was reported as enabled' >&2; exit 1; fi
[[ ! -f "$RELAY_ROUTE_FLAG" ]]
fail_apply=0
relay_tunnel_down >/dev/null
tcp_ready=0
if (relay_tunnel_up) 2>/dev/null; then echo 'TCP startup should fail' >&2; exit 1; fi
grep -qF 'systemctl stop wg-captive-openvpn.service' "$log"
link_exists=0
tcp_ready=1
starts="$(grep -cF 'systemctl start wg-captive-openvpn.service' "$log")"
touch "$RELAY_ROUTE_FLAG"
if relay_reapply; then echo 'route reapply missed disappearing interface' >&2; exit 1; fi
[[ "$(grep -cF 'systemctl start wg-captive-openvpn.service' "$log")" == "$starts" ]]
link_exists=1
relay_route_on() { printf 'route reapplied\n' >> "$log"; }
tcp_ready=1
rm -f "$RELAY_ROUTE_FLAG"
relay_reapply
if grep -qF 'route reapplied' "$log"; then echo 'reconnect undid manual stop' >&2; exit 1; fi
touch "$RELAY_ROUTE_FLAG"
relay_reapply
grep -qF 'route reapplied' "$log"

RELAY_LOCK_FILE="$test_dir/relay.lock"
flock() { printf 'flock %s\n' "$*" >> "$log"; return 1; }
if relay_acquire_lock relay-reapply; then echo 'busy background lock was accepted' >&2; exit 1; else [[ "$?" == 75 ]]; fi
grep -qF 'flock -n 9' "$log"
if (relay_acquire_lock relay-enable) 2>/dev/null; then echo 'busy foreground lock was accepted' >&2; exit 1; fi
grep -qF 'flock -w 2 9' "$log"
echo 'Relay shell: shared policy, UDP/TCP route, switch guards and TCP startup failure passed'
