#!/usr/bin/env bash
set -euo pipefail
[[ "${EUID}" == 0 ]] || { echo 'Run as root' >&2; exit 1; }
[[ "$(uname -s)" == Linux ]] || { echo 'Linux is required' >&2; exit 1; }
TOOLS_REF=ee0f0a9aa34ff0a0da4b3433b9512781cfe02843
GO_REF=b5928efb6ca19f0153958460c3d141f04abc5c2e
DEST=/usr/local/lib/wg-captive-agent/amneziawg
if [[ -x "$DEST/bin/awg" && -x "$DEST/bin/awg-quick" && -x "$DEST/bin/amneziawg-go" && -f "$DEST/version" ]] && [[ "$(cat "$DEST/version")" == "$TOOLS_REF $GO_REF" ]]; then
  echo 'Agent AmneziaWG tools already installed'
  exit 0
fi
if systemctl is-active --quiet wg-captive-amneziawg.service; then
  echo 'Stop the AmneziaWG tunnel before installing/upgrading its tools' >&2
  exit 1
fi
command -v apt-get >/dev/null || { echo 'Install Go 1.25+, git and a C compiler, then build the official AmneziaWG tools manually' >&2; exit 1; }
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y git ca-certificates build-essential golang-go iproute2 util-linux
# Go 1.21+ downloads the version required by the pinned upstream go.mod.
go_version="$(go env GOVERSION)"
if ! printf '%s\n' "$go_version" | grep -Eq '^go1\.(2[1-9]|[3-9][0-9])\.'; then
  echo 'Go 1.21+ bootstrap required (upstream builds with Go 1.25+). Install current Go from https://go.dev/doc/install' >&2
  exit 1
fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fetch_source() {
  local repo="$1" ref="$2" dir="$3"
  git init -q "$dir"
  git -C "$dir" fetch --depth 1 "https://github.com/amnezia-vpn/$repo.git" "$ref"
  git -C "$dir" checkout -q --detach FETCH_HEAD
  [[ "$(git -C "$dir" rev-parse HEAD)" == "$ref" ]]
}
fetch_source amneziawg-tools "$TOOLS_REF" "$work/tools"
fetch_source amneziawg-go "$GO_REF" "$work/go"
make -C "$work/tools/src" -j2
(cd "$work/go" && GOTOOLCHAIN=auto go build -trimpath -o "$work/amneziawg-go" .)
install -d -m 0755 "$DEST/bin"
install -m 0755 "$work/tools/src/wg" "$DEST/bin/awg"
install -m 0755 "$work/tools/src/wg-quick/linux.bash" "$DEST/bin/awg-quick"
install -m 0755 "$work/amneziawg-go" "$DEST/bin/amneziawg-go"
printf '%s %s\n' "$TOOLS_REF" "$GO_REF" > "$DEST/version"
echo 'Installed agent-private AmneziaWG tools; no kernel modules or wg-easy changes'
