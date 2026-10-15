#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo/scripts/install-openvpn-exit.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

(parse_args --endpoint 203.0.113.10 --port 9443 --client relay-2; [[ "$PORT" == 9443 && "$CLIENT" == relay-2 ]])
for args in '--endpoint https://exit.example.com' '--endpoint 203.0.113.10 --port 65536' '--endpoint 203.0.113.10 --port 08' '--endpoint 203.0.113.10 --client ../bad' '--endpoint 203.0.113.10 --client relay-exit' '--endpoint'; do
  if (parse_args $args) >/dev/null 2>&1; then echo "invalid arguments accepted: $args" >&2; exit 1; fi
done

# Execute only the generated firewall helper, with every system command mocked.
awk '/^#!\/usr\/bin\/env bash$/ && capture {print;next} /<<'"'"'SH'"'"'/ {capture=1;next} /^SH$/ {capture=0} capture {print}' "$repo/scripts/install-openvpn-exit.sh" > "$test_dir/firewall.sh"
sed -i 's|^source /etc/openvpn/captive-tcp/installer.env|PORT=8443; SUBNET=10.250.240.0/24|' "$test_dir/firewall.sh"
export EXIT_TEST_LOG="$test_dir/iptables.log"
export EXIT_TEST_STATE="$test_dir"
iptables() {
  printf '%s\n' "$*" >> "$EXIT_TEST_LOG"
  local index=1 args=("$@")
  for ((index=0;index<${#args[@]};index++)); do
    if [[ "${args[$index]}" == -D ]]; then return 1; fi
    if [[ "${args[$index]}" == -C ]]; then
      [[ -f "$EXIT_TEST_STATE/${args[$((index+1))]}" ]]; return
    fi
    if [[ "${args[$index]}" == -I ]]; then touch "$EXIT_TEST_STATE/${args[$((index+1))]}"; fi
  done
}
ip() { printf '1.1.1.1 via 10.0.0.1 dev ens3 src 203.0.113.10\n'; }
sysctl() { :; }
export -f iptables ip sysctl
bash -n "$test_dir/firewall.sh"
bash "$test_dir/firewall.sh" start
bash "$test_dir/firewall.sh" start
[[ "$(grep -c -- '-I FORWARD' "$EXIT_TEST_LOG")" == 1 ]]
grep -q -- '-i tun-captive -o ens3 -s 10.250.240.0/24' "$EXIT_TEST_LOG"
grep -q -- '-d 10.250.240.0/24 -m conntrack --ctstate ESTABLISHED,RELATED' "$EXIT_TEST_LOG"
grep -q -- '-t nat -A WG_TCP_EXIT_NAT -s 10.250.240.0/24 -o ens3 -j MASQUERADE' "$EXIT_TEST_LOG"
if grep -E -- '-F (INPUT|FORWARD|POSTROUTING)|-X (INPUT|FORWARD)|DOCKER|wg0|wg-exit' "$EXIT_TEST_LOG"; then exit 1; fi
bash "$test_dir/firewall.sh" stop
echo 'Exit installer: argument validation, firewall scope, idempotent jumps and cleanup passed'
