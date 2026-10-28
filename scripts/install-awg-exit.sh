#!/usr/bin/env bash
# Standalone exit installer: no checkout or relay agent installation required.
set -euo pipefail

BASE=/opt/wg-captive-awg-exit
CONTAINER=wg-captive-awg-exit
IMAGE=ghcr.io/wg-easy/wg-easy:15.5.0
ENDPOINT=""
PORT=51820
WEB_PORT=51821
APT_WAIT=600
log() { printf '[AWG exit] %s\n' "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }
usage() {
  echo 'Usage: sudo bash install-awg-exit.sh --endpoint EXIT_IP_OR_HOST [--port 51820] [--web-port 51821]'
  echo 'Ubuntu 24.04; AWG kernel 3.1 + wg-easy 15.5.0. Web binds to localhost only.'
}
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --endpoint|--port|--web-port)
        [[ $# -ge 2 && -n "$2" ]] || fail "missing value for $1"
        case "$1" in
          --endpoint) ENDPOINT="$2" ;;
          --port) PORT="$2" ;;
          --web-port) WEB_PORT="$2" ;;
        esac
        shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) fail "unknown option: $1" ;;
    esac
  done
  [[ "$ENDPOINT" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || fail 'endpoint must be an IPv4 address or hostname without scheme/port'
  local value
  for value in "$PORT" "$WEB_PORT"; do
    [[ "$value" =~ ^[1-9][0-9]{0,4}$ ]] && (( value <= 65535 )) || fail 'invalid port'
  done
}
apt_locked() {
  if command -v fuser >/dev/null; then
    fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock >/dev/null 2>&1
  else
    lslocks -n -o PATH | grep -Eq '^ */var/(lib/dpkg/lock(-frontend)?|lib/apt/lists/lock|cache/apt/archives/lock)$'
  fi
}
wait_apt() {
  local elapsed=0
  while apt_locked; do
    (( elapsed < APT_WAIT )) || fail 'APT lock timeout; let the other package manager finish and rerun'
    log "Waiting for APT lock ($elapsed/$APT_WAIT seconds); not interrupting updates"
    sleep 5
    elapsed=$((elapsed + 5))
  done
}
apt_run() {
  wait_apt
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get -o "DPkg::Lock::Timeout=$APT_WAIT" "$@"
}
kernel_ready() {
  [[ -r /sys/module/amneziawg/version ]] && grep -q '^3\.1' /sys/module/amneziawg/version &&
    command -v awg-quick >/dev/null && awg --version 2>&1 | grep -q 'v3\.1'
}
install_kernel() {
  if kernel_ready; then log 'AWG kernel and tools 3.1 already ready'; return; fi
  log "[2/5] Installing compiler, DKMS and headers for $(uname -r); this may take several minutes"
  apt_run update
  apt_run install -y software-properties-common python3-launchpadlib gnupg2 build-essential dkms "linux-headers-$(uname -r)"
  log 'Adding official Amnezia PPA (without a second implicit apt update)'
  wait_apt
  add-apt-repository -y --no-update ppa:amnezia/ppa
  apt_run update
  log 'Installing AWG module; DKMS builds against installed kernels. Do not reboot during this step.'
  apt_run install -y amneziawg-dkms amneziawg-tools
  modprobe amneziawg || fail 'Cannot load AWG: check dkms status, kernel headers and Secure Boot'
  kernel_ready || fail 'AWG 3.1 module/tools not ready; an older loaded module may require a scheduled reboot'
}
install_docker() {
  log '[3/5] Checking Docker and Compose'
  if ! command -v docker >/dev/null; then
    local package
    for package in docker.io podman-docker containerd runc; do
      if [[ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" == 'install ok installed' ]]; then
        fail "Existing $package detected; configure Docker manually (no automatic removal)"
      fi
    done
    apt_run install -y ca-certificates curl
    install -d -m 0755 /etc/apt/keyrings
    curl --connect-timeout 15 --max-time 120 -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    [[ ! -e /etc/apt/sources.list.d/docker.list ]] || fail 'Existing docker.list detected; configure Docker manually to avoid duplicate sources'
    if [[ ! -e /etc/apt/sources.list.d/docker.sources ]]; then
      cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    fi
    apt_run update
    apt_run install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  docker compose version >/dev/null || fail 'Docker exists but Compose plugin is missing; install a compatible Compose plugin and rerun'
  systemctl enable --now docker
  docker info >/dev/null || fail 'Docker daemon unavailable'
}
check_existing() {
  if [[ -e "$BASE/compose.yml" ]]; then
    grep -qx '# Managed by wg-captive install-awg-exit v1' "$BASE/compose.yml" || fail "Refusing to overwrite $BASE/compose.yml"
    grep -qF "\"$PORT:$PORT/udp\"" "$BASE/compose.yml" || fail 'Existing UDP mapping differs; edit the managed compose manually'
    grep -qF "\"127.0.0.1:$WEB_PORT:51821/tcp\"" "$BASE/compose.yml" || fail 'Existing web mapping differs; edit the managed compose manually'
  fi
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    if docker container inspect wg-easy >/dev/null 2>&1; then
      fail 'Existing wg-easy detected; this fresh-exit installer will not replace it'
    fi
    if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
      [[ -f "$BASE/compose.yml" ]] || fail 'Container name already in use without managed compose'
      [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER")" == wg-captive-awg-exit ]] || fail 'Container belongs to another project'
      return
    fi
  fi
  [[ -z "$(ss -H -lun "sport = :$PORT")" ]] || fail "UDP $PORT already in use"
  [[ -z "$(ss -H -lnt "sport = :$WEB_PORT")" ]] || fail "TCP $WEB_PORT already in use"
}
write_compose() {
  [[ ! -e "$BASE/compose.yml" ]] || return 0
  install -d -m 0700 "$BASE"
  umask 077
  cat > "$BASE/compose.yml" <<EOF
# Managed by wg-captive install-awg-exit v1
name: wg-captive-awg-exit
services:
  wg-easy:
    image: $IMAGE
    container_name: $CONTAINER
    environment:
      EXPERIMENTAL_AWG: "true"
      OVERRIDE_AUTO_AWG: "awg"
      INSECURE: "true"
    volumes:
      - etc_wireguard:/etc/wireguard
      - /lib/modules:/lib/modules:ro
    ports:
      - "$PORT:$PORT/udp"
      - "127.0.0.1:$WEB_PORT:51821/tcp"
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    sysctls:
      net.ipv4.ip_forward: "1"
      net.ipv4.conf.all.src_valid_mark: "1"
      net.ipv6.conf.all.disable_ipv6: "0"
      net.ipv6.conf.all.forwarding: "1"
      net.ipv6.conf.default.forwarding: "1"
    restart: unless-stopped
    networks:
      - wg
volumes:
  etc_wireguard:
networks:
  wg:
    enable_ipv6: true
EOF
}
start_panel() {
  log '[4/5] Preparing isolated wg-easy Compose project (existing data is preserved)'
  write_compose
  local compose=(docker compose -f "$BASE/compose.yml")
  "${compose[@]}" config --quiet
  log "Pulling $IMAGE"
  "${compose[@]}" pull
  "${compose[@]}" up -d
  log '[5/5] Waiting for the web panel (60 attempts, up to 2 seconds per request)'
  local attempt
  for ((attempt=0; attempt<60; attempt++)); do
    if curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$WEB_PORT/"; then return; fi
    sleep 2
  done
  "${compose[@]}" logs --tail=80 >&2
  fail 'Panel did not become ready; inspect compose logs (data retained)'
}
main() {
  parse_args "$@"
  [[ "$EUID" == 0 ]] || fail 'Run as root'
  [[ "$(uname -s)" == Linux ]] || fail 'Linux is required'
  source /etc/os-release
  [[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || fail 'This installer supports Ubuntu 24.04 only'
  case "$(uname -m)" in x86_64|aarch64) ;; *) fail 'amd64/arm64 is required' ;; esac
  command -v ss >/dev/null || fail 'iproute2 (ss) is required'
  command -v fuser >/dev/null || command -v lslocks >/dev/null || fail 'fuser or lslocks is required to wait for APT locks'
  exec > >(tee -a /var/log/wg-captive-awg-exit-install.log) 2>&1
  log '[1/5] Checking ports and existing installations'
  check_existing
  if ! command -v curl >/dev/null; then
    apt_run update
    apt_run install -y ca-certificates curl
  fi
  install_kernel
  install_docker
  # Recheck after package installation before creating a container.
  check_existing
  start_panel
  log 'Web panel is ready; finish setup before the VPN can accept clients.'
  log "On your computer: ssh -N -L $WEB_PORT:127.0.0.1:$WEB_PORT root@$ENDPOINT"
  log "Open http://127.0.0.1:$WEB_PORT and create the admin account."
  log "Wizard: Host=$ENDPOINT, UDP port=$PORT. Choose a subnet not used on your relay (e.g. 10.66.66.0/24)."
  log "Allow UDP $PORT in the provider firewall. HTTP is localhost-only; use HTTPS reverse proxy for public access."
  log 'Check AWG parameters in the UI, create relay-node-1, export .conf and import it on the relay.'
  log "After setup: docker exec $CONTAINER ip -d link show wg0 (expect amneziawg)."
  log 'No automatic reboot, Go install, host default route change or firewall flush.'
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
