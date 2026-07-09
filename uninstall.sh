#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${CONFIG_FILE:-/etc/wg-captive-agent.env}"
AGENT_BIN="${AGENT_BIN:-/usr/local/sbin/wg-captive-agent}"
APP_LIB_DIR="${APP_LIB_DIR:-/usr/local/lib/wg-captive-agent}"

WG_INTERFACE="wg0"
IPSET_NAME="wg_expired"
EXPIRED_FILE="/etc/wg-captive-expired.txt"
STATE_DB="/etc/wg-captive-agent.db"
BACKUP_DIR="/var/backups/wg-captive"
WG_EASY_CONTAINER="wg-easy"
RELAY_EXIT_IF="wg-exit"
RELAY_CLIENT_SUBNET="10.8.0.0/24"
RELAY_ROUTE_TABLE="200"
RELAY_EXIT_CONF="/etc/wg-captive-relay-exit.conf"
RELAY_ROUTE_FLAG="/etc/wg-captive-relay.enabled"

log() { printf '[wg-captive uninstall] %s\n' "$*"; }
run() { "$@" >/dev/null 2>&1 || true; }

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "Run as root: sudo $0" >&2
    exit 1
  fi
}

load_config() {
  if [[ -f "$CONFIG_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a
    source "$CONFIG_FILE"
    set +a
  fi
}

container_pid() {
  [[ -n "${WG_EASY_CONTAINER:-}" ]] || return 1
  command -v docker >/dev/null 2>&1 || return 1
  docker inspect -f '{{.State.Pid}}' "$WG_EASY_CONTAINER" 2>/dev/null | awk '$1 != "" && $1 != "0" {print $1}'
}

netns_run() {
  local pid
  pid="$(container_pid || true)"
  if [[ -n "$pid" ]] && command -v nsenter >/dev/null 2>&1; then
    nsenter -t "$pid" -n "$@" >/dev/null 2>&1 || true
  else
    "$@" >/dev/null 2>&1 || true
  fi
}

relay_shell() {
  if [[ -n "${WG_EASY_CONTAINER:-}" ]] && command -v docker >/dev/null 2>&1 && docker inspect "$WG_EASY_CONTAINER" >/dev/null 2>&1; then
    docker exec "$WG_EASY_CONTAINER" sh -c "$1" >/dev/null 2>&1 || true
  else
    sh -c "$1" >/dev/null 2>&1 || true
  fi
}

remove_captive_rules() {
  log "Removing captive firewall rules"
  netns_run iptables -t nat -D PREROUTING -i "$WG_INTERFACE" -m set --match-set "$IPSET_NAME" src -j WG_CAPTIVE_NAT
  netns_run iptables -t nat -D PREROUTING -m set --match-set "$IPSET_NAME" src -j WG_CAPTIVE_NAT
  netns_run iptables -D FORWARD -i "$WG_INTERFACE" -m set --match-set "$IPSET_NAME" src -j WG_CAPTIVE_FILTER
  netns_run iptables -D FORWARD -m set --match-set "$IPSET_NAME" src -j WG_CAPTIVE_FILTER
  netns_run iptables -t nat -F WG_CAPTIVE_NAT
  netns_run iptables -t nat -X WG_CAPTIVE_NAT
  netns_run iptables -F WG_CAPTIVE_FILTER
  netns_run iptables -X WG_CAPTIVE_FILTER
  netns_run ipset destroy "$IPSET_NAME"
}

remove_relay_rules() {
  log "Removing relay tunnel and route"
  if [[ -x "$AGENT_BIN" ]]; then
    run "$AGENT_BIN" relay-off
    run "$AGENT_BIN" relay-tunnel-down
  fi

  relay_shell "wg-quick down '$RELAY_EXIT_IF' 2>/dev/null || true"
  relay_shell "while ip rule del from '$RELAY_CLIENT_SUBNET' table '$RELAY_ROUTE_TABLE' 2>/dev/null; do :; done"
  relay_shell "ip route flush table '$RELAY_ROUTE_TABLE' 2>/dev/null || true"
  relay_shell "while iptables -t nat -D POSTROUTING -s '$RELAY_CLIENT_SUBNET' -o '$RELAY_EXIT_IF' -j MASQUERADE 2>/dev/null; do :; done"
  relay_shell "while iptables -D FORWARD -j WG_RELAY 2>/dev/null; do :; done"
  relay_shell "iptables -F WG_RELAY 2>/dev/null || true"
  relay_shell "iptables -X WG_RELAY 2>/dev/null || true"
  relay_shell "rm -f '/etc/wireguard/${RELAY_EXIT_IF}.conf'"
}

stop_services() {
  if command -v systemctl >/dev/null 2>&1; then
    log "Stopping systemd services"
    run systemctl disable --now wg-captive-agent.service
    run systemctl disable --now wg-captive-admin.service
    run systemctl disable --now wg-captive-relay-restore.service
  fi
}

remove_files() {
  log "Removing installed files and config"
  rm -f /etc/systemd/system/wg-captive-agent.service
  rm -f /etc/systemd/system/wg-captive-admin.service
  rm -f /etc/systemd/system/wg-captive-relay-restore.service
  rm -f "$AGENT_BIN"
  rm -f /usr/local/bin/wg-captive-agent
  rm -f /usr/local/bin/wg-captive-admin
  rm -rf "$APP_LIB_DIR"
  rm -rf /opt/wg-captive-agent

  rm -f "$CONFIG_FILE"
  rm -f "$EXPIRED_FILE"
  rm -f "$STATE_DB"
  rm -rf /var/lib/wg-captive-agent
  rm -f "$RELAY_EXIT_CONF"
  rm -f "$RELAY_ROUTE_FLAG"
  rm -f /etc/sysctl.d/99-wg-captive-relay.conf

  if [[ "${KEEP_BACKUPS:-0}" != "1" ]]; then
    rm -rf "$BACKUP_DIR"
  else
    log "Keeping backup directory because KEEP_BACKUPS=1: $BACKUP_DIR"
  fi
}

reload_systemd() {
  if command -v systemctl >/dev/null 2>&1; then
    run systemctl daemon-reload
    run systemctl reset-failed
  fi
}

verify_cleanup() {
  log "Verification"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl list-unit-files 'wg-captive-*' --no-legend 2>/dev/null || true
  fi
  printf 'agent binary: '; [[ -e "$AGENT_BIN" ]] && echo "still exists: $AGENT_BIN" || echo "removed"
  printf 'config file: '; [[ -e "$CONFIG_FILE" ]] && echo "still exists: $CONFIG_FILE" || echo "removed"
}

main() {
  require_root
  load_config
  stop_services

  if [[ -x "$AGENT_BIN" ]]; then
    log "Running built-in cleanup"
    run "$AGENT_BIN" cleanup
  fi

  remove_relay_rules
  remove_captive_rules
  remove_files
  reload_systemd
  verify_cleanup
  log "Uninstall complete. System packages such as nodejs, iptables, ipset, curl and docker were not removed."
}

main "$@"
