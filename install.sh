#!/usr/bin/env bash
set -euo pipefail

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
install -d -m 0755 /usr/local/lib/wg-captive-agent
install -d -m 0755 /var/backups/wg-captive
install -d -m 0755 /var/lib/wg-captive-agent
install -m 0755 web/wg-captive-admin.js /usr/local/lib/wg-captive-agent/wg-captive-admin.js

if [[ ! -f /etc/wg-captive-agent.env ]]; then
  install -m 0644 examples/wg-captive-agent.env /etc/wg-captive-agent.env
fi

if [[ ! -f /etc/wg-captive-expired.txt ]]; then
  install -m 0644 examples/wg-captive-expired.txt /etc/wg-captive-expired.txt
fi

install -m 0644 systemd/wg-captive-agent.service /etc/systemd/system/wg-captive-agent.service
install -m 0644 systemd/wg-captive-admin.service /etc/systemd/system/wg-captive-admin.service
install -m 0644 systemd/wg-captive-relay-restore.service /etc/systemd/system/wg-captive-relay-restore.service

systemctl daemon-reload

echo "Installed wg-captive-agent."
echo "Edit /etc/wg-captive-agent.env, then run:"
echo "  systemctl enable --now wg-captive-agent"
echo "  systemctl enable --now wg-captive-admin"
echo "  systemctl enable wg-captive-relay-restore"


