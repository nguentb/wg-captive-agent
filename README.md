# wg-captive-agent

Captive firewall agent cho cac WireGuard/wg-easy server, kem web admin de quan ly router bi khoa. Portal nap tien cua khach hang la repo/web rieng; repo nay chi dieu khien captive mechanism tren tung WireGuard server.

## Tinh nang

- Doc danh sach client truc tiep tu `wg0.json` cua wg-easy.
- Hien thi giao dien don gian theo phong cach wg-easy: ten, IP, trang thai, nut bat/tat captive.
- Bat/tat captive bang cach them/xoa IP vao `EXPIRED_FILE` va sync firewall.
- Redirect HTTP port 80 cua router bi khoa ve `PORTAL_IP:80`.
- Cho phep router bi khoa truy cap `PORTAL_IP:80` va `PORTAL_IP:443`.
- Chan HTTPS toi noi khac, DNS-over-TLS `853`, DNS thuong `53` va traffic con lai.
- Tab Settings de cau hinh portal IP, Telegram backup, auto backup theo gio.
- Backup local `.tar.gz` gom dung cac file: `blocked-ips`, `metadata`, `wg0`.
- Gui backup len Telegram ngay sau khi tao neu da cau hinh bot token/chat ID.
- Restore tu file backup upload len web admin.
- Tab Relay de import WireGuard `.conf` cua exit server, tao tunnel `wg-exit` trong container `wg-easy`, va route traffic client qua exit node.

## Mo hinh

```text
Router Wi-Fi chay WireGuard
        |
        | wg0
        v
WireGuard server + wg-captive-agent
        |
        +-- active router: internet binh thuong
        |
        +-- blocked router:
            - HTTP -> PORTAL_IP:80
            - PORTAL_IP:80/443 duoc phep
            - TCP 443 toi noi khac bi chan
            - TCP 853 DoT bi chan
            - traffic con lai bi chan
```

## Yeu cau server

- Linux server chay WireGuard/wg-easy.
- `iptables`, `ipset`, `curl`, `tar`, `nsenter` tu goi `util-linux`.
- `nodejs` cho web admin.
- Quyen root.

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y iptables ipset curl tar nodejs util-linux wireguard-tools
```

## Cai dat nhanh

```bash
curl -fsSL https://raw.githubusercontent.com/nguentb/wg-captive-agent/main/scripts/install-remote.sh | sudo bash
```

## Cai dat thu cong

```bash
git clone https://github.com/nguentb/wg-captive-agent.git
cd wg-captive-agent
chmod +x bin/wg-captive-agent install.sh uninstall.sh
sudo ./install.sh
sudo nano /etc/wg-captive-agent.env
sudo systemctl enable --now wg-captive-agent
sudo systemctl enable --now wg-captive-admin
sudo systemctl enable wg-captive-relay-restore
```

Web admin mac dinh:

```text
http://SERVER_IP:51822
```

Doi `ADMIN_PASSWORD` truoc khi public cong quan tri.

## Cau hinh

File `/etc/wg-captive-agent.env`:

```bash
WG_INTERFACE=wg0
IPSET_NAME=wg_expired
PORTAL_IP=203.0.113.10
EXPIRED_FILE=/etc/wg-captive-expired.txt
WG_EASY_JSON=/etc/wireguard/wg0.json
WG_EASY_CONTAINER=wg-easy
WG_EASY_CONTAINER_JSON=/etc/wireguard/wg0.json
DOCKER_DNS_IP=172.17.0.1

RELAY_ENABLED=0
RELAY_EXIT_IF=wg-exit
RELAY_CLIENT_SUBNET=10.8.0.0/24
RELAY_ROUTE_TABLE=200
RELAY_EXIT_CONF=/etc/wg-captive-relay-exit.conf
RELAY_ROUTE_FLAG=/etc/wg-captive-relay.enabled

SERVER_NAME=wg-server-01
SERVER_PUBLIC_IP=203.0.113.20
BACKUP_DIR=/var/backups/wg-captive

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_BACKUP_ENABLED=1
AUTO_BACKUP_ENABLED=0
AUTO_BACKUP_TIMES=02:00,14:00

SYNC_INTERVAL=30
BLOCK_DNS=0
BLOCK_DOT=0

ADMIN_HOST=0.0.0.0
ADMIN_PORT=51822
ADMIN_PASSWORD=change-this-password
```
Luu y captive popup: nen de `BLOCK_DNS=0` va `BLOCK_DOT=0` de thiet bi resolve duoc cac domain kiem tra captive nhu `captive.apple.com`, `connectivitycheck.gstatic.com`, `neverssl.com`. Agent van chan web/traffic sau do bang firewall; DNS chi duoc mo de popup co co hoi kich hoat.

## Web admin

Tab `Captive`:

- Doc client tu `WG_EASY_JSON` cua wg-easy.
- Hien thi ten, IP, trang thai `Allowed`/`Blocked`.
- Switch ON: dua IP client vao `EXPIRED_FILE`, sync firewall.
- Switch OFF: xoa IP client khoi `EXPIRED_FILE`, sync firewall.

Tab `Relay`:

- Import file WireGuard client config `.conf` cua exit server.
- File import duoc tu dong them/thay `Table = off` trong `[Interface]` de tranh wg-quick doi default route cua container.
- `Start tunnel`/`Stop tunnel`/`Restart tunnel` quan ly interface `wg-exit` trong container `wg-easy`.
- `Enable route`/`Disable route` tao route policy: `ip rule from RELAY_CLIENT_SUBNET table RELAY_ROUTE_TABLE`, default route qua `wg-exit`, va NAT MASQUERADE.
- Khi captive dang bat, chain captive van xu ly user bi khoa truoc; user active moi di qua relay route.

Tab `Settings`:

- Cai dat `PORTAL_IP`, ten server, IP server, duong dan `wg0.json`, container `wg-easy`, DNS IP Docker, file blocked IP.
- Cai dat Telegram bot token/chat ID.
- Bat/tat gui backup len Telegram.
- Bat/tat auto backup theo cac moc gio trong ngay, vi du `02:00,14:00`.
- Nut `Backup now` tao file local va gui Telegram ngay.
- Restore tu file `.tar.gz` upload len.

## Dinh dang backup

Backup la file `.tar.gz` trong `BACKUP_DIR`, gom 3 file:

```text
blocked-ips
metadata
wg0
```

`blocked-ips`: moi dong la mot IP WireGuard dang bi khoa.

`wg0`: ban sao cua `wg0.json` tu wg-easy.

`metadata`: JSON gom thong tin chung:

```json
{
  "server_name": "wg-server-01",
  "server_ip": "203.0.113.20",
  "backup_time": "2026-07-02T07:00:00.000Z",
  "blocked_users": 3,
  "wg_easy_json": "/etc/wireguard/wg0.json",
  "expired_file": "/etc/wg-captive-expired.txt"
}
```

Restore trong web admin chi ghi lai `blocked-ips` vao `EXPIRED_FILE` roi sync firewall. File `wg0` chi nam trong backup de luu tru; neu can restore `wg0.json`, thuc hien qua panel cua wg-easy.

## Co che auto pop-up

He dieu hanh thuong goi cac URL HTTP de kiem tra captive portal. Khi router het han, agent DNAT moi request HTTP port 80 tu router do ve `PORTAL_IP:80`. Web portal HTTP nen tra HTML don gian, sau do tu chuyen sang HTTPS:

```html
<meta http-equiv="refresh" content="1; url=https://203.0.113.10/captive">
```

Dieu kien quan trong: HTTPS theo IP can certificate co SAN dang `IP Address: 203.0.113.10`.

## Lenh van hanh

Kiem tra syntax tren server:

```bash
bash -n bin/wg-captive-agent
node --check web/wg-captive-admin.js
```

Xem trang thai:

```bash
sudo systemctl status wg-captive-agent
sudo systemctl status wg-captive-admin
sudo ipset list wg_expired
sudo iptables -t nat -S WG_CAPTIVE_NAT
sudo iptables -S WG_CAPTIVE_FILTER
```

Ap rule mot lan:

```bash
sudo wg-captive-agent sync
```

Go bo rule:

```bash
sudo wg-captive-agent cleanup
```

Lenh relay:

```bash
sudo wg-captive-agent relay-status
sudo wg-captive-agent relay-tunnel-up
sudo wg-captive-agent relay-tunnel-down
sudo wg-captive-agent relay-restart
sudo wg-captive-agent relay-on
sudo wg-captive-agent relay-off
sudo wg-captive-agent relay-restore
```
Xem log:

```bash
sudo journalctl -u wg-captive-agent -f
sudo journalctl -u wg-captive-admin -f
```

## Luu y

- Repo nay khong tao portal nap tien cho khach hang.
- `PORTAL_IP` la public IP cua portal ben ngoai.
- Router da cau hinh DoT van xu ly duoc bang cach chan TCP 853 khi het han.
- Web admin can quyen doc `WG_EASY_JSON` hoac docker exec vao `WG_EASY_CONTAINER`, ghi `EXPIRED_FILE`, `BACKUP_DIR` va chay `wg-captive-agent sync`.
- Auto pop-up khong the dam bao 100% tren moi OS/thiet bi, nhung day la co che dung nhat khi khong can thiep router/client.


