#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo/scripts/remove-legacy-openvpn.sh"
test_dir="$(mktemp -d)"
trap 'command rm -rf "$test_dir"' EXIT
export CONFIG_FILE="$test_dir/absent.env" STATE_DB="$test_dir/db"
export AGENT_BIN="$test_dir/agent" LEGACY_OPENVPN_UNIT="$test_dir/unit"
export MIGRATION_LOG="$test_dir/log"
touch "$STATE_DB" "$LEGACY_OPENVPN_UNIT"
cat > "$AGENT_BIN" <<'SH'
#!/usr/bin/env bash
echo "agent $*" >> "$MIGRATION_LOG"
[[ "${MIGRATION_FAIL:-0}" == 0 ]]
SH
chmod +x "$AGENT_BIN"
test_protocol=openvpn
sqlite3() {
  if [[ "$*" == *SELECT* ]]; then echo "$test_protocol";
  else printf 'database %s\n' "$*" >> "$MIGRATION_LOG"; fi
}
systemctl() { printf 'systemctl %s\n' "$*" >> "$MIGRATION_LOG"; [[ "$1" != is-active ]]; }
rm() { printf 'remove %s\n' "$*" >> "$MIGRATION_LOG"; }
retire_legacy_openvpn
[[ "$(head -n 1 "$MIGRATION_LOG")" == 'agent relay-disable' ]]
grep -qF 'systemctl stop wg-captive-openvpn.service' "$MIGRATION_LOG"
grep -qF "protocol='wireguard', enabled=0" "$MIGRATION_LOG"
if grep -qE '\.ovpn|openvpn-server|apt-get|DELETE FROM' "$MIGRATION_LOG"; then
  echo 'migration touched a profile, package or standalone exit' >&2; exit 1
fi
: > "$MIGRATION_LOG"
test_protocol=amneziawg
retire_legacy_openvpn
if grep -qE '^agent |^database ' "$MIGRATION_LOG"; then echo 'migration touched active AWG' >&2; exit 1; fi
: > "$MIGRATION_LOG"
test_protocol=openvpn
export MIGRATION_FAIL=1
if retire_legacy_openvpn; then echo 'upgrade ignored failed route cleanup' >&2; exit 1; fi
if grep -qE '^remove |^database ' "$MIGRATION_LOG"; then echo 'failed cleanup modified state' >&2; exit 1; fi
echo 'Retired OpenVPN migration: scoped teardown, profile preservation and failed cleanup handling passed'
