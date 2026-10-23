#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
export CONFIG_FILE="$test_dir/absent.env" STATE_DB="$test_dir/absent.db"
source <(sed '$d' "$repo/bin/wg-captive-agent")
RELAY_EXIT_CONF="$test_dir/profile.conf"
RELAY_TUNNEL_FLAG="$test_dir/intent"
printf 'test\n' > "$RELAY_EXIT_CONF"
RELAY_PROTOCOL=wireguard
relay_copy_conf() { return 1; }
if relay_tunnel_up > "$test_dir/log" 2>&1; then echo 'failed config copy accepted' >&2; exit 1; fi
relay_copy_conf() { :; }
relay_wg_exec() { [[ "$1" != *' up '* ]]; }
if relay_tunnel_up > "$test_dir/log" 2>&1; then echo 'failed wg-quick up accepted' >&2; exit 1; fi
if grep -q '^relay_tunnel: up$' "$test_dir/log"; then echo 'false success printed' >&2; exit 1; fi
systemctl() { return 1; }
db_write_relay_conf() { :; }
awg() { :; }
awg-quick() { :; }
amneziawg-go() { :; }
openvpn() { :; }
for RELAY_PROTOCOL in amneziawg openvpn; do
  if relay_tunnel_up > "$test_dir/log" 2>&1; then echo 'failed service start accepted' >&2; exit 1; fi
  if relay_tunnel_down > "$test_dir/log" 2>&1; then echo 'failed service stop accepted' >&2; exit 1; fi
done
RELAY_PROTOCOL=wireguard
echo 'enabled:wireguard:1:2' > "$RELAY_TUNNEL_FLAG"
relay_exec() { [[ "$1" == *'ip link show'* ]]; }
if (relay_delete_config) > "$test_dir/log" 2>&1; then echo 'active config deleted' >&2; exit 1; fi
[[ "$(cat "$RELAY_TUNNEL_FLAG")" == 'enabled:wireguard:1:2' ]]
echo 'Relay errors: config/start/stop failures propagate and rejected deletion preserves watchdog intent'
