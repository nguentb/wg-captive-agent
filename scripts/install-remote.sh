#!/usr/bin/env bash
set -euo pipefail

REPO="${WG_CAPTIVE_REPO:-nguentb/wg-captive-agent}"
BRANCH="${WG_CAPTIVE_BRANCH:-main}"
TARBALL_URL="${WG_CAPTIVE_TARBALL_URL:-https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz}"
TMP_DIR=""

log() {
  printf '[wg-captive] %s\n' "$*"
}

fail() {
  printf '[wg-captive] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

if [[ "${EUID}" -ne 0 ]]; then
  fail "Please run as root, for example: curl -fsSL ... | sudo bash"
fi

if command -v apt-get >/dev/null 2>&1; then
  log "Installing dependencies with apt-get"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  rm -f /etc/apt/keyrings/nodesource.gpg
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y iptables ipset tar nodejs util-linux wireguard-tools openvpn
else
  log "apt-get not found; assuming iptables, ipset, curl, tar, Node.js 24 LTS and nsenter are already installed"
fi

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v node >/dev/null 2>&1 || fail "Node.js 24 LTS is required"
NODE_MAJOR="$(node -p 'parseInt(process.versions.node.split(".")[0], 10)' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  fail "Node.js 24 LTS is required; current version is $(node -v 2>/dev/null || echo unknown)"
fi
AUTO_SELECT_FAMILY="$(node -p 'require("node:net").getDefaultAutoSelectFamily() ? "true" : "false"' 2>/dev/null || echo false)"
if [[ "$AUTO_SELECT_FAMILY" != "true" ]]; then
  fail "Node.js autoSelectFamily must be true; current value is ${AUTO_SELECT_FAMILY}"
fi

TMP_DIR="$(mktemp -d)"
log "Downloading ${TARBALL_URL}"
curl -fsSL "$TARBALL_URL" -o "$TMP_DIR/source.tar.gz"
tar -xzf "$TMP_DIR/source.tar.gz" -C "$TMP_DIR"
SRC_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[[ -n "$SRC_DIR" && -f "$SRC_DIR/install.sh" ]] || fail "Downloaded archive does not contain install.sh"

cd "$SRC_DIR"
chmod +x install.sh bin/wg-captive-agent bin/wg-captive-redirect uninstall.sh scripts/wg-captive-update scripts/wg-captive-ssl-cloudflare scripts/wg-captive-ssl-remove
log "Installing wg-captive-agent"
./install.sh

systemctl enable --now wg-captive-agent
systemctl enable --now wg-captive-admin
systemctl enable --now wg-captive-redirect
systemctl enable wg-captive-relay-restore
systemctl start wg-captive-relay-restore || true

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
ADMIN_PORT="$(grep -E '^ADMIN_PORT=' /etc/wg-captive-agent.env 2>/dev/null | tail -n 1 | cut -d= -f2-)"
ADMIN_PORT="${ADMIN_PORT:-51822}"

log "Installed successfully"
log "Edit config: nano /etc/wg-captive-agent.env"
log "Admin UI: http://${SERVER_IP:-SERVER_IP}:${ADMIN_PORT}"
log "IMPORTANT: create the admin password on first login before exposing the admin UI"
