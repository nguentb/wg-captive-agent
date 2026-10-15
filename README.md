# wg-captive-agent

Captive firewall agent cho cac WireGuard/wg-easy server, kem web admin de quan ly router bi khoa. Portal nap tien cua khach hang la repo/web rieng; repo nay chi dieu khien captive mechanism tren tung WireGuard server.

## Tinh nang

- Doc danh sach client tu `wg0.json` cua wg-easy, fallback `wg0.conf`, roi sync ve SQLite.
- Hien thi giao dien don gian theo phong cach wg-easy: ten, IP, trang thai, nut bat/tat captive.
- Bat/tat user va han su dung bang SQLite, agent sync firewall tu DB.
- Redirect HTTP port 80 cua router bi khoa ve service `wg-captive-redirect` chay trong network namespace cua `wg-easy`, tao token 15 phut va tra `302` sang `PORTAL_URL?node=SERVER_NAME&token=...`.
- Cho phep router bi khoa truy cap `PORTAL_IP` da duoc resolve tu `PORTAL_URL` khi bam Save Settings tren port 443.
- Chan HTTPS toi noi khac, DNS-over-TLS `853`, DNS thuong `53` va traffic con lai.
- Chan IP dich doc hai bang ipset `wg_blocked_dst`; them IP/CIDR trong Settings de chan WireGuard client ket noi toi IP do.
- Tab Settings de cau hinh portal URL, relay client subnet, Telegram backup, auto backup theo gio.
- Backup local `.tar.gz` gom `state-db`, `metadata` va `wg0.json`.
- Gui backup len Telegram ngay sau khi tao neu da cau hinh bot token/chat ID.
- Restore tu file backup upload len web admin.
- Tab Relay quan ly hai tunnel: WireGuard UDP (`.conf`, `wg-exit`) va OpenVPN TCP (`.ovpn`, `tun-exit`), chuyen thu cong khi UDP loi.

## Mo hinh

```text
Router Wi-Fi chay WireGuard
        |
        | wg0.json
        v
WireGuard server + wg-captive-agent
        |
        +-- active router: internet binh thuong
        |
        +-- blocked router:
            - HTTP -> wg-captive-redirect trong netns wg-easy -> PORTAL_URL?node=SERVER_NAME&token=...
            - PORTAL_IP da luu:443 duoc phep
            - TCP 443 toi noi khac bi chan
            - TCP 853 DoT bi chan
            - traffic con lai bi chan
```

## Yeu cau server

- Linux server chay WireGuard/wg-easy.
- `iptables`, `ipset`, `curl`, `tar`, `nsenter` tu goi `util-linux`.
- `nodejs` 24 LTS cho web admin va backup Telegram. Ban Node 24 co co che ket noi moi tot hon khi server co ca IPv4/IPv6.
- Quyen root.

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
sudo chmod 0644 /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt update
sudo apt install -y iptables ipset tar nodejs util-linux wireguard-tools openvpn
node -v
node -p 'require("node:net").getDefaultAutoSelectFamily()'
```

Lenh cuoi phai tra ve `true`. Neu khong phai `true`, khong nen tiep tuc cai vi backup Telegram co the bi ket khi server can tu chon IPv4/IPv6.

## Cai moi tu dau

1. Xac nhan wg-easy dang chay va ten container dung la `wg-easy`:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep wg-easy
docker exec wg-easy sh -c 'test -f /etc/wireguard/wg0.json && echo wg0.json-ok || test -f /etc/wireguard/wg0.conf && echo wg0.conf-ok'
```

2. Cai agent bang branch `main`:

```bash
curl -fsSL https://raw.githubusercontent.com/nguentb/wg-captive-agent/main/scripts/install-remote.sh | sudo bash
```

3. Sua toi thieu mat khau admin. Cac duong dan wg-easy mac dinh da phu hop container `wg-easy`:

```bash
sudo nano /etc/wg-captive-agent.env
```

Can doi ngay:

```text
SERVER_NAME=ten-node-khong-trung-voi-node-khac
```

Khong dien mat khau tho vao env. Lan dau mo web admin, he thong se yeu cau tao password va luu `ADMIN_PASSWORD_HASH` vao `/etc/wg-captive-agent.env`.

4. Restart va kiem tra ba service chay thuong truc:

```bash
sudo systemctl restart wg-captive-agent wg-captive-admin wg-captive-redirect
sudo systemctl status wg-captive-agent wg-captive-admin wg-captive-redirect --no-pager
sudo wg-captive-agent status
```

5. Mo `http://SERVER_IP:51822`, dang nhap, vao Settings, nhap `Portal URL` va bam Save. Tai thoi diem Save, backend resolve domain mot lan va luu IPv4 vao `PORTAL_IP`. Neu firewall cloud/UFW dang bat, chi mo TCP `51822` cho IP quan tri; khong can mo cong redirect `51823` ra Internet.

6. Trong Settings tao API token cho portal. Tren trang `https://PORTAL_DOMAIN/admin`, them node voi cung `SERVER_NAME`, dia chi API cua node va token vua tao.

7. Thu khoa mot client, sau do kiem tra HTTP redirect tu network namespace cua wg-easy:

```bash
PID=$(docker inspect -f '{{.State.Pid}}' wg-easy)
sudo nsenter -t "$PID" -n curl -sSI http://127.0.0.1:51823/generate_204
```

Ket qua dung la `HTTP/1.1 302 Found` va `Location: https://PORTAL_DOMAIN/?node=...&token=...`.

## Cai dat nhanh

Neu da hieu cac gia tri mac dinh, lenh cai dat van la:

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

Lenh nay tu tai ban moi nhat tren branch `main`, chay lai `install.sh`, giu nguyen `/etc/wg-captive-agent.env`, roi restart `wg-captive-agent`, `wg-captive-admin` va `wg-captive-redirect`.

## Cai dat thu cong

```bash
git clone https://github.com/nguentb/wg-captive-agent.git
cd wg-captive-agent
chmod +x bin/wg-captive-agent bin/wg-captive-redirect install.sh uninstall.sh scripts/wg-captive-update
sudo ./install.sh
sudo nano /etc/wg-captive-agent.env
sudo systemctl enable --now wg-captive-agent
sudo systemctl enable --now wg-captive-admin
sudo systemctl enable --now wg-captive-redirect
sudo systemctl enable wg-captive-relay-restore
```

Web admin mac dinh:

```text
http://SERVER_IP:51822
```

Lan dau truy cap web admin se duoc yeu cau tao password. Password khong luu tho trong env; chi luu `ADMIN_PASSWORD_HASH`.

## Cau hinh

File `/etc/wg-captive-agent.env`:

```bash
WG_INTERFACE=wg0
IPSET_NAME=wg_expired
BLOCKED_DEST_IPSET_NAME=wg_blocked_dst
BLOCKED_DEST_IPS=
PORTAL_URL=https://portal.example.com
# Optional fixed IP override if DNS cannot be used:
# PORTAL_IP=203.0.113.10
STATE_DB=/etc/wg-captive-agent.db
EXPIRED_FILE=/etc/wg-captive-expired.txt
WG_EASY_JSON=/etc/wireguard/wg0.json
WG_EASY_CONTAINER=wg-easy
WG_EASY_CONTAINER_JSON=/etc/wireguard/wg0.json
WG_EASY_CONF=/etc/wireguard/wg0.conf
WG_EASY_CONTAINER_CONF=/etc/wireguard/wg0.conf
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
ADMIN_PASSWORD_HASH=
ADMIN_API_TOKEN=
CAPTIVE_REDIRECT_PORT=51823
CAPTIVE_NETNS_CHECK_INTERVAL=5
REDIRECT_TOKEN_CLEANUP_TIMES=03:20,15:20
EXPIRY_CHECK_ENABLED=1
EXPIRY_CHECK_TIMES=00:10,12:10
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
- Nut `Dong bo client` doc lai nguon WireGuard ngay lap tuc. Tai lai trang Captive cung tu dong doi chieu nguon voi SQLite.
- Client khong con trong `wg0.json`/`wg0.conf` duoc danh dau `source_present=0`, nhung khong bi xoa tu dong. Tab `Da xoa` hien cac client nay va chi tai do moi co nut thung rac xoa ban ghi SQLite. Neu nguon WireGuard dang loi/khong doc duoc, backend bo qua lan doi chieu va khong cho xoa.
- Danh sach client trong admin giu dung thu tu trong `wg0.json`/`wg0.conf`; IP nho hon nhung nam cuoi file se van nam cuoi danh sach.
- `Blocked destination IPs` trong Settings chap nhan moi dong mot IP/CIDR hoac ngan cach bang dau phay, vi du `203.0.113.10` hoac `198.51.100.0/24`. Rule chi ap dung cho traffic forward di vao tu `WG_INTERFACE`, khong doi trang thai user va khong anh huong route khac cua VPS. Khi relay dang bat, traffic toi IP nay duoc bo qua truoc buoc mark relay roi bi reject, nen khong duoc chuyen tiep qua exit. Cac dong sai dinh dang se bi bo qua khi sync firewall.

Tab `Relay`:

- Hai muc `WireGuard UDP` va `OpenVPN TCP` luu config rieng. Chon muc de xem/import config; nut `Use this tunnel` chon giao thuc se chay.
- Chi mot tunnel duoc chon de relay. Tat switch Relay (hoac tat Route va Tunnel), chon muc con lai, bam `Use this tunnel`, roi bat Relay. Khong co tu dong failover.
- WireGuard import file `.conf` cua exit server.
- File import duoc tu dong them/thay `Table = off` trong `[Interface]` de tranh wg-quick doi default route cua container.
- OpenVPN import file `.ovpn` TCP, gom inline `<ca>`, `<cert>`, `<key>` va neu co `<tls-crypt>`/`<tls-auth>`. Khong chap nhan profile UDP, script, plugin, file certificate ben ngoai hoac password tuong tac.
- OpenVPN 2.6+ chay tren host bang service `wg-captive-openvpn`, vao network namespace cua wg-easy qua `nsenter`, tao `tun-exit`. Khong can cai OpenVPN trong container.
- `route-nopull`, `route-noexec` giu routing va DNS do captive agent quan ly. Endpoint OpenVPN duoc resolve tren host truoc khi vao namespace.
- Tunnel/Restart/Route quan ly giao thuc dang chon. Dung tunnel se tat route truoc. Khong thay config dang chay; config du phong co the import trong khi tunnel con lai dang chay.
- Nut Refresh tai lai status thu cong. Config cua ca hai tunnel va giao thuc dang chon nam trong SQLite, duoc backup/restore cung `state-db`.
- Huong dan cai exit TCP va tao `.ovpn`: [OpenVPN TCP relay](docs/openvpn-relay.md).
- Cai exit tu dong: chuyen `scripts/install-openvpn-exit.sh` len exit, chay `sudo bash /root/install-openvpn-exit.sh --endpoint IP_PUBLIC_EXIT`. Script xuat `/root/relay-node.ovpn`, tu tao NAT persistent va giu wg-easy dang chay.
- `Enable route`/`Disable route` tao mangle chain `WG_RELAY_MARK`: client trong `RELAY_CLIENT_SUBNET` se duoc mark de di qua table relay, nhung IP dang nam trong ipset `wg_expired` se bi bo qua truoc khi mark.
- DNS cua client khong di qua exit: `udp/53`, `tcp/53` va `tcp/853` duoc bo qua trong chain relay mark, nen resolve DNS van xu ly tai node relay/duong ra mac dinh cua node.
- Vi relay chi route traffic da duoc `WG_RELAY_MARK`, user bi `disabled`/`expired` van giu co che captive popup/portal; user active moi di qua exit node.

Tab `Settings`:

- Cai dat `PORTAL_URL`, `SERVER_PUBLIC_IP` va `RELAY_CLIENT_SUBNET` cho relay route, mac dinh `10.8.0.0/24`.
- Cai dat Telegram bot token/chat ID.
- Bat/tat gui backup len Telegram.
- Bat/tat auto backup theo cac moc gio trong ngay, vi du `02:00,14:00`.
- Nut `Backup now` tao file local va gui Telegram ngay.
- Restore tu file `.tar.gz` upload len.

## SQLite state

Tu phien ban SQLite, du lieu chinh nam trong `STATE_DB`:

- `client_state`: IP, ten client lay tu wg-easy `wg0.json`, public key, `disabled`, `expires_at` va `expired_at`.
- `node_config`: cac setting chung cua node nhu portal URL, Telegram, DNS block, server IP.
- `relay_config`: trang thai relay, subnet route, giao thuc dang chon, config WireGuard va OpenVPN da import. Update tu ban cu tu dong them cot va mac dinh giu WireGuard.
- `api_tokens`: cac token API cua node, dung cho central server/tool ben ngoai goi API.
- `captive_redirect_tokens`: token random tam thoi cho portal tra cuu user khi node redirect captive, mac dinh het han sau 15 phut.

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
metadata
wg0.json
state-db
```


`state-db`: ban sao SQLite gom cac bang `client_state`, `node_config`, `relay_config`, `api_tokens`.

`wg0.json`: ban sao cua `wg0.json` tu wg-easy.

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

Restore trong web admin yeu cau backup co `state-db`, sau do tao lai `EXPIRED_FILE` tu SQLite va sync firewall. File `wg0.json` chi nam trong backup de luu tru; neu can restore `wg0.json` that cua wg-easy, thuc hien qua panel cua wg-easy.


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

### Go SSL va quay ve dang nhap bang IP

Neu da cai SSL/nginx cho web admin node nhung muon quay ve nhu ban dau, chay:

```bash
sudo captive_ssl_remove
```

Lenh nay chi go cau hinh SSL/nginx cua `wg-captive-admin`, khong go agent, khong go WireGuard, khong go wg-easy. Sau khi chay xong admin se quay ve:

```text
http://SERVER_IP:51822
```

Script se dat lai:

```text
ADMIN_HOST=0.0.0.0
ADMIN_PORT=51822
```

## Cai SSL khi domain khong nam tren Cloudflare

Neu domain khong dung Cloudflare hoac khong co Cloudflare API token, dung Let's Encrypt HTTP-01 qua nginx. Cach nay yeu cau:

- DNS record `A` cua domain tro ve IPv4 public cua server captive.
- Port TCP `80` mo ra Internet de Let's Encrypt xac minh domain.
- Port HTTPS public cho admin, mac dinh `51822`, mo cho IP quan tri.
- WireGuard UDP `51820` va wg-easy panel khong bi anh huong.

Vi du domain la `wg2.example.com`, muon mo admin bang:

```text
https://wg2.example.com:51822
```

1. Cai nginx va certbot:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

2. Cho `wg-captive-admin` chi nghe noi bo, vi nginx se dung HTTPS public va proxy vao admin:

```bash
sudo sed -i '/^ADMIN_HOST=/d;/^ADMIN_PORT=/d' /etc/wg-captive-agent.env
printf 'ADMIN_HOST=127.0.0.1\nADMIN_PORT=51824\n' | sudo tee -a /etc/wg-captive-agent.env
sudo systemctl restart wg-captive-admin
```

3. Dam bao nginx co the chay HTTP port `80` de lay cert:

```bash
sudo mkdir -p /var/www/html
sudo nginx -t
sudo systemctl reload nginx
```

Neu `nginx -t` loi do mot file site dang tro toi cert chua ton tai, hay tam thoi go site do khoi `sites-enabled`, lay cert xong roi bat lai.

4. Lay cert Let's Encrypt bang webroot:

```bash
sudo certbot certonly --webroot -w /var/www/html -d wg2.example.com
```

Sau khi thanh cong, cert se nam o:

```text
/etc/letsencrypt/live/wg2.example.com/fullchain.pem
/etc/letsencrypt/live/wg2.example.com/privkey.pem
```

Co the kiem tra ten thu muc cert that bang:

```bash
sudo ls -la /etc/letsencrypt/live/
```

5. Tao nginx reverse proxy cho admin/API:

```bash
sudo nano /etc/nginx/sites-available/wg-captive-admin
```

Noi dung, thay `wg2.example.com` bang domain that:

```nginx
server {
    listen 80;
    server_name wg2.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host:51822$request_uri;
    }
}

server {
    listen 51822 ssl http2;
    server_name wg2.example.com;

    ssl_certificate /etc/letsencrypt/live/wg2.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wg2.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:51824;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

6. Bat site va reload nginx:

```bash
sudo ln -sf /etc/nginx/sites-available/wg-captive-admin /etc/nginx/sites-enabled/wg-captive-admin
sudo nginx -t
sudo systemctl reload nginx
```

7. Kiem tra tu dong gia han:

```bash
sudo certbot renew --dry-run
sudo systemctl list-timers | grep certbot
```

Neu dry-run hien `Congratulations, all simulated renewals succeeded` va co `certbot.timer`, cert se tu gia han. Truy cap admin bang:

```text
https://wg2.example.com:51822
```

## API v1

Frontend web admin chi giao tiep voi backend qua API `/api/v1/*`. Central server sau nay co the goi cung API nay bang header:

```http
Authorization: Bearer <API_TOKEN>
```

Neu dang truy cap web admin bang browser thi cookie login van dung duoc. Cac endpoint chinh:

```text
GET  /api/v1
GET  /api/v1/state
GET  /api/v1/clients
GET  /api/v1/clients/{ip}
DELETE /api/v1/clients/{ip}             chi xoa khi client khong con trong wg0
POST /api/v1/clients/sync               doi chieu wg0 voi SQLite
POST /api/v1/clients/{ip}/status      { "status": "active" | "disabled" }
POST /api/v1/clients/{ip}/expiry      { "expires_at": "2026-08-01T00:00:00.000Z" }
GET  /api/v1/captive-token/{token}
POST /api/v1/expiry/check
GET  /api/v1/settings
POST /api/v1/settings
GET  /api/v1/tokens
POST /api/v1/tokens                 { "name": "central" }
GET  /api/v1/tokens/{id}/copy
DELETE /api/v1/tokens/{id}
GET  /api/v1/relay
POST /api/v1/relay/action             { "action": "relay-on" }
POST /api/v1/relay/import             multipart field: relayConf
POST /api/v1/backup
POST /api/v1/restore                  multipart field: backup
POST /api/v1/sync
```

Trang frontend hien tai dung object `API_ENDPOINTS` trong `web/wg-captive-admin.js`, nen neu sau nay tach frontend rieng hoac central proxy API thi chi can doi base/path o mot cho.

## Co che auto pop-up

He dieu hanh thuong goi cac URL HTTP de kiem tra captive portal. Khi admin bam Save Settings, web admin resolve host trong `PORTAL_URL` thanh IP va ghi vao `PORTAL_IP` de firewall cho phep user bi captive mo portal HTTPS.

Khi user bi `expired` hoac `disabled`, HTTP port 80 cua user se bi `REDIRECT` trong network namespace cua container `wg-easy`, mac dinh den port `51823`. Service `wg-captive-redirect` cung chay trong namespace nay nen nhan dung IP WireGuard goc, tao token random luu vao SQLite trong bang `captive_redirect_tokens`, token het han sau 15 phut, roi tra ve:

```text
302 Location: PORTAL_URL?node=SERVER_NAME&token=RANDOM_TOKEN
```

Portal co the dung `node` de chon node API, roi goi:

```text
GET /api/v1/captive-token/RANDOM_TOKEN
Authorization: Bearer NODE_API_TOKEN
```

Node se tra ve IP, ten user, trang thai va han dung neu token con hop le. Token het han duoc don theo lich `REDIRECT_TOKEN_CLEANUP_TIMES`, mac dinh `03:20,15:20`, khong phai polling lien tuc.

`wg-captive-redirect` theo doi PID cua container. Neu `wg-easy` restart va doi network namespace, service tu thoat de systemd khoi dong lai vao namespace moi.

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
sudo systemctl status wg-captive-redirect
sudo ipset list wg_expired
sudo iptables -t nat -S WG_CAPTIVE_NAT
sudo iptables -S WG_CAPTIVE_FILTER
sudo wg-captive-agent status
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
sudo wg-captive-agent relay-disable
sudo wg-captive-agent relay-select openvpn
sudo wg-captive-agent relay-enable
# Doi ve UDP: relay-disable, relay-select wireguard, relay-enable.
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
- `PORTAL_URL` la URL public cua portal ben ngoai, vi du `https://portal.example.com`.
- `PORTAL_IP` la mot IPv4 runtime duoc web admin ghi moi khi bam Save Settings voi `PORTAL_URL`. Agent daemon khong resolve domain lien tuc. Portal nen dung mot ban ghi A DNS-only tro thang ve server; khong bat Cloudflare proxy va khong dat nhieu A record khi agent van chi luu mot IP.
- Router da cau hinh DoT van xu ly duoc bang cach chan TCP 853 khi het han.
- Web admin can quyen doc `WG_EASY_JSON` hoac docker exec vao `WG_EASY_CONTAINER`, ghi `EXPIRED_FILE`, `BACKUP_DIR` va chay `wg-captive-agent sync`.
- Auto pop-up khong the dam bao 100% tren moi OS/thiet bi, nhung day la co che dung nhat khi khong can thiep router/client.

## Transport Tam Dung

Xray tam thoi da duoc loai bo; Relay chi con WireGuard UDP va OpenVPN TCP.
Installer dung service va go route Xray cu truoc khi thay binary agent. Neu Xray
dang duoc chon, relay duoc dua ve WireGuard o trang thai tat; khong tu bat tunnel.
Profile cu trong SQLite va file JSON duoc giu lai, khong con duoc nap/chay. Backup
cu van restore duoc, nhung transport khong con ho tro se duoc dua ve trang thai tat.
