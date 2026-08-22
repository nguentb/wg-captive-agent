#!/usr/bin/env bash
set -euo pipefail

command -v node >/dev/null 2>&1 || { echo "Node.js 24 LTS is required." >&2; exit 1; }
NODE_MAJOR="$(node -p 'parseInt(process.versions.node.split(".")[0], 10)' 2>/dev/null || echo 0)"
[[ "$NODE_MAJOR" -ge 24 ]] || { echo "Node.js 24 LTS is required; current version is $(node -v)." >&2; exit 1; }
AUTO_SELECT_FAMILY="$(node -p 'require("node:net").getDefaultAutoSelectFamily() ? "true" : "false"' 2>/dev/null || echo false)"
[[ "$AUTO_SELECT_FAMILY" == "true" ]] || { echo "Node.js autoSelectFamily must be true; current value is ${AUTO_SELECT_FAMILY}." >&2; exit 1; }
node --check web/wg-captive-admin.js
bash -n bin/wg-captive-agent bin/wg-captive-redirect

if ! command -v sqlite3 >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y sqlite3
  else
    echo "sqlite3 is required. Install sqlite3 first, then run install.sh again." >&2
    exit 1
  fi
fi

install -m 0755 bin/wg-captive-agent /usr/local/sbin/wg-captive-agent
install -m 0755 bin/wg-captive-redirect /usr/local/sbin/wg-captive-redirect
install -m 0755 scripts/wg-captive-update /usr/local/bin/wg-captive-update
install -m 0755 scripts/wg-captive-ssl-cloudflare /usr/local/bin/wg-captive-ssl-cloudflare
install -m 0755 scripts/wg-captive-ssl-remove /usr/local/bin/wg-captive-ssl-remove
ln -sf /usr/local/bin/wg-captive-update /usr/local/bin/captive_update
ln -sf /usr/local/bin/wg-captive-ssl-cloudflare /usr/local/bin/captive_ssl_cloudflare
ln -sf /usr/local/bin/wg-captive-ssl-remove /usr/local/bin/captive_ssl_remove
install -d -m 0755 /usr/local/lib/wg-captive-agent
install -d -m 0755 /var/backups/wg-captive
install -d -m 0755 /var/lib/wg-captive-agent
install -m 0755 web/wg-captive-admin.js /usr/local/lib/wg-captive-agent/wg-captive-admin.js

if [[ ! -f /etc/wg-captive-agent.env ]]; then
  install -m 0600 examples/wg-captive-agent.env /etc/wg-captive-agent.env
fi
sed -i '/^ADMIN_PASSWORD=/d' /etc/wg-captive-agent.env
if ! grep -qE '^ADMIN_PASSWORD_HASH=' /etc/wg-captive-agent.env; then
  printf 'ADMIN_PASSWORD_HASH=\n' >> /etc/wg-captive-agent.env
fi
chmod 0600 /etc/wg-captive-agent.env

if [[ ! -f /etc/wg-captive-expired.txt ]]; then
  install -m 0644 examples/wg-captive-expired.txt /etc/wg-captive-expired.txt
fi

install -m 0644 systemd/wg-captive-agent.service /etc/systemd/system/wg-captive-agent.service
install -m 0644 systemd/wg-captive-admin.service /etc/systemd/system/wg-captive-admin.service
install -m 0644 systemd/wg-captive-redirect.service /etc/systemd/system/wg-captive-redirect.service
install -m 0644 systemd/wg-captive-relay-restore.service /etc/systemd/system/wg-captive-relay-restore.service

systemctl daemon-reload

if systemctl is-active --quiet wg-captive-admin.service; then
  systemctl enable --now wg-captive-redirect.service
fi

echo "Installed wg-captive-agent."
echo "Edit /etc/wg-captive-agent.env, then run:"
echo "  systemctl enable --now wg-captive-agent"
echo "  systemctl enable --now wg-captive-admin"
echo "  systemctl enable --now wg-captive-redirect"
echo "  systemctl enable wg-captive-relay-restore"
