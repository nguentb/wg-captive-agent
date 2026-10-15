#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
export CONFIG_FILE="$test_dir/absent.env" STATE_DB="$test_dir/absent.db"
source <(sed '$d' "$repo/bin/wg-captive-agent")
RELAY_PROTOCOL=xray
RELAY_EXIT_IF=xray-exit
RELAY_EXIT_CONF="$test_dir/exit.json"
RELAY_ROUTE_FLAG="$test_dir/enabled"
printf '{}\n' > "$RELAY_EXIT_CONF"
log="$test_dir/log"
relay_exec() {
  printf '%s\n' "$1" >> "$log"
  if [[ "$1" == *'ip rule show'* ]]; then return 1; fi
  return 0
}
resolve_netns() { :; }
relay_ensure_forward() { :; }
require_config() { :; }
ensure_firewall() { echo captive-guard >> "$log"; }
sync_ipset() { echo captive-sync >> "$log"; }
sync_blocked_dest_ipset() { echo malware-sync >> "$log"; }
db_write_relay_conf() { :; }
db_exec() { :; }
systemctl() { printf 'systemctl %s\n' "$*" >> "$log"; }
relay_route_on > /dev/null
[[ -f "$RELAY_ROUTE_FLAG" ]]
grep -qF 'captive-guard' "$log"
grep -qF 'captive-sync' "$log"
grep -qF 'malware-sync' "$log"
grep -qF -- "-p udp --dport 53 -j RETURN" "$log"
grep -qF -- "-p tcp --dport 53 -j RETURN" "$log"
grep -qF -- "-p tcp --dport 853 -j RETURN" "$log"
grep -qF -- "--match-set 'wg_expired' src -j RETURN" "$log"
grep -qF -- "--match-set 'wg_blocked_dst' dst -j DROP" "$log"
grep -qF "ip route add default dev 'xray-exit' table '200'" "$log"
grep -qF "ip route add blackhole default metric 32760 table '200'" "$log"
grep -qF 'net.ipv4.conf.xray-exit.rp_filter=2' "$log"
grep -qF -- "if [ 'xray' != xray ]; then" "$log"
grep -qF -- "-i 'xray-exit' -d '10.8.0.0/24' -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT" "$log"
grep -qF 'wg-captive-xray -j REJECT' "$log"
if grep -qE 'table main.*default|ip route (replace|add) default.*table main|resolv.conf' "$log"; then exit 1; fi
relay_tunnel_down >/dev/null
grep -qF 'systemctl stop wg-captive-xray.service' "$log"
relay_route_off >/dev/null
[[ ! -f "$RELAY_ROUTE_FLAG" ]]
echo 'Xray shell: shared captive/malware/DNS policy, IPv6 guard, no recursive route, fail-closed fallback and stop passed'
