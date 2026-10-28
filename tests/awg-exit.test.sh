#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo/scripts/install-awg-exit.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
BASE="$tmp/exit"
install() { mkdir -p "${@: -1}"; }
(parse_args --endpoint 138.124.55.192 --port 51830 --web-port 51822; [[ "$PORT" == 51830 && "$WEB_PORT" == 51822 ]])
for args in '--endpoint' '--endpoint https://example.com' '--endpoint x;touch' '--endpoint host --port 08' '--endpoint host --web-port 65536' '--endpoint host --unknown'; do
  if (parse_args $args) >/dev/null 2>&1; then echo "Invalid arguments accepted: $args" >&2; exit 1; fi
done
parse_args --endpoint 138.124.55.192
write_compose
grep -q 'ghcr.io/wg-easy/wg-easy:15.5.0' "$BASE/compose.yml"
grep -q 'OVERRIDE_AUTO_AWG: "awg"' "$BASE/compose.yml"
grep -q '127.0.0.1:51821:51821/tcp' "$BASE/compose.yml"
grep -q '/lib/modules:/lib/modules:ro' "$BASE/compose.yml"
grep -q '51820:51820/udp' "$BASE/compose.yml"
grep -q 'enable_ipv6: true' "$BASE/compose.yml"
echo '# preserved client data/settings' >> "$BASE/compose.yml"
write_compose
grep -q 'preserved client' "$BASE/compose.yml"
ss() { :; }
docker() { return 1; }
check_existing
if (WEB_PORT=51822; check_existing) >/dev/null 2>&1; then echo 'Changed web port accepted' >&2; exit 1; fi
cp "$BASE/compose.yml" "$tmp/saved"
echo 'unmanaged' > "$BASE/compose.yml"
if (check_existing) >/dev/null 2>&1; then echo 'Unmanaged compose accepted' >&2; exit 1; fi
cp "$tmp/saved" "$BASE/compose.yml"
docker() { return 0; }
if (check_existing) >/dev/null 2>&1; then echo 'Existing wg-easy accepted' >&2; exit 1; fi
docker() { return 1; }
ss() { echo 'port in use'; }
if (check_existing) >/dev/null 2>&1; then echo 'Occupied port accepted' >&2; exit 1; fi
export AWG_EXIT_TEST_LOG="$tmp/actions"
fuser() { return 1; }
apt-get() { printf '%s\n' "$*" >> "$AWG_EXIT_TEST_LOG"; return "${TEST_APT_STATUS:-0}"; }
apt_run install -y example
grep -q 'DPkg::Lock::Timeout=600 install -y example' "$AWG_EXIT_TEST_LOG"
if (TEST_APT_STATUS=7; apt_run install -y example); then echo 'APT error ignored' >&2; exit 1; fi
fuser() { return 0; }
sleep() { :; }
if (APT_WAIT=5; wait_apt) >/dev/null 2>&1; then echo 'APT wait did not time out' >&2; exit 1; fi
kernel_ready() { return 0; }
install_kernel
docker() { printf 'docker %s\n' "$*" >> "$AWG_EXIT_TEST_LOG"; }
curl() { return 0; }
start_panel
grep -q 'config --quiet' "$AWG_EXIT_TEST_LOG"
grep -q 'up -d' "$AWG_EXIT_TEST_LOG"
if grep -q 'down\|volume rm' "$AWG_EXIT_TEST_LOG"; then echo 'Destructive Docker action' >&2; exit 1; fi
curl() { return 1; }
if (start_panel) >/dev/null 2>&1; then echo 'Failed readiness accepted' >&2; exit 1; fi
echo 'AWG exit: arguments, safe compose, preservation, port guards, APT wait/failure and readiness passed'
