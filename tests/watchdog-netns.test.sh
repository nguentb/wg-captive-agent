#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
export CONFIG_FILE="$test_dir/absent.env" STATE_DB="$test_dir/absent.db"
export AGENT_BIN="$repo/bin/wg-captive-agent" WATCHDOG_LIBRARY=1
export RELAY_WATCHDOG_DIR="$test_dir"
source "$repo/bin/wg-captive-watchdog"
RELAY_EXIT_IF=awg-exit
log="$test_dir/commands"
foreign=0
tcp_ok=1
net_exec() {
  printf '%s\n' "$*" >> "$log"
  case "$*" in
    'ip -o -4 addr show dev awg-exit') echo '9: awg-exit inet 10.42.0.2/32 scope global awg-exit' ;;
    'ip -4 route show table 201') [[ "$foreign" == 0 ]] || echo 'default via 10.0.0.1 dev eth0' ;;
    'timeout 3 ping '*) return 1 ;;
    'timeout 3 node '*) [[ "$tcp_ok" == 1 ]] ;;
  esac
  return 0
}
watchdog_probe
grep -qF 'ip -4 route add prohibit default table 201' "$log"
grep -qF 'ip -4 route add 1.1.1.1/32 dev awg-exit src 10.42.0.2 table 201' "$log"
grep -qF 'ip -4 rule add priority 1999 from 10.42.0.2/32 lookup 201' "$log"
grep -qF 'timeout 3 ping -4 -n -I 10.42.0.2 -c 1 -W 2 1.1.1.1' "$log"
grep -qF '1.1.1.1 10.42.0.2' "$log"
grep -qF 'ip -4 rule del priority 1999 from 10.42.0.2/32 lookup 201' "$log"
grep -qF 'ip -4 route flush table 201' "$log"
before="$(wc -l < "$log")"
# No ownership marker means a genuinely foreign table, not interrupted probe cleanup.
rm -f "$PROBE_OWNER"
foreign=1
if watchdog_probe; then echo 'foreign probe table accepted' >&2; exit 1; else [[ "$?" == 2 ]]; fi
tail -n +"$((before + 1))" "$log" > "$test_dir/foreign"
if grep -Eq 'route (add|flush)|rule (add|del)|timeout' "$test_dir/foreign"; then echo 'foreign routing modified or unbound probe attempted' >&2; exit 1; fi
foreign=0
printf '10.42.0.2 host\n' > "$PROBE_OWNER"
watchdog_probe
grep -qF 'ip -4 route flush table 201 proto 186' "$log"
echo 'Watchdog probes: source-bound ICMP/TCP, tunnel-only routes, cleanup and foreign-table protection passed'
