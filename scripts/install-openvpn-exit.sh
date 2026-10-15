#!/usr/bin/env bash
set -euo pipefail

BASE=/etc/openvpn/captive-tcp
SETTINGS="$BASE/installer.env"
SERVER_CONF=/etc/openvpn/server/captive-tcp.conf
ENDPOINT=""
PORT=8443
CLIENT=relay-node
SUBNET=10.250.240.0/24
TMP_DIR=""

log() { printf '[OpenVPN exit] %s\n' "$*"; }
fail() { printf '[OpenVPN exit] ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  echo 'Usage: sudo bash install-openvpn-exit.sh --endpoint EXIT_PUBLIC_IP [--port 8443] [--client relay-node]'
}
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --endpoint|--port|--client)
        [[ $# -ge 2 && -n "$2" ]] || fail "missing value for $1"
        case "$1" in
          --endpoint) ENDPOINT="$2" ;;
          --port) PORT="$2" ;;
          --client) CLIENT="$2" ;;
        esac
        shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) fail "unknown option: $1" ;;
    esac
  done
  [[ "$ENDPOINT" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || fail '--endpoint must be an IPv4 address or hostname, without https:// or port'
  [[ "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] && (( PORT <= 65535 )) || fail 'invalid TCP port'
  [[ "$CLIENT" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$ ]] || fail 'invalid client name'
  [[ "$CLIENT" != relay-exit ]] || fail 'client name relay-exit is reserved for the server certificate'
}
cleanup() { [[ -z "$TMP_DIR" ]] || rm -rf -- "$TMP_DIR"; }

check_networks() {
  ip -j -4 route show table all > "$TMP_DIR/host.json"
  local pid=""
  if command -v docker >/dev/null 2>&1; then
    pid="$(docker inspect -f '{{.State.Pid}}' wg-easy 2>/dev/null || true)"
  fi
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
    nsenter -t "$pid" -n ip -j -4 route show table all > "$TMP_DIR/wg-easy.json"
  fi
  python3 - "$TMP_DIR" "$SUBNET" <<'PY'
import ipaddress
import json
import pathlib
import sys
target = ipaddress.ip_network(sys.argv[2])
for file in pathlib.Path(sys.argv[1]).glob('*.json'):
    for route in json.loads(file.read_text()):
        prefix = route.get('dst', 'default')
        if prefix in ('default', '0.0.0.0/0') or route.get('dev') == 'tun-captive':
            continue
        if target.overlaps(ipaddress.ip_network(prefix, strict=False)):
            sys.exit(f'ERROR: tunnel subnet {target} overlaps {prefix} in {file.name}; installation stopped')
PY
}

write_firewall() {
  install -d -m 0755 /usr/local/sbin
  cat > /usr/local/sbin/wg-captive-exit-firewall <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source /etc/openvpn/captive-tcp/installer.env
IPT=(iptables -w 10)
if [[ "${1:-start}" == stop ]]; then
  for spec in 'filter INPUT WG_TCP_EXIT_IN' 'filter FORWARD WG_TCP_EXIT_FWD' 'nat POSTROUTING WG_TCP_EXIT_NAT'; do
    read -r table parent chain <<< "$spec"
    while "${IPT[@]}" -t "$table" -D "$parent" -j "$chain" 2>/dev/null; do :; done
    "${IPT[@]}" -t "$table" -F "$chain" 2>/dev/null || true
    "${IPT[@]}" -t "$table" -X "$chain" 2>/dev/null || true
  done
  exit 0
fi
uplink="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1);exit}}')"
[[ "$uplink" =~ ^[A-Za-z0-9_.:-]+$ ]] || { echo 'Cannot find exit uplink' >&2; exit 1; }
sysctl -w net.ipv4.ip_forward=1 >/dev/null
for spec in 'filter INPUT WG_TCP_EXIT_IN' 'filter FORWARD WG_TCP_EXIT_FWD' 'nat POSTROUTING WG_TCP_EXIT_NAT'; do
  read -r table parent chain <<< "$spec"
  "${IPT[@]}" -t "$table" -N "$chain" 2>/dev/null || true
  "${IPT[@]}" -t "$table" -F "$chain"
done
"${IPT[@]}" -A WG_TCP_EXIT_IN -p tcp --dport "$PORT" -j ACCEPT
"${IPT[@]}" -A WG_TCP_EXIT_FWD -i tun-captive -o "$uplink" -s "$SUBNET" -j ACCEPT
"${IPT[@]}" -A WG_TCP_EXIT_FWD -i "$uplink" -o tun-captive -d "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
"${IPT[@]}" -t nat -A WG_TCP_EXIT_NAT -s "$SUBNET" -o "$uplink" -j MASQUERADE
for spec in 'filter INPUT WG_TCP_EXIT_IN' 'filter FORWARD WG_TCP_EXIT_FWD' 'nat POSTROUTING WG_TCP_EXIT_NAT'; do
  read -r table parent chain <<< "$spec"
  "${IPT[@]}" -t "$table" -C "$parent" -j "$chain" 2>/dev/null || "${IPT[@]}" -t "$table" -I "$parent" 1 -j "$chain"
done
SH
  chmod 0755 /usr/local/sbin/wg-captive-exit-firewall
  cat > /etc/systemd/system/wg-captive-exit-firewall.service <<'UNIT'
[Unit]
Description=Firewall for captive OpenVPN TCP exit
After=network-online.target docker.service ufw.service
Wants=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/wg-captive-exit-firewall start
ExecStop=/usr/local/sbin/wg-captive-exit-firewall stop
[Install]
WantedBy=multi-user.target
UNIT
  install -d -m 0755 /etc/systemd/system/openvpn-server@captive-tcp.service.d
  cat > /etc/systemd/system/openvpn-server@captive-tcp.service.d/firewall.conf <<'UNIT'
[Unit]
Requires=wg-captive-exit-firewall.service
After=wg-captive-exit-firewall.service
UNIT
  printf 'net.ipv4.ip_forward=1\n' > /etc/sysctl.d/99-captive-tcp-exit.conf
}

main() {
  [[ "${EUID:-$(id -u)}" == 0 ]] || fail 'run as root with sudo bash'
  local old_port="" managed=0
  if [[ -f "$SETTINGS" ]]; then
    source "$SETTINGS"
    old_port="$PORT"
    managed=1
  fi
  parse_args "$@"
  [[ "$managed" == 0 || "$old_port" == "$PORT" ]] || fail 'use the existing port when rerunning this installer'
  if [[ "$managed" == 0 && ( -e "$SERVER_CONF" || -e "$BASE/pki" ) ]]; then
    fail 'existing OpenVPN configuration found; refusing to overwrite it'
  fi
  command -v apt-get >/dev/null 2>&1 || fail 'this installer requires Ubuntu/Debian with apt-get'
  command -v systemctl >/dev/null 2>&1 || fail 'systemd is required'
  if [[ "$managed" == 0 ]] && [[ -n "$(ss -H -lnt "sport = :$PORT")" ]]; then
    fail "TCP port $PORT is in use; choose --port with a free port"
  fi
  log 'Installing OpenVPN, Easy-RSA and dependencies'
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y openvpn easy-rsa iptables iproute2 util-linux python3
  local version
  version="$(openvpn --version | awk 'NR==1 {print $2}')"
  dpkg --compare-versions "$version" ge 2.6 || fail 'OpenVPN 2.6+ required; use Ubuntu 24.04 or newer'
  TMP_DIR="$(mktemp -d)"
  trap cleanup EXIT
  check_networks
  modprobe tun 2>/dev/null || true
  [[ -c /dev/net/tun ]] || fail '/dev/net/tun is unavailable on this VPS'
  getent ahostsv4 "$ENDPOINT" >/dev/null || fail 'endpoint has no resolvable IPv4 address'
  umask 077
  install -d -m 0700 "$BASE"
  if [[ "$managed" == 0 ]]; then
    cp -a /usr/share/easy-rsa/. "$BASE/"
    cd "$BASE"
    ./easyrsa init-pki
    EASYRSA_REQ_CN=captive-tcp-ca ./easyrsa --batch build-ca nopass
    ./easyrsa --batch build-server-full relay-exit nopass
    openvpn --genkey secret "$BASE/tls-crypt.key"
  fi
  cd "$BASE"
  [[ -s pki/ca.crt && -s pki/issued/relay-exit.crt && -s pki/private/relay-exit.key && -s tls-crypt.key ]] || fail 'server PKI incomplete; existing keys were left in place'
  if [[ ! -e "pki/issued/$CLIENT.crt" && ! -e "pki/private/$CLIENT.key" ]]; then
    ./easyrsa --batch build-client-full "$CLIENT" nopass
  fi
  [[ -s "pki/issued/$CLIENT.crt" && -s "pki/private/$CLIENT.key" ]] || fail 'client certificate/key incomplete'
  printf 'ENDPOINT=%s\nPORT=%s\nCLIENT=%s\nSUBNET=%s\n' "$ENDPOINT" "$PORT" "$CLIENT" "$SUBNET" > "$SETTINGS"
  install -d -m 0755 /etc/openvpn/server
  cat > "$SERVER_CONF" <<CONF
port $PORT
proto tcp4-server
dev tun-captive
dev-type tun
topology subnet
server 10.250.240.0 255.255.255.0
ca $BASE/pki/ca.crt
cert $BASE/pki/issued/relay-exit.crt
key $BASE/pki/private/relay-exit.key
dh none
tls-crypt $BASE/tls-crypt.key
tls-version-min 1.2
data-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305
keepalive 10 60
persist-key
persist-tun
allow-compression no
disable-dco
verb 3
CONF
  local output="/root/$CLIENT.ovpn"
  {
    printf 'client\ndev tun\nproto tcp4-client\nremote %s %s\nnobind\npersist-key\npersist-tun\nremote-cert-tls server\nverify-x509-name relay-exit name\nallow-compression no\nverb 3\n' "$ENDPOINT" "$PORT"
    printf '<ca>\n'; cat pki/ca.crt
    printf '</ca>\n<cert>\n'; sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' "pki/issued/$CLIENT.crt"
    printf '</cert>\n<key>\n'; cat "pki/private/$CLIENT.key"
    printf '</key>\n<tls-crypt>\n'; cat tls-crypt.key
    printf '</tls-crypt>\n'
  } > "$output"
  chmod 0600 "$output" "$SERVER_CONF" "$SETTINGS"
  write_firewall
  systemctl daemon-reload
  systemctl enable wg-captive-exit-firewall.service openvpn-server@captive-tcp.service
  systemctl restart wg-captive-exit-firewall.service
  if ! systemctl restart openvpn-server@captive-tcp.service; then
    journalctl -u openvpn-server@captive-tcp -n 30 --no-pager >&2
    fail 'OpenVPN failed to start; inspect the journal above'
  fi
  sleep 1
  systemctl is-active --quiet openvpn-server@captive-tcp || fail 'OpenVPN stopped; check journalctl -u openvpn-server@captive-tcp'
  [[ -n "$(ss -H -lnt "sport = :$PORT")" ]] || fail "OpenVPN is not listening on TCP $PORT"
  log "Ready: $ENDPOINT:$PORT TCP"
  log "Client config: $output"
  log "Allow TCP $PORT in the VPS provider firewall, then import this .ovpn in Relay > OpenVPN TCP."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
