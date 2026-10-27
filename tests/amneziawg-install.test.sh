#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export CONFIG_FILE="$tmp/absent.env" STATE_DB="$tmp/absent.db"
source <(sed '$d' "$repo/bin/wg-captive-agent")
awg() { echo 'amneziawg-tools v3.1.20260812'; }
awg-quick() { :; }
modinfo() { return 0; }
amneziawg_tools_ready
modinfo() { return 1; }
if amneziawg_tools_ready; then echo 'Missing backend accepted' >&2; exit 1; fi
amneziawg-go() { :; }
amneziawg_tools_ready
unset -f awg-quick
if amneziawg_tools_ready; then echo 'Missing quick tool accepted' >&2; exit 1; fi
awg-quick() { :; }
export -f awg awg-quick
export AWG_TEST_LOG="$tmp/actions"
uname() { if [[ "$1" == -s ]]; then echo Linux; else echo test-kernel; fi; }
systemctl() { return "${AWG_TEST_ACTIVE:-1}"; }
apt-get() { echo "apt $*" >> "$AWG_TEST_LOG"; return "${AWG_TEST_APT_EXIT:-0}"; }
add-apt-repository() { echo "ppa $*" >> "$AWG_TEST_LOG"; }
modprobe() { echo '3.1.20260812' > "$AWG_TEST_VERSION"; }
export -f uname systemctl apt-get add-apt-repository modprobe
export AWG_TEST_VERSION="$tmp/version"
printf 'ID=ubuntu\n' > "$tmp/os-release"
sed -e '/\[\[ "${EUID}" == 0 \]\]/d' -e "s|/sys/module/amneziawg/version|$tmp/version|g" -e "s|/etc/os-release|$tmp/os-release|g" "$repo/scripts/install-amneziawg.sh" > "$tmp/install"
bash "$tmp/install"
grep -q 'amneziawg-dkms amneziawg-tools' "$AWG_TEST_LOG"
if grep -q 'golang' "$AWG_TEST_LOG"; then echo 'Kernel mode installs Go' >&2; exit 1; fi
rm "$AWG_TEST_LOG"
bash "$tmp/install"
[[ ! -e "$AWG_TEST_LOG" ]]
rm "$AWG_TEST_VERSION"
if AWG_TEST_ACTIVE=0 bash "$tmp/install"; then echo 'Active tunnel upgraded' >&2; exit 1; fi
[[ ! -e "$AWG_TEST_LOG" ]]
if AWG_TEST_APT_EXIT=9 bash "$tmp/install"; then echo 'APT failure ignored' >&2; exit 1; fi
[[ ! -e "$AWG_TEST_VERSION" ]]
if bash "$tmp/install" --invalid; then echo 'Invalid mode accepted' >&2; exit 1; fi
echo 'AWG backend detection, kernel install, idempotency and failure guards passed'
