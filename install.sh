#!/usr/bin/env bash
set -euo pipefail

install -m 0755 bin/wg-captive-agent /usr/local/sbin/wg-captive-agent
install -d -m 0755 /usr/local/lib/wg-captive-agent
install -d -m 0755 /var/backups/wg-captive
install -m 0755 web/wg-captive-admin.js /usr/local/lib/wg-captive-agent/wg-captive-admin.js

if [[ ! -f /etc/wg-captive-agent.env ]]; then
  install -m 0644 examples/wg-captive-agent.env /etc/wg-captive-agent.env
fi

if [[ ! -f /etc/wg-captive-expired.txt ]]; then
  install -m 0644 examples/wg-captive-expired.txt /etc/wg-captive-expired.txt
fi

install -m 0644 systemd/wg-captive-agent.service /etc/systemd/system/wg-captive-agent.service
install -m 0644 systemd/wg-captive-admin.service /etc/systemd/system/wg-captive-admin.service

systemctl daemon-reload

echo "Installed wg-captive-agent."
echo "Edit /etc/wg-captive-agent.env, then run:"
echo "  systemctl enable --now wg-captive-agent"
echo "  systemctl enable --now wg-captive-admin"


