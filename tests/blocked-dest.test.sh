#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export CONFIG_FILE="$tmp/absent.env" STATE_DB="$tmp/absent.db"
source <(sed '$d' "$repo/bin/wg-captive-agent")
declare -A rules=()
mark_chain=1
ipt() {
  local table="$2" action="$3"
  shift 3
  local key="$table $*"
  case "$action" in
    -nL) [[ "$mark_chain" == 1 ]];;
    -C) (( ${rules[$key]:-0} > 0 ));;
    -I) rules[$key]=$((${rules[$key]:-0}+1));;
    -D) rules[$key]=$((${rules[$key]:-0}-1));;
    *) return 1;;
  esac
}
ips() {
  printf '%s\n' "$*" >> "$tmp/ipset"
  [[ "$1" != add || "$3" != 999.1.1.1 ]]
}
relay_exec() { printf '%s\n' "$1" > "$tmp/route"; }
forward="filter FORWARD -i $WG_INTERFACE -m set --match-set $BLOCKED_DEST_IPSET_NAME dst -j REJECT"
mark="mangle $RELAY_MARK_CHAIN -m set --match-set $BLOCKED_DEST_IPSET_NAME dst -j RETURN"
legacy="filter FORWARD -m set --match-set $BLOCKED_DEST_IPSET_NAME dst -j REJECT"

# Disabling removes duplicates and legacy rules, without touching the saved list.
rules[$forward]=2
rules[$mark]=2
rules[$legacy]=1
BLOCKED_DEST_IPS='203.0.113.1,198.51.100.0/24'
BLOCKED_DEST_ENABLED=0
sync_blocked_dest_ipset
[[ "${rules[$forward]}:${rules[$mark]}:${rules[$legacy]}" == 0:0:0 ]]
[[ "$BLOCKED_DEST_IPS" == '203.0.113.1,198.51.100.0/24' && ! -e "$tmp/ipset" ]]
relay_ensure_route_mark
! grep -Fq "$BLOCKED_DEST_IPSET_NAME" "$tmp/route"

BLOCKED_DEST_ENABLED=1
sync_blocked_dest_ipset
sync_blocked_dest_ipset
[[ "${rules[$forward]}:${rules[$mark]}" == 1:1 ]]
relay_ensure_route_mark
grep -Fq "$BLOCKED_DEST_IPSET_NAME" "$tmp/route"

BLOCKED_DEST_IPS='# empty'
sync_blocked_dest_ipset
[[ "${rules[$forward]}:${rules[$mark]}:$BLOCKED_DEST_ACTIVE" == 0:0:0 ]]
BLOCKED_DEST_IPS='not-an-ip,999.1.1.1'
sync_blocked_dest_ipset 2>/dev/null
[[ "${rules[$forward]}:${rules[$mark]}:$BLOCKED_DEST_ACTIVE" == 0:0:0 ]]
! grep -Fq 'not-an-ip' "$tmp/ipset"

mark_chain=0
BLOCKED_DEST_IPS=203.0.113.1
sync_blocked_dest_ipset
[[ "${rules[$forward]}:${rules[$mark]}:$BLOCKED_DEST_ACTIVE" == 1:0:1 ]]
relay_ensure_route_mark
grep -Fq "$BLOCKED_DEST_IPSET_NAME" "$tmp/route"
echo 'Destination blocking: toggle, empty/invalid lists, live rule cleanup and relay reapply passed'
