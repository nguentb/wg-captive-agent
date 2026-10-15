# OpenVPN TCP cho relay

Duong user -> wg0 -> captive agent giu nguyen. Chi duong relay -> exit duoc doi giua WireGuard UDP va OpenVPN TCP. Chi mot tunnel duoc chon; khong tu dong failover.

## Node relay

Update/cai agent se cai OpenVPN tren host Ubuntu 24.04. OpenVPN tao interface `tun-exit` trong network namespace cua wg-easy. Khong doi default route cua VPS/container va khong ap dung DNS/route do exit push.

```bash
sudo apt update
sudo apt install -y openvpn
openvpn --version
```

Can OpenVPN 2.6+ (goi mac dinh cua Ubuntu 24.04). Cai lai agent/update de co `wg-captive-openvpn.service`. Khong enable service nay truc tiep; tab Relay/agent quan ly no.

Config TCP xuat tu OpenVPN UI co the giu `user nobody`/`group nogroup`. Import giu lai hai tuy chon ha quyen nay; tai khoan/group phai ton tai tren host relay (Ubuntu co san `nobody`/`nogroup`). Service da bat `persist-key`/`persist-tun` de reconnect sau khi ha quyen. Cac lua chon route/DNS van do agent quan ly.

## Cai exit tu dong

Script `scripts/install-openvpn-exit.sh` cai OpenVPN TCP tren host exit dang co wg-easy. Tai va chay tren exit (thay IP vi du bang IP public exit that):

```bash
curl -fsSL https://raw.githubusercontent.com/nguentb/wg-captive-agent/main/scripts/install-openvpn-exit.sh -o /root/install-openvpn-exit.sh
sudo bash /root/install-openvpn-exit.sh --endpoint 203.0.113.10
```

Mac dinh TCP 8443, subnet `10.250.240.0/24`, client `relay-node`, file xuat `/root/relay-node.ovpn`. Doi cong/tao client rieng bang `--port 9443 --client relay-node-2`. Moi relay nen dung client name rieng. Chay lai giu CA, server key va certificate client da co; them client moi van restart service OpenVPN nay.

Script kiem tra cong dang dung va subnet tren host/wg-easy mac dinh, tu tao certificate, service va NAT. Rule rieng trong cac chain `WG_TCP_EXIT_*` duoc khoi phuc qua service `wg-captive-exit-firewall` sau reboot. Script khong flush firewall chung, khong restart Docker/wg-easy va khong luu snapshot cac rule Docker. Neu da cai thu cong `captive-tcp.conf`, script dung de tranh ghi de; tiep tuc dung cach thu cong ben duoi.

Can mo TCP 8443 (hoac cong da chon) tren firewall nha cung cap. Sau khi reload UFW/firewall thu cong, ap dung lai rule OpenVPN neu can:

```bash
sudo systemctl restart wg-captive-exit-firewall
```

Kiem tra:

```bash
sudo systemctl status openvpn-server@captive-tcp --no-pager
sudo journalctl -u openvpn-server@captive-tcp -n 50 --no-pager
sudo ss -lntp 'sport = :8443'
```

## Cai exit TCP tren Ubuntu 24.04

Thuc hien tren **exit**, khong phai relay. Vi du dung TCP 8443 va subnet tunnel `10.250.240.0/24`. Doi subnet neu trung voi WireGuard, Docker hoac mang khac. Mo TCP 8443 tren firewall cua nha cung cap va firewall host; co the gioi han nguon la IP public cua relay.

Vao shell root va tao certificate rieng cho tunnel TCP:

```bash
sudo -i
apt update
apt install -y openvpn easy-rsa
install -d -m 0700 /etc/openvpn/captive-pki
cp -a /usr/share/easy-rsa/. /etc/openvpn/captive-pki/
cd /etc/openvpn/captive-pki
./easyrsa init-pki
EASYRSA_REQ_CN=captive-tcp-ca ./easyrsa --batch build-ca nopass
./easyrsa --batch build-server-full relay-exit nopass
./easyrsa --batch build-client-full relay-node nopass
install -d -m 0700 /etc/openvpn/server
install -m 0600 pki/ca.crt /etc/openvpn/server/captive-ca.crt
install -m 0600 pki/issued/relay-exit.crt /etc/openvpn/server/captive-server.crt
install -m 0600 pki/private/relay-exit.key /etc/openvpn/server/captive-server.key
openvpn --genkey secret /etc/openvpn/server/captive-tls-crypt.key
chmod 0600 /etc/openvpn/server/captive-tls-crypt.key
nano /etc/openvpn/server/captive-tcp.conf
```

Noi dung server config:

```conf
port 8443
proto tcp4-server
dev tun-captive
dev-type tun
topology subnet
server 10.250.240.0 255.255.255.0
ca /etc/openvpn/server/captive-ca.crt
cert /etc/openvpn/server/captive-server.crt
key /etc/openvpn/server/captive-server.key
dh none
tls-crypt /etc/openvpn/server/captive-tls-crypt.key
tls-version-min 1.2
data-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305
keepalive 10 60
persist-key
persist-tun
allow-compression no
disable-dco
verb 3
```

Bat forwarding va NAT tren exit. Van trong shell root:

```bash
printf 'net.ipv4.ip_forward=1\n' > /etc/sysctl.d/99-captive-tcp-exit.conf
sysctl --system
EXIT_UPLINK=$(ip -4 route show default | awk 'NR==1 {print $5}')
printf 'Exit uplink: %s\n' "$EXIT_UPLINK"
iptables -I INPUT -p tcp --dport 8443 -j ACCEPT
iptables -I FORWARD -i tun-captive -o "$EXIT_UPLINK" -s 10.250.240.0/24 -j ACCEPT
iptables -I FORWARD -i "$EXIT_UPLINK" -o tun-captive -d 10.250.240.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -t nat -A POSTROUTING -s 10.250.240.0/24 -o "$EXIT_UPLINK" -j MASQUERADE
systemctl enable --now openvpn-server@captive-tcp
systemctl status openvpn-server@captive-tcp --no-pager
ss -lntp | grep ':8443'
```

Luu cac rule tren bang co che firewall hien co cua exit de chung con sau reboot. Neu exit dung UFW, can them allow/forward/NAT vao UFW; khong chi dung cac lenh iptables tam thoi tren.

## Tao file client .ovpn

Tren exit, van trong shell root. Thay `EXIT_PUBLIC_IP` bang IP exit that (hoac domain). Config vi du dung IPv4/TCP 8443:

```bash
cd /etc/openvpn/captive-pki
EXIT_PUBLIC_IP=203.0.113.10
umask 077
{
  printf 'client\ndev tun\nproto tcp4-client\nremote %s 8443\nnobind\npersist-key\npersist-tun\nremote-cert-tls server\nverify-x509-name relay-exit name\nallow-compression no\nverb 3\n' "$EXIT_PUBLIC_IP"
  printf '<ca>\n'
  cat pki/ca.crt
  printf '</ca>\n<cert>\n'
  sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' pki/issued/relay-node.crt
  printf '</cert>\n<key>\n'
  cat pki/private/relay-node.key
  printf '</key>\n<tls-crypt>\n'
  cat /etc/openvpn/server/captive-tls-crypt.key
  printf '</tls-crypt>\n'
} > /root/relay-node.ovpn
```

File nay chua private key; import qua admin cua relay, khong cong khai. Moi relay nen co certificate client rieng.

## Su dung tab Relay

1. Vao muc OpenVPN TCP, import `relay-node.ovpn`. Co the import truoc trong khi WireGuard van dang chay.
2. Tat switch Relay de dung route va tunnel WireGuard den exit. `wg0` cua user van chay.
3. Chon OpenVPN TCP, bam Use this tunnel, bat switch Relay.
4. Bam Refresh va kiem tra tunnel UP, route ENABLED. Test IP public tu mot user active; phai la IP exit.
5. Quay ve UDP: tat Relay, chon WireGuard UDP, Use this tunnel, bat Relay. Khong can import lai.

Captive/disabled/expired va block IP dich van duoc ap dung truoc tunnel. DNS `udp/53`, `tcp/53`, `tcp/853` van bo qua tunnel nhu truoc. Loi TCP se khong tu dong doi ve UDP. TCP tunnel co the giam toc do khi duong truyen mat goi.

## Kiem tra loi

Tren relay:

```bash
sudo wg-captive-agent relay-status
sudo systemctl status wg-captive-openvpn --no-pager
sudo journalctl -u wg-captive-openvpn -n 80 --no-pager
PID=$(docker inspect -f '{{.State.Pid}}' wg-easy)
sudo nsenter -t "$PID" -n ip -4 addr show tun-exit
sudo nsenter -t "$PID" -n ip route show table 200
sudo nsenter -t "$PID" -n ip rule show
```

Agent khong tu dung OpenVPN sau 20 giay nua. Start tra ve ngay voi trang thai connecting; service thu lai TCP o nen (10 giay moi lan, khoang nghi tang toi da 5 giay). Endpoint duoc resolve tren host va cac IP cung family duoc dua vao danh sach remote de OpenVPN thu lan luot. Trong luc cho ket noi, co the tat Tunnel bat ky luc nao.

Tunnel chi duoc bao UP khi management socket tra CONNECTED,SUCCESS va TUN co IPv4. IP tren TUN con ton tai do persist-tun khong du de ket luan TLS da ket noi. Management socket nam trong /run/wg-captive-openvpn (0700), chi user root duoc ket noi; khong mo management TCP port. Bat Route khi chua ket noi se ghi nhan yeu cau pending, service chi ap dung route sau khi handshake thanh cong; tat Route huy yeu cau nay. User van dung duong cu trong luc route chua duoc ap dung.

Giao dien tu tai lai trang thai trong luc dang connecting va co nut OpenVPN logs. Interface UP khong dam bao exit NAT ra Internet da dung. Test Internet tu user active thay vi curl tren host relay (host khong duoc route qua exit).

Service tu reconnect khi TCP mat ket noi. Khi wg-easy restart va doi network namespace, service tao lai tunnel trong namespace moi va ap dung lai route neu Relay van enabled. Khi reboot, `wg-captive-relay-restore` khoi phuc giao thuc dang chon.

Bat Relay khi TCP tunnel da CONNECTED se dung lai ket noi hien tai; chi Restart tao lai tunnel. Tac vu khoi phuc route nen khong cho khoa relay, ma thu lai sau neu co thao tac khac; khi reconnect thanh cong, route duoc ap dung lai. Lenh dieu khien chi cho khoa toi da 2 giay; API tra loi busy thay vi xep chong thao tac. Dung service huy ngay vong cho, co timeout systemd 5 giay.

Neu log dung o Attempting to establish TCP connection (chua co TCP connection established), kiem tra tren exit:

```bash
sudo ss -lntup | grep ':11355'
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

Neu chi thay UDP 11355, relay TCP khong the ket noi. Doi proto cua OpenVPN server thanh tcp-server, xac nhan port noi bo va publish Docker dung /tcp (vi du 11355:11355/tcp khi server nghe port noi bo 11355). Thay mapping Docker can recreate container tu compose/cau hinh trien khai goc, khong chi docker restart; giu nguyen volume/certificate va khong xoa volume. Mo TCP port tren firewall VPS va nha cung cap. Neu chua biet port noi bo thi khong tu gia dinh no la 1194 hoac 11355.

Rule relay dung `ip`, `iptables`, `ipset` tren host thong qua `nsenter`, giong captive agent. Khong can cai ipset trong container wg-easy. Loi ap dung rule se tra ve that bai thay vi van bao route enabled. Chi `wg-quick` va thao tac file config WireGuard van chay trong container.

## API va CLI

```text
POST /api/v1/relay/import?protocol=openvpn   multipart relayConf
POST /api/v1/relay/import?protocol=wireguard multipart relayConf
POST /api/v1/relay/action {"action":"relay-select","protocol":"openvpn"}
GET  /api/v1/relay                         protocol + profiles + status
```

API import khong co protocol van mac dinh la WireGuard de tuong thich ban cu. Tat route/tunnel truoc khi relay-select:

```bash
sudo wg-captive-agent relay-disable
sudo wg-captive-agent relay-select openvpn
sudo wg-captive-agent relay-enable
```

Backup `state-db` gom config va private key cua ca hai giao thuc, cung giao thuc dang chon. Restore ghi lai file config tu DB va bat lai relay neu backup co relay enabled. Backup cu chua co OpenVPN duoc migrate thanh WireGuard.

Tham khao: [OpenVPN 2.6 manual](https://openvpn.net/community-docs/community-articles/openvpn-2-6-manual.html).
