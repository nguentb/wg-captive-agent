#!/usr/bin/env bash
set -euo pipefail

retire_legacy_openvpn() {
  local config_file="${CONFIG_FILE:-/etc/wg-captive-agent.env}"
  [[ ! -f "$config_file" ]] || source "$config_file"
  local db="${STATE_DB:-/etc/wg-captive-agent.db}"
  local agent="${AGENT_BIN:-/usr/local/sbin/wg-captive-agent}"
  local unit="${LEGACY_OPENVPN_UNIT:-/etc/systemd/system/wg-captive-openvpn.service}"
  local protocol="${RELAY_PROTOCOL:-wireguard}" stored=""
  if [[ -f "$db" ]]; then
    stored="$(sqlite3 -noheader "$db" 'SELECT protocol FROM relay_config WHERE id=1;' 2>/dev/null || true)"
    protocol="${stored:-$protocol}"
  fi
  if [[ "$protocol" == openvpn ]]; then
    [[ -x "$agent" ]] || { echo 'Cannot remove OpenVPN route: previous agent is missing' >&2; return 1; }
    CONFIG_FILE="$config_file" "$agent" relay-disable || return 1
  fi
  if [[ -f "$unit" ]] || systemctl is-active --quiet wg-captive-openvpn.service; then
    systemctl stop wg-captive-openvpn.service || return 1
    systemctl disable wg-captive-openvpn.service 2>/dev/null || true
  fi
  if [[ "$stored" == openvpn ]]; then
    sqlite3 "$db" "UPDATE relay_config SET protocol='wireguard', enabled=0, updated_at=CURRENT_TIMESTAMP WHERE id=1;" || return 1
    echo 'Retired OpenVPN routing; WireGuard selected but not started. Saved profiles retained.'
  fi
  rm -f -- "$unit" /usr/local/sbin/wg-captive-openvpn /usr/local/lib/wg-captive-agent/openvpn-state.js
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  [[ "$EUID" == 0 ]] || { echo 'Run installer as root' >&2; exit 1; }
  retire_legacy_openvpn
fi
