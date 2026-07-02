#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const crypto = require("crypto");

const CONFIG_FILE = process.env.CONFIG_FILE || "/etc/wg-captive-agent.env";
const HOST = process.env.ADMIN_HOST || "0.0.0.0";
const PORT = Number(process.env.ADMIN_PORT || "51822");
const PASSWORD = process.env.ADMIN_PASSWORD || "";
const AGENT_BIN = process.env.AGENT_BIN || "/usr/local/sbin/wg-captive-agent";

let lastAutoBackupKey = "";

function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[match[1]] = value;
  }
  return env;
}

function shellValue(value) {
  if (/^[A-Za-z0-9_./,: -]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  return parseEnv(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function saveConfigPatch(patch) {
  const existing = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const seen = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(=)(.*)$/);
    if (!match || !(match[2] in patch)) return line;
    seen.add(match[2]);
    return `${match[2]}=${shellValue(String(patch[match[2]] || ""))}`;
  });
  for (const [key, value] of Object.entries(patch)) if (!seen.has(key)) next.push(`${key}=${shellValue(String(value || ""))}`);
  fs.writeFileSync(CONFIG_FILE, next.join("\n").replace(/\n*$/, "\n"));
}

function expiredFilePath(config) { return config.EXPIRED_FILE || "/etc/wg-captive-expired.txt"; }
function wgEasyFilePath(config) { return config.WG_EASY_JSON || "/etc/wireguard/wg0.json"; }
function wgEasyContainer(config) { return config.WG_EASY_CONTAINER || ""; }
function wgEasyContainerJson(config) { return config.WG_EASY_CONTAINER_JSON || "/etc/wireguard/wg0.json"; }
function backupDirPath(config) { return config.BACKUP_DIR || "/var/backups/wg-captive"; }

function compareIp(a, b) {
  const aa = a.split(".").map(Number);
  const bb = b.split(".").map(Number);
  for (let i = 0; i < 4; i += 1) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return 0;
}

function isValidIp(ip) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function firstIp(value) {
  if (value == null) return "";
  const match = String(value).match(/(?:^|[^0-9])((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?:\/\d+)?(?:$|[^0-9])/);
  return match && isValidIp(match[1]) ? match[1] : "";
}

function extractIps(text) {
  const found = new Set();
  const regex = /(?:^|[^0-9])((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?:$|[^0-9])/g;
  let match;
  while ((match = regex.exec(text))) if (isValidIp(match[1])) found.add(match[1]);
  return [...found].sort(compareIp);
}

function loadExpired(config) {
  const file = expiredFilePath(config);
  if (!fs.existsSync(file)) return [];
  return extractIps(fs.readFileSync(file, "utf8"));
}

function saveExpired(config, ips) {
  const unique = [...new Set(ips)].filter(isValidIp).sort(compareIp);
  fs.mkdirSync(path.dirname(expiredFilePath(config)), { recursive: true });
  fs.writeFileSync(expiredFilePath(config), `${unique.join("\n")}${unique.length ? "\n" : ""}`);
}

function valuesFromObjectOrArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function readWgEasyJson(config) {
  const file = wgEasyFilePath(config);
  if (wgEasyContainer(config)) {
    try {
      return execFileSync("docker", ["exec", wgEasyContainer(config), "cat", wgEasyContainerJson(config)], { encoding: "utf8", timeout: 5000 });
    } catch {
      if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
      return "";
    }
  }
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  return "";
}

function loadWgEasyClients(config) {
  const rawJson = readWgEasyJson(config);
  if (!rawJson) return [];
  let data;
  try { data = JSON.parse(rawJson); } catch { return []; }
  const rawClients = [...valuesFromObjectOrArray(data.clients), ...valuesFromObjectOrArray(data.peers)];
  const clients = [];
  for (const raw of rawClients) {
    if (!raw || typeof raw !== "object") continue;
    const ip = firstIp(raw.address || raw.ip || raw.allowedIPs || raw.allowedIps || raw.allowed_ip || raw.allowed_ip_address);
    if (!ip) continue;
    clients.push({
      name: String(raw.name || raw.username || raw.id || raw.clientId || ip),
      ip,
      enabled: raw.enabled !== false,
      updated_at: raw.updatedAt || raw.updated_at || raw.createdAt || raw.created_at || "",
      public_key: raw.publicKey || raw.public_key || "",
    });
  }
  return clients.sort((a, b) => compareIp(a.ip, b.ip));
}

function loadClients(config) {
  const expired = new Set(loadExpired(config));
  const byIp = new Map();
  for (const client of loadWgEasyClients(config)) byIp.set(client.ip, client);
  for (const ip of expired) if (!byIp.has(ip)) byIp.set(ip, { name: ip, ip, enabled: true, updated_at: "", public_key: "" });
  return [...byIp.values()].sort((a, b) => compareIp(a.ip, b.ip)).map((client) => ({ ...client, captive: expired.has(client.ip), status: expired.has(client.ip) ? "blocked" : "allowed" }));
}

function setCaptive(config, ip, captive) {
  const expired = new Set(loadExpired(config));
  if (captive) expired.add(ip); else expired.delete(ip);
  saveExpired(config, [...expired]);
}

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function runAgentSync() {
  return new Promise((resolve) => {
    execFile(AGENT_BIN, ["sync"], { timeout: 15000 }, (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() }));
  });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function createBackup(config, sendTelegram = true) {
  const backupDir = backupDirPath(config);
  fs.mkdirSync(backupDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-captive-backup-"));
  const blocked = loadExpired(config);
  const backupName = `wg-captive-${config.SERVER_NAME || os.hostname()}-${timestamp()}.tar.gz`.replace(/[^A-Za-z0-9_.-]/g, "_");
  const backupPath = path.join(backupDir, backupName);

  fs.writeFileSync(path.join(workDir, "blocked-ips"), `${blocked.join("\n")}${blocked.length ? "\n" : ""}`);
  const wg0Content = readWgEasyJson(config);
  fs.writeFileSync(path.join(workDir, "wg0"), wg0Content || "{}\n");
  const metadata = {
    server_name: config.SERVER_NAME || os.hostname(),
    server_ip: config.SERVER_PUBLIC_IP || "",
    backup_time: new Date().toISOString(),
    blocked_users: blocked.length,
    wg_easy_json: wgEasyFilePath(config),
    expired_file: expiredFilePath(config),
  };
  fs.writeFileSync(path.join(workDir, "metadata"), `${JSON.stringify(metadata, null, 2)}\n`);

  await execFilePromise("tar", ["-czf", backupPath, "-C", workDir, "blocked-ips", "metadata", "wg0"]);
  fs.rmSync(workDir, { recursive: true, force: true });

  let telegram = { ok: false, skipped: true };
  if (sendTelegram && config.TELEGRAM_BACKUP_ENABLED !== "0" && config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    telegram = await sendTelegramBackup(config, backupPath, metadata);
  }
  return { path: backupPath, metadata, telegram };
}

function sendTelegramBackup(config, filePath, metadata) {
  return new Promise((resolve) => {
    const boundary = `----wg-captive-${crypto.randomBytes(12).toString("hex")}`;
    const file = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const caption = `wg-captive backup\n${JSON.stringify(metadata, null, 2)}`;
    const parts = [];
    function field(name, value) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    field("chat_id", config.TELEGRAM_CHAT_ID);
    field("caption", caption);
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/gzip\r\n\r\n`));
    parts.push(file);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    const req = https.request({
      method: "POST",
      hostname: "api.telegram.org",
      path: `/bot${config.TELEGRAM_BOT_TOKEN}/sendDocument`,
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
      timeout: 30000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: data.slice(0, 500) }));
    });
    req.on("error", (error) => resolve({ ok: false, error: error.message }));
    req.write(body);
    req.end();
  });
}

async function restoreBackup(config, archiveBuffer) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-captive-restore-"));
  const archive = path.join(workDir, "restore.tar.gz");
  fs.writeFileSync(archive, archiveBuffer);
  await execFilePromise("tar", ["-xzf", archive, "-C", workDir]);
  const blockedFile = path.join(workDir, "blocked-ips");
  const wg0File = path.join(workDir, "wg0");
  if (fs.existsSync(blockedFile)) saveExpired(config, extractIps(fs.readFileSync(blockedFile, "utf8")));
  const restored = { blocked_ips: fs.existsSync(blockedFile), wg0_present: fs.existsSync(wg0File), wg0_restored: false };
  fs.rmSync(workDir, { recursive: true, force: true });
  const sync = await runAgentSync();
  return { ...restored, sync };
}

function parseMultipart(req, body) {
  const type = req.headers["content-type"] || "";
  const match = type.match(/boundary=(.+)$/);
  if (!match) return null;
  const boundary = Buffer.from(`--${match[1]}`);
  const chunks = [];
  let start = body.indexOf(boundary);
  while (start !== -1) {
    const next = body.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = body.slice(start + boundary.length + 2, next - 2);
    const sep = part.indexOf(Buffer.from("\r\n\r\n"));
    if (sep !== -1) {
      const headers = part.slice(0, sep).toString("utf8");
      const content = part.slice(sep + 4);
      if (/name="backup"/.test(headers)) chunks.push(content);
    }
    start = next;
  }
  return chunks[0] || null;
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => { chunks.push(chunk); size += chunk.length; if (size > 100 * 1024 * 1024) reject(new Error("Request body too large")); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 1024 * 1024) reject(new Error("Request body too large")); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const cookies = {};
  for (const item of String(req.headers.cookie || "").split(";")) {
    const index = item.indexOf("=");
    if (index === -1) continue;
    cookies[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1));
  }
  return cookies;
}

function sessionSecret() { return process.env.ADMIN_SESSION_SECRET || crypto.createHash("sha256").update(`${PASSWORD}:${CONFIG_FILE}`).digest("hex"); }
function makeSessionToken() { return crypto.createHmac("sha256", sessionSecret()).update("admin").digest("hex"); }
function isAuthenticated(req) { return !PASSWORD || parseCookies(req).wg_captive_admin === makeSessionToken(); }
function sendHtml(res, status, body) { res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(body); }
function sendJson(res, status, body) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
function redirect(res, location) { res.writeHead(302, { Location: location }); res.end(); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[char])); }

function page(title, content) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${css()}</style></head><body>${content}</body></html>`;
}

function loginPage(message = "") {
  return page("wg-captive", `<main class="login-shell"><form class="login-card" method="post" action="/login"><div class="logo-dot">8</div><h1>WireGuard</h1><p>wg-captive admin</p>${message ? `<div class="alert">${escapeHtml(message)}</div>` : ""}<input type="password" name="password" placeholder="Admin password" autofocus><button type="submit">Login</button></form></main>`);
}

function appPage() {
  return page("wg-captive admin", `<div class="shell"><header class="brand"><div class="logo-dot">8</div><h1>WireGuard</h1></header><section class="card"><div class="card-head"><h2>Clients</h2><div class="actions"><button class="tab active" data-tab="clients">Clients</button><button class="tab" data-tab="settings">Settings</button><button id="syncBtn" class="light">Sync</button></div></div><div id="clientsTab"><div id="clientList" class="client-list"></div></div><div id="settingsTab" class="settings hidden"><form id="settingsForm" class="settings-grid"><label>Portal IP<input name="PORTAL_IP" id="PORTAL_IP"></label><label>Server name<input name="SERVER_NAME" id="SERVER_NAME"></label><label>Server IP<input name="SERVER_PUBLIC_IP" id="SERVER_PUBLIC_IP"></label><label>wg0.json host path<input name="WG_EASY_JSON" id="WG_EASY_JSON"></label><label>wg-easy container<input name="WG_EASY_CONTAINER" id="WG_EASY_CONTAINER"></label><label>wg0.json container path<input name="WG_EASY_CONTAINER_JSON" id="WG_EASY_CONTAINER_JSON"></label><label>Docker DNS IP<input name="DOCKER_DNS_IP" id="DOCKER_DNS_IP"></label><label class="check"><input type="checkbox" name="BLOCK_DNS" id="BLOCK_DNS"> Block DNS 53</label><label class="check"><input type="checkbox" name="BLOCK_DOT" id="BLOCK_DOT"> Block DNS-over-TLS 853</label><label>Blocked IPs file<input name="EXPIRED_FILE" id="EXPIRED_FILE"></label><label>Backup directory<input name="BACKUP_DIR" id="BACKUP_DIR"></label><label>Telegram bot token<input name="TELEGRAM_BOT_TOKEN" id="TELEGRAM_BOT_TOKEN"></label><label>Telegram chat ID<input name="TELEGRAM_CHAT_ID" id="TELEGRAM_CHAT_ID"></label><label class="check"><input type="checkbox" name="TELEGRAM_BACKUP_ENABLED" id="TELEGRAM_BACKUP_ENABLED"> Send backup to Telegram</label><label class="check"><input type="checkbox" name="AUTO_BACKUP_ENABLED" id="AUTO_BACKUP_ENABLED"> Enable auto backup</label><label class="wide">Auto backup times, comma separated HH:MM<input name="AUTO_BACKUP_TIMES" id="AUTO_BACKUP_TIMES" placeholder="02:00,14:00"></label><button type="submit">Save settings</button></form><div class="backup-actions"><button id="backupBtn">Backup now</button><form id="restoreForm" enctype="multipart/form-data"><input type="file" id="restoreFile" name="backup" accept=".tar.gz,.tgz,application/gzip"><button type="submit" class="light">Restore upload</button></form></div><pre id="backupResult"></pre></div></section></div><div id="toast"></div><script>${clientJs()}</script>`);
}

function css() { return `:root{--bg:#f7f7f8;--card:#fff;--text:#0f172a;--muted:#8a94a6;--line:#eef0f3;--red:#a61b22;--red2:#c62830}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:1160px;margin:0 auto;padding:0 22px 42px}.brand{height:112px;display:flex;align-items:center;gap:14px}.brand h1{font-size:46px;line-height:1;margin:0;font-weight:650;color:#050505}.logo-dot{width:38px;height:38px;color:var(--red);font-weight:900;font-size:48px;line-height:28px;display:grid;place-items:center;transform:rotate(180deg)}.card{background:var(--card);border-radius:10px;box-shadow:0 1px 2px rgba(15,23,42,.04),0 10px 30px rgba(15,23,42,.06);overflow:hidden;border:1px solid #eee}.card-head{height:80px;display:flex;align-items:center;justify-content:space-between;padding:0 26px;border-bottom:1px solid var(--line)}h2{font-size:30px;margin:0;color:#050505}.actions{display:flex;gap:8px}.light,.tab{background:white;border:1px solid #e6e9ef;border-radius:5px;padding:12px 18px;font-size:16px;color:#1f2a44;cursor:pointer}.tab.active,.light:hover,.tab:hover{background:#f8fafc}.client-row{min-height:111px;display:grid;grid-template-columns:70px minmax(220px,1fr) 180px 150px 82px;align-items:center;padding:0 26px;border-bottom:1px solid var(--line)}.client-row:last-child{border-bottom:0}.avatar-wrap{position:relative;width:52px;height:52px}.avatar{width:52px;height:52px;border-radius:50%;background:#f7f8fa;display:grid;place-items:center;color:#c6ccd5}.avatar svg{width:27px;height:27px}.dot{position:absolute;right:0;bottom:1px;width:24px;height:24px;border:6px solid white;border-radius:50%;background:var(--red2)}.name{font-size:20px;margin-bottom:5px}.sub{display:flex;gap:20px;align-items:center;color:#8b95a7;font-size:14px}.ip{color:#24324a}.status{color:#8b95a7;font-size:14px}.status strong{display:block;color:#24324a;font-size:16px;font-weight:500;margin-bottom:5px}.traffic{color:#8b95a7;font-size:13px}.traffic strong{display:block;color:#58657a;font-size:15px;font-weight:500;margin-bottom:5px}.switch{justify-self:end;position:relative;display:inline-block;width:50px;height:30px}.switch input{display:none}.slider{position:absolute;inset:0;border-radius:999px;background:#cbd5e1;transition:.16s}.slider:before{content:"";position:absolute;width:22px;height:22px;right:4px;top:4px;background:white;border-radius:50%;transition:.16s;box-shadow:0 1px 2px rgba(0,0,0,.16)}.switch input:checked+.slider{background:var(--red)}.switch input:not(:checked)+.slider:before{right:24px}.empty{padding:42px 26px;color:#8b95a7;text-align:center}.hidden{display:none}.settings{padding:24px 26px}.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.settings label{display:grid;gap:6px;color:#667085;font-size:13px;font-weight:650}.settings input{border:1px solid #dde2ea;border-radius:6px;padding:11px 12px;font:inherit}.settings .check{display:flex;align-items:center;gap:10px}.settings .check input{width:auto}.wide{grid-column:1/-1}.settings button,.backup-actions button{border:0;border-radius:6px;background:var(--red);color:white;padding:12px 16px;font-weight:700;cursor:pointer}.backup-actions{display:flex;align-items:center;gap:12px;margin-top:18px;flex-wrap:wrap}.backup-actions form{display:flex;gap:10px;align-items:center}pre{margin-top:18px;min-height:90px;background:#0f172a;color:#d1fae5;border-radius:8px;padding:14px;white-space:pre-wrap;overflow:auto}#toast{position:fixed;right:22px;bottom:22px;max-width:360px;padding:12px 14px;border-radius:8px;background:#111827;color:white;opacity:0;transform:translateY(10px);transition:.18s ease}#toast.show{opacity:1;transform:translateY(0)}.login-shell{min-height:100vh;display:grid;place-items:center}.login-card{width:min(420px,calc(100vw - 32px));background:white;border:1px solid #eee;border-radius:10px;padding:28px;box-shadow:0 18px 70px rgba(15,23,42,.12)}.login-card h1{font-size:40px;margin:6px 0}.login-card p{color:var(--muted)}.login-card input,.login-card button{width:100%;margin-top:14px}.login-card input{border:1px solid #dde2ea;border-radius:6px;padding:12px 14px;font:inherit}.login-card button{border:0;border-radius:6px;background:var(--red);color:white;padding:12px 16px;font-weight:700;cursor:pointer}.alert{background:#fee2e2;color:#991b1b;border-radius:6px;padding:10px 12px;margin-top:14px}@media(max-width:800px){.brand h1{font-size:36px}.card-head{height:auto;padding:18px;align-items:flex-start;gap:12px}.client-row{grid-template-columns:58px 1fr 72px;gap:10px;padding:16px 18px}.status,.traffic{display:none}.switch{grid-column:3}.actions,.backup-actions,.backup-actions form{flex-wrap:wrap}.settings-grid{grid-template-columns:1fr}}`; }

function clientJs() { return `let state={clients:[],config:{}};const $=(id)=>document.getElementById(id);function toast(message){const box=$("toast");box.textContent=message;box.classList.add("show");setTimeout(()=>box.classList.remove("show"),2200)}async function api(path,options={}){const res=await fetch(path,{headers:{"Content-Type":"application/json",...(options.headers||{})},...options});const data=await res.json();if(!res.ok||data.ok===false)throw new Error(data.error||"Request failed");return data}function avatar(){return '<div class="avatar"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0H4Z"/></svg></div>'}function renderClients(){const list=$("clientList");const clients=state.clients;if(!clients.length){list.innerHTML='<div class="empty">No clients found in wg0.json.</div>';return}list.innerHTML=clients.map((c)=>'<div class="client-row"><div class="avatar-wrap">'+avatar()+(c.captive?'<span class="dot"></span>':'')+'</div><div><div class="name">'+escapeHtml(c.name)+'</div><div class="sub"><span class="ip">'+c.ip+'</span><span>'+(c.updated_at?timeAgo(c.updated_at):'')+'</span></div></div><div class="traffic"><strong>? 0 B/s</strong><span>captive traffic</span></div><div class="status"><strong>'+(c.captive?'Blocked':'Allowed')+'</strong><span>'+(c.captive?'captive on':'internet open')+'</span></div><label class="switch"><input type="checkbox" data-ip="'+c.ip+'" '+(c.captive?'checked':'')+'><span class="slider"></span></label></div>').join('')}function renderSettings(){for(const key of ['PORTAL_IP','SERVER_NAME','SERVER_PUBLIC_IP','WG_EASY_JSON','WG_EASY_CONTAINER','WG_EASY_CONTAINER_JSON','DOCKER_DNS_IP','EXPIRED_FILE','BACKUP_DIR','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','AUTO_BACKUP_TIMES'])if($(key))$(key).value=state.config[key]||'';$('TELEGRAM_BACKUP_ENABLED').checked=state.config.TELEGRAM_BACKUP_ENABLED!=='0';$('AUTO_BACKUP_ENABLED').checked=state.config.AUTO_BACKUP_ENABLED==='1'}function escapeHtml(v){return String(v).replace(/[&<>"']/g,(ch)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]))}function timeAgo(iso){const t=Date.parse(iso);if(!t)return '';const diff=Math.max(0,Date.now()-t);const s=Math.floor(diff/1000);if(s<60)return s+' seconds ago';const m=Math.floor(s/60);if(m<60)return m+' minutes ago';const h=Math.floor(m/60);if(h<24)return h+' hours ago';return Math.floor(h/24)+' days ago'}async function load(){const data=await api('/api/state');state=data;renderClients();renderSettings()}document.querySelectorAll('.tab').forEach((btn)=>btn.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach((b)=>b.classList.remove('active'));btn.classList.add('active');$('clientsTab').classList.toggle('hidden',btn.dataset.tab!=='clients');$('settingsTab').classList.toggle('hidden',btn.dataset.tab!=='settings')}));$('clientList').addEventListener('change',async(e)=>{if(!e.target.matches('input[type="checkbox"]'))return;await api('/api/toggle',{method:'POST',body:JSON.stringify({ip:e.target.dataset.ip,captive:e.target.checked})});toast(e.target.checked?'Captive enabled':'Captive disabled');await load()});$('syncBtn').addEventListener('click',async()=>{const data=await api('/api/sync',{method:'POST',body:'{}'});toast(data.result&&data.result.ok?'Firewall synced':'Sync warning');await load()});$('settingsForm').addEventListener('submit',async(e)=>{e.preventDefault();const payload=Object.fromEntries(new FormData(e.target).entries());payload.TELEGRAM_BACKUP_ENABLED=$('TELEGRAM_BACKUP_ENABLED').checked?'1':'0';payload.AUTO_BACKUP_ENABLED=$('AUTO_BACKUP_ENABLED').checked?'1':'0';const data=await api('/api/settings',{method:'POST',body:JSON.stringify(payload)});state.config=data.config;renderSettings();toast('Settings saved')});$('backupBtn').addEventListener('click',async()=>{const data=await api('/api/backup',{method:'POST',body:'{}'});$('backupResult').textContent=JSON.stringify(data.backup,null,2);toast('Backup created')});$('restoreForm').addEventListener('submit',async(e)=>{e.preventDefault();const file=$('restoreFile').files[0];if(!file){toast('Choose backup file');return}const form=new FormData();form.append('backup',file);const res=await fetch('/api/restore',{method:'POST',body:form});const data=await res.json();if(!res.ok||data.ok===false)throw new Error(data.error||'Restore failed');$('backupResult').textContent=JSON.stringify(data,null,2);toast('Restore complete');await load()});load().catch((error)=>toast(error.message));`; }

async function handleApi(req, res) {
  if (!isAuthenticated(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  const config = loadConfig();
  if (req.method === "GET" && req.url === "/api/state") return sendJson(res, 200, { ok: true, config, clients: loadClients(config) });
  if (req.method === "POST" && req.url === "/api/sync") return sendJson(res, 200, { ok: true, result: await runAgentSync() });
  if (req.method === "POST" && req.url === "/api/toggle") {
    if (config.EXPIRED_URL) return sendJson(res, 400, { ok: false, error: "Expired peers are managed by EXPIRED_URL API mode" });
    const body = JSON.parse(await readBody(req) || "{}");
    const ip = String(body.ip || "").trim();
    if (!isValidIp(ip)) return sendJson(res, 400, { ok: false, error: "Invalid IP address" });
    setCaptive(config, ip, Boolean(body.captive));
    const result = await runAgentSync();
    return sendJson(res, 200, { ok: true, clients: loadClients(config), result });
  }
  if (req.method === "POST" && req.url === "/api/settings") {
    const body = JSON.parse(await readBody(req) || "{}");
    const keys = ["PORTAL_IP","SERVER_NAME","SERVER_PUBLIC_IP","WG_EASY_JSON","WG_EASY_CONTAINER","WG_EASY_CONTAINER_JSON","DOCKER_DNS_IP","BLOCK_DNS","BLOCK_DOT","EXPIRED_FILE","BACKUP_DIR","TELEGRAM_BOT_TOKEN","TELEGRAM_CHAT_ID","TELEGRAM_BACKUP_ENABLED","AUTO_BACKUP_ENABLED","AUTO_BACKUP_TIMES"];
    const patch = {};
    for (const key of keys) if (body[key] !== undefined) patch[key] = String(body[key]).trim();
    saveConfigPatch(patch);
    return sendJson(res, 200, { ok: true, config: loadConfig() });
  }
  if (req.method === "POST" && req.url === "/api/backup") return sendJson(res, 200, { ok: true, backup: await createBackup(config, true) });
  if (req.method === "POST" && req.url === "/api/restore") {
    const body = await readBodyBuffer(req);
    const file = parseMultipart(req, body);
    if (!file) return sendJson(res, 400, { ok: false, error: "Missing backup file" });
    return sendJson(res, 200, { ok: true, result: await restoreBackup(config, file) });
  }
  return sendJson(res, 404, { ok: false, error: "Not found" });
}

async function handle(req, res) {
  try {
    if (req.url.startsWith("/api/")) return handleApi(req, res);
    if (req.method === "GET" && req.url === "/login") return sendHtml(res, 200, loginPage());
    if (req.method === "POST" && req.url === "/login") {
      const params = new URLSearchParams(await readBody(req));
      if (String(params.get("password") || "") !== PASSWORD) return sendHtml(res, 401, loginPage("Wrong password"));
      res.writeHead(302, { "Set-Cookie": `wg_captive_admin=${makeSessionToken()}; HttpOnly; SameSite=Lax; Path=/`, Location: "/" });
      return res.end();
    }
    if (!isAuthenticated(req)) return redirect(res, "/login");
    if (req.method === "GET" && req.url === "/") return sendHtml(res, 200, appPage());
    return sendHtml(res, 404, "Not found");
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error.message, stderr: error.stderr ? String(error.stderr) : undefined });
  }
}

function tickAutoBackup() {
  const config = loadConfig();
  if (config.AUTO_BACKUP_ENABLED !== "1") return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const times = String(config.AUTO_BACKUP_TIMES || "").split(",").map((item) => item.trim()).filter(Boolean);
  const key = `${now.toISOString().slice(0, 10)} ${hhmm}`;
  if (!times.includes(hhmm) || lastAutoBackupKey === key) return;
  lastAutoBackupKey = key;
  createBackup(config, true).catch((error) => console.error("auto backup failed", error.message));
}

http.createServer(handle).listen(PORT, HOST, () => {
  console.log(`wg-captive-admin listening on http://${HOST}:${PORT}`);
  setInterval(tickAutoBackup, 30000).unref();
});





