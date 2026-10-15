#!/usr/bin/env bash
set -euo pipefail

# Upgrade-only cleanup. Saved profiles are deliberately kept for later recovery.
retire_legacy_xray() {
  local config_file="${CONFIG_FILE:-/etc/wg-captive-agent.env}"
  [[ ! -f "$config_file" ]] || source "$config_file"
  local db="${STATE_DB:-/etc/wg-captive-agent.db}"
  local agent="${AGENT_BIN:-/usr/local/sbin/wg-captive-agent}"
  local unit="${LEGACY_XRAY_UNIT:-/etc/systemd/system/wg-captive-xray.service}"
  local protocol=""
  if [[ -f "$db" ]]; then
    protocol="$(sqlite3 -noheader "$db" 'SELECT protocol FROM relay_config WHERE id=1;' 2>/dev/null || true)"
  fi
  if [[ "$protocol" == xray ]]; then
    [[ -x "$agent" ]] || { echo 'Cannot remove legacy Xray route: previous agent is missing' >&2; return 1; }
    # Abort the upgrade if route cleanup fails; do not strand an active old route.
    CONFIG_FILE="$config_file" "$agent" relay-disable || return 1
    sqlite3 "$db" "UPDATE relay_config SET protocol='wireguard', enabled=0, updated_at=CURRENT_TIMESTAMP WHERE id=1;" || return 1
    echo 'Retired Xray routing; WireGuard selected but not started. Saved profiles retained.'
  fi
  if [[ -f "$unit" ]] || systemctl is-active --quiet wg-captive-xray.service; then
    systemctl stop wg-captive-xray.service || return 1
    systemctl disable wg-captive-xray.service 2>/dev/null || true
  fi
  rm -f "$unit" \
    /usr/local/sbin/wg-captive-xray \
    /usr/local/bin/wg-captive-xray-install \
    /usr/local/lib/wg-captive-agent/xray-config.js \
    /usr/local/lib/wg-captive-agent/xray-ui.js \
    /usr/local/lib/wg-captive-agent/xray/xray \
    /usr/local/lib/wg-captive-agent/xray/xray.new \
    /usr/local/lib/wg-captive-agent/xray/version \
    /usr/local/lib/wg-captive-agent/xray/install.lock
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  [[ "$EUID" == 0 ]] || { echo 'Run installer as root' >&2; exit 1; }
  retire_legacy_xray
fi
