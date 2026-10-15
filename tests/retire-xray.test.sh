#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo/scripts/remove-legacy-xray.sh"
test_dir="$(mktemp -d)"
# Every destructive/system command inside the migration is mocked.
trap 'command rm -rf "$test_dir"' EXIT
export CONFIG_FILE="$test_dir/absent.env" STATE_DB="$test_dir/db"
export AGENT_BIN="$test_dir/agent" LEGACY_XRAY_UNIT="$test_dir/unit"
export MIGRATION_LOG="$test_dir/log"
touch "$STATE_DB" "$LEGACY_XRAY_UNIT"
cat > "$AGENT_BIN" <<'SH'
#!/usr/bin/env bash
echo "agent $*" >> "$MIGRATION_LOG"
[[ "${MIGRATION_FAIL:-0}" == 0 ]]
SH
chmod +x "$AGENT_BIN"
test_protocol=xray
sqlite3() {
  if [[ "$*" == *SELECT* ]]; then echo "$test_protocol";
  else printf 'database %s\n' "$*" >> "$MIGRATION_LOG"; fi
}
systemctl() { printf 'systemctl %s\n' "$*" >> "$MIGRATION_LOG"; [[ "$1" != is-active ]]; }
rm() { printf 'remove %s\n' "$*" >> "$MIGRATION_LOG"; }
retire_legacy_xray
grep -qF 'agent relay-disable' "$MIGRATION_LOG"
grep -qF "protocol='wireguard', enabled=0" "$MIGRATION_LOG"
grep -qF 'systemctl stop wg-captive-xray.service' "$MIGRATION_LOG"
if grep '^remove ' "$MIGRATION_LOG" | grep -qE 'exit.json|agent.env|state.db|openvpn|wg-easy'; then echo 'migration deletes unrelated state' >&2; exit 1; fi
printf '' > "$MIGRATION_LOG"
test_protocol=openvpn
retire_legacy_xray
if grep -qE '^agent |^database ' "$MIGRATION_LOG"; then echo 'migration touched active supported relay' >&2; exit 1; fi
printf '' > "$MIGRATION_LOG"
test_protocol=xray
export MIGRATION_FAIL=1
if retire_legacy_xray; then echo 'upgrade ignored failed route cleanup' >&2; exit 1; fi
if grep -qE '^remove |^database ' "$MIGRATION_LOG"; then echo 'failed cleanup still deleted state' >&2; exit 1; fi
echo 'Retired Xray migration: scoped cleanup, profile preservation, supported tunnel isolation and fail-fast passed'
