#!/usr/bin/env bash
set -euo pipefail

command -v node >/dev/null 2>&1 || { echo "Node.js 24 LTS is required." >&2; exit 1; }
NODE_MAJOR="$(node -p 'parseInt(process.versions.node.split(".")[0], 10)' 2>/dev/null || echo 0)"
[[ "$NODE_MAJOR" -ge 24 ]] || { echo "Node.js 24 LTS is required; current version is $(node -v)." >&2; exit 1; }
AUTO_SELECT_FAMILY="$(node -p 'require("node:net").getDefaultAutoSelectFamily() ? "true" : "false"' 2>/dev/null || echo false)"
[[ "$AUTO_SELECT_FAMILY" == "true" ]] || { echo "Node.js autoSelectFamily must be true; current value is ${AUTO_SELECT_FAMILY}." >&2; exit 1; }
node --check web/wg-captive-admin.js
node --check web/relay-config.js
node --check web/openvpn-state.js
node --check web/amnezia-config.js
node --check web/relay-probe.js
for script in bin/wg-captive-agent bin/wg-captive-redirect bin/wg-captive-openvpn bin/wg-captive-amneziawg bin/wg-captive-watchdog scripts/install-amneziawg.sh scripts/remove-legacy-xray.sh; do
  bash -n "$script"
done

# Prepare AWG before replacing agent files or stopping existing services.
case "${WG_CAPTIVE_AWG_MODE:-kernel}" in
  kernel|go) bash scripts/install-amneziawg.sh "--${WG_CAPTIVE_AWG_MODE:-kernel}" ;;
  skip) echo 'Skipping AWG dependency installation (WG_CAPTIVE_AWG_MODE=skip)' ;;
  *) echo 'WG_CAPTIVE_AWG_MODE must be kernel, go or skip' >&2; exit 1 ;;
esac

if ! command -v openvpn >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y openvpn
  else
    echo "OpenVPN 2.6+ is required for TCP relay. Install openvpn first." >&2
    exit 1
  fi
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y sqlite3
  else
    echo "sqlite3 is required. Install sqlite3 first, then run install.sh again." >&2
    exit 1
  fi
fi

if [[ ! -f /etc/wg-captive-agent.env ]]; then
  install -m 0600 examples/wg-captive-agent.env /etc/wg-captive-agent.env
fi
sed -i '/^ADMIN_PASSWORD=/d' /etc/wg-captive-agent.env
if ! grep -qE '^ADMIN_PASSWORD_HASH=' /etc/wg-captive-agent.env; then
  printf 'ADMIN_PASSWORD_HASH=\n' >> /etc/wg-captive-agent.env
fi
hash_line="$(grep -m1 '^ADMIN_PASSWORD_HASH=' /etc/wg-captive-agent.env || true)"
hash_value="${hash_line#ADMIN_PASSWORD_HASH=}"
if [[ "$hash_value" == \"scrypt\$*\" && "$hash_value" == *\" ]]; then
  hash_value="${hash_value#\"}"
  hash_value="${hash_value%\"}"
fi
if [[ "$hash_value" == scrypt\$* ]]; then
  tmp_env="$(mktemp)"
  awk -v v="$hash_value" 'BEGIN{done=0} /^ADMIN_PASSWORD_HASH=/{ if(!done){ print "ADMIN_PASSWORD_HASH='\''" v "'\''"; done=1 } next } { print }' /etc/wg-captive-agent.env > "$tmp_env"
  install -m 0600 "$tmp_env" /etc/wg-captive-agent.env
  rm -f "$tmp_env"
fi
chmod 0600 /etc/wg-captive-agent.env

# Normalize old env quoting before the previous agent sources it during cleanup.
systemctl stop wg-captive-watchdog.timer wg-captive-watchdog.service 2>/dev/null || true
bash scripts/remove-legacy-xray.sh
install -m 0755 bin/wg-captive-agent /usr/local/sbin/wg-captive-agent
install -m 0755 bin/wg-captive-redirect /usr/local/sbin/wg-captive-redirect
install -m 0755 bin/wg-captive-openvpn /usr/local/sbin/wg-captive-openvpn
install -m 0755 bin/wg-captive-amneziawg /usr/local/sbin/wg-captive-amneziawg
install -m 0755 bin/wg-captive-watchdog /usr/local/sbin/wg-captive-watchdog
install -m 0755 scripts/install-amneziawg.sh /usr/local/bin/wg-captive-install-amneziawg
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
install -m 0644 web/relay-config.js /usr/local/lib/wg-captive-agent/relay-config.js
install -m 0644 web/openvpn-state.js /usr/local/lib/wg-captive-agent/openvpn-state.js
install -m 0644 web/amnezia-config.js /usr/local/lib/wg-captive-agent/amnezia-config.js
install -m 0644 web/relay-probe.js /usr/local/lib/wg-captive-agent/relay-probe.js

if [[ ! -f /etc/wg-captive-expired.txt ]]; then
  install -m 0644 examples/wg-captive-expired.txt /etc/wg-captive-expired.txt
fi

install -m 0644 systemd/wg-captive-agent.service /etc/systemd/system/wg-captive-agent.service
install -m 0644 systemd/wg-captive-admin.service /etc/systemd/system/wg-captive-admin.service
install -m 0644 systemd/wg-captive-redirect.service /etc/systemd/system/wg-captive-redirect.service
install -m 0644 systemd/wg-captive-relay-restore.service /etc/systemd/system/wg-captive-relay-restore.service
install -m 0644 systemd/wg-captive-openvpn.service /etc/systemd/system/wg-captive-openvpn.service
install -m 0644 systemd/wg-captive-amneziawg.service /etc/systemd/system/wg-captive-amneziawg.service
install -m 0644 systemd/wg-captive-watchdog.service /etc/systemd/system/wg-captive-watchdog.service
install -m 0644 systemd/wg-captive-watchdog.timer /etc/systemd/system/wg-captive-watchdog.timer

systemctl daemon-reload
/usr/local/sbin/wg-captive-agent relay-watchdog-adopt || true
systemctl enable --now wg-captive-watchdog.timer

if systemctl is-active --quiet wg-captive-admin.service; then
  systemctl enable --now wg-captive-redirect.service
fi

echo "Installed wg-captive-agent."
echo "Edit /etc/wg-captive-agent.env, then run:"
echo "  systemctl enable --now wg-captive-agent"
echo "  systemctl enable --now wg-captive-admin"
echo "  systemctl enable --now wg-captive-redirect"
echo "  systemctl enable wg-captive-relay-restore"
