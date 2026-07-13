# wg-captive-agent

Captive firewall agent cho cac WireGuard/wg-easy server, kem web admin de quan ly router bi khoa. Portal nap tien cua khach hang la repo/web rieng; repo nay chi dieu khien captive mechanism tren tung WireGuard server.

## Tinh nang

- Doc danh sach client tu `wg0.json` cua wg-easy, fallback `wg0.conf`, roi sync ve SQLite.
- Hien thi giao dien don gian theo phong cach wg-easy: ten, IP, trang thai, nut bat/tat captive.
- Bat/tat user va han su dung bang SQLite, agent sync firewall tu DB.
- Redirect HTTP port 80 cua router bi khoa ve `PORTAL_IP:80`.
- Cho phep router bi khoa truy cap `PORTAL_IP:80` va `PORTAL_IP:443`.
- Chan HTTPS toi noi khac, DNS-over-TLS `853`, DNS thuong `53` va traffic con lai.
- Tab Settings de cau hinh portal IP, relay client subnet, Telegram backup, auto backup theo gio.
- Backup local `.tar.gz` gom `state-db`, `metadata`, `wg0` va `blocked-ips` runtime.
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

## Cap nhat

Sau khi da cai bang link remote, server se co san 2 lenh update tuong duong:

```bash
sudo captive_update
# hoac
sudo wg-captive-update
```

Lenh nay tu tai ban moi nhat tren branch `main`, chay lai `install.sh`, giu nguyen `/etc/wg-captive-agent.env`, roi restart `wg-captive-agent` va `wg-captive-admin`.

## Cai dat thu cong

```bash
git clone https://github.com/nguentb/wg-captive-agent.git
cd wg-captive-agent
chmod +x bin/wg-captive-agent install.sh uninstall.sh scripts/wg-captive-update
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
STATE_DB=/etc/wg-captive-agent.db
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
ADMIN_API_TOKEN=
```
Luu y captive popup: nen de `BLOCK_DNS=0` va `BLOCK_DOT=0` de thiet bi resolve duoc cac domain kiem tra captive nhu `captive.apple.com`, `connectivitycheck.gstatic.com`, `neverssl.com`. Agent van chan web/traffic sau do bang firewall; DNS chi duoc mo de popup co co hoi kich hoat.


## Web admin

Tab `Captive`:

- Doc client tu `WG_EASY_JSON` cua wg-easy, fallback sang `wg0.conf` neu JSON khong doc duoc, sau do sync ve SQLite `STATE_DB`.
- Hien thi ten, IP, trang thai `active`/`disabled`/`expired`.
- `active`: user hoat dong binh thuong.
- `disabled`: bi admin tat bang switch, luu trong `client_state.disabled`.
- `expired`: da duoc job het han danh dau vao `client_state.expired_at`.
- `EXPIRED_FILE` chi la file runtime agent xuat ra de firewall chan ca `disabled` va `expired`.

Tab `Relay`:

- Import file WireGuard client config `.conf` cua exit server.
- File import duoc tu dong them/thay `Table = off` trong `[Interface]` de tranh wg-quick doi default route cua container.
- `Start tunnel`/`Stop tunnel`/`Restart tunnel` quan ly interface `wg-exit` trong container `wg-easy`.
- `Enable route`/`Disable route` tao route policy: `ip rule from RELAY_CLIENT_SUBNET table RELAY_ROUTE_TABLE`, default route qua `wg-exit`, va NAT MASQUERADE.
- Khi captive dang bat, chain captive van xu ly user bi khoa truoc; user active moi di qua relay route.

Tab `Settings`:

- Cai dat `PORTAL_IP`, `SERVER_PUBLIC_IP` va `RELAY_CLIENT_SUBNET` cho relay route, mac dinh `10.8.0.0/24`.
- Cai dat Telegram bot token/chat ID.
- Bat/tat gui backup len Telegram.
- Bat/tat auto backup theo cac moc gio trong ngay, vi du `02:00,14:00`.
- Nut `Backup now` tao file local va gui Telegram ngay.
- Restore tu file `.tar.gz` upload len.

## SQLite state

Tu phien ban SQLite, du lieu chinh nam trong `STATE_DB` voi 3 bang:

- `client_state`: IP, ten client lay tu wg-easy `wg0.json`, public key, `disabled`, `expires_at` va `expired_at`.
- `node_config`: cac setting chung cua node nhu portal IP, Telegram, DNS block, server IP.
- `relay_config`: trang thai relay, subnet route, interface exit va noi dung WireGuard .conf da import.

Khong con che do tuong thich JSON cu cho `disabled`/`expiry`; cai dat moi se dung SQLite lam nguon du lieu chinh. `expires_at` la lich het han, `expired_at` la luc backend da dua user vao trang thai expired. `EXPIRED_FILE` chi la output runtime cho firewall.

## Check het han

Backend web admin dat lich check het han theo cac moc gio trong `EXPIRY_CHECK_TIMES`, mac dinh `00:10,12:10`. Moi lan den moc gio, backend:

- Tim user co `expires_at <= now` va `expired_at` con trong.
- Ghi `expired_at=now` cho cac user moi het han.
- Tao lai `EXPIRED_FILE` tu cac user `disabled` + `expired`.
- Goi `wg-captive-agent sync` de cap nhat ipset/firewall.

Co the tat job bang `EXPIRY_CHECK_ENABLED=0`. Central server co the goi thu cong `POST /api/v1/expiry/check` neu muon tu dieu phoi lich rieng.

## Dinh dang backup

Backup la file `.tar.gz` trong `BACKUP_DIR`, gom cac file:

```text
blocked-ips
metadata
wg0
state-db
```

`blocked-ips`: moi dong la mot IP WireGuard dang bi khoa, gom ca `disabled` va `expired`.

`state-db`: ban sao SQLite gom 3 bang `client_state`, `node_config`, `relay_config`.

`wg0`: ban sao cua `wg0.json` tu wg-easy.

`metadata`: JSON gom thong tin chung:

```json
{
  "server_name": "wg-server-01",
  "server_ip": "203.0.113.20",
  "backup_time": "2026-07-02T07:00:00.000Z",
  "blocked_users": 3,
  "disabled_users": 1,
  "expired_users": 2,
  "wg_easy_json": "/etc/wireguard/wg0.json",
  "expired_file": "/etc/wg-captive-expired.txt",
  "state_db": "/etc/wg-captive-agent.db"
}
```

Restore trong web admin yeu cau backup co `state-db`, sau do tao lai `EXPIRED_FILE` va sync firewall. File `wg0` chi nam trong backup de luu tru; neu can restore `wg0.json`, thuc hien qua panel cua wg-easy.


## Cai SSL cho node bang Cloudflare

Neu node co domain nam tren Cloudflare, co the lay Let's Encrypt bang DNS-01. Chay lenh sau tren server:

```bash
sudo captive_ssl_cloudflare
```

Tool nay chi cau hinh SSL/nginx cho `wg-captive-admin` va API. wg-easy panel giu nguyen cach chay hien tai, vi wg-easy nam trong container va khong thuoc pham vi tool nay.

Moi lan chay, tool se hoi `Domain`, `Email`, `Cloudflare API token`, cong HTTPS public cho admin va cong HTTP noi bo cho admin. Mac dinh:

```text
https://wg.domain.com:51822 -> http://127.0.0.1:51824
```

Script se tu sua `/etc/wg-captive-agent.env` thanh:

```text
ADMIN_HOST=127.0.0.1
ADMIN_PORT=51824
```

Sau do nginx dung cert cua `wg.domain.com` de listen `51822/https` va proxy ve admin/API noi bo. Cert SSL cap theo hostname, nen co the dung cho `wg.domain.com:51822` ma khong can dung truc tiep `https://wg.domain.com` port `443`.

Token Cloudflare can quyen `Zone.Zone:Read` va `Zone.DNS:Edit` tren zone chua domain. Script se:

- Cai `nginx`, `certbot`, `python3-certbot-dns-cloudflare`.
- Luu cau hinh SSL vao `/etc/wg-captive-ssl-cloudflare.env` voi quyen `600`.
- Luu Cloudflare token vao `/etc/letsencrypt/cloudflare-wg-captive-admin.ini` voi quyen `600`.
- Lay cert Let's Encrypt cho domain da nhap.
- Tao nginx HTTPS reverse proxy cho admin/API tren cong custom, mac dinh la `51822`.
- Tao renewal hook de certbot tu reload nginx sau khi gia han chung chi.

Cai SSL khong anh huong WireGuard vi WireGuard dung UDP rieng, thuong la `51820`. wg-easy panel van co the tiep tuc chay HTTP nhu cu tren cong rieng cua no.

## API v1

Frontend web admin chi giao tiep voi backend qua API `/api/v1/*`. Central server sau nay co the goi cung API nay bang header:

```http
Authorization: Bearer <ADMIN_API_TOKEN>
```

Neu dang truy cap web admin bang browser thi cookie login van dung duoc. Cac endpoint chinh:

```text
GET  /api/v1
GET  /api/v1/state
GET  /api/v1/clients
POST /api/v1/clients/{ip}/status      { "status": "active" | "disabled" }
POST /api/v1/clients/{ip}/expiry      { "expires_at": "2026-08-01T00:00:00.000Z" }
POST /api/v1/expiry/check
GET  /api/v1/settings
POST /api/v1/settings
GET  /api/v1/relay
POST /api/v1/relay/action             { "action": "relay-on" }
POST /api/v1/relay/import             multipart field: relayConf
POST /api/v1/backup
POST /api/v1/restore                  multipart field: backup
POST /api/v1/sync
```

Trang frontend hien tai dung object `API_ENDPOINTS` trong `web/wg-captive-admin.js`, nen neu sau nay tach frontend rieng hoac central proxy API thi chi can doi base/path o mot cho.

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

## Uninstall

Go sach service, binary, config, expired file, relay config, backup dir va rule firewall do wg-captive tao:

```bash
curl -fsSL https://raw.githubusercontent.com/nguentb/wg-captive-agent/main/uninstall.sh | sudo bash
```

Neu dang chay tu repo da clone:

```bash
sudo ./uninstall.sh
```

Mac dinh script xoa ca `BACKUP_DIR` de tra server ve gan nhu truoc khi cai. Neu muon giu file backup:

```bash
curl -fsSL https://raw.githubusercontent.com/nguentb/wg-captive-agent/main/uninstall.sh | sudo KEEP_BACKUPS=1 bash
```

Script khong go cac package he thong nhu `nodejs`, `iptables`, `ipset`, `curl`, `docker`, vi cac goi nay co the dang duoc dich vu khac tren server su dung.
## Luu y

- Repo nay khong tao portal nap tien cho khach hang.
- `PORTAL_IP` la public IP cua portal ben ngoai.
- Router da cau hinh DoT van xu ly duoc bang cach chan TCP 853 khi het han.
- Web admin can quyen doc `WG_EASY_JSON` hoac docker exec vao `WG_EASY_CONTAINER`, ghi `EXPIRED_FILE`, `BACKUP_DIR` va chay `wg-captive-agent sync`.
- Auto pop-up khong the dam bao 100% tren moi OS/thiet bi, nhung day la co che dung nhat khi khong can thiep router/client.


