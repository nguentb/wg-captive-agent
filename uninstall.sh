#!/usr/bin/env bash
set -euo pipefail

if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now wg-captive-agent >/dev/null 2>&1 || true
  systemctl disable --now wg-captive-admin >/dev/null 2>&1 || true
fi

if [[ -x /usr/local/sbin/wg-captive-agent ]]; then
  /usr/local/sbin/wg-captive-agent cleanup || true
fi

rm -f /etc/systemd/system/wg-captive-agent.service
rm -f /etc/systemd/system/wg-captive-admin.service
rm -f /usr/local/sbin/wg-captive-agent
rm -rf /usr/local/lib/wg-captive-agent

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
fi

echo "Uninstalled wg-captive-agent. Config files in /etc were kept."
