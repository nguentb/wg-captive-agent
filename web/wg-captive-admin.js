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
let syncQueue = Promise.resolve();

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
  const regex = /(?:^|[^0-9])((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?=$|[^0-9])/g;
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
    try {
      execFile(AGENT_BIN, ["sync"], { timeout: 15000 }, (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout || "").trim(), stderr: String(stderr || error?.message || "").trim() }));
    } catch (error) {
      resolve({ ok: false, stdout: "", stderr: error.message });
    }
  });
}

function queueAgentSync() {
  syncQueue = syncQueue.catch(() => {}).then(() => runAgentSync());
  return syncQueue;
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
  const sync = await queueAgentSync();
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
  return page("wg-captive", `<main class="login-shell"><form class="login-card" method="post" action="/login"><h1>WireGuard</h1><p>wg-captive admin</p>${message ? `<div class="alert">${escapeHtml(message)}</div>` : ""}<input type="password" name="password" placeholder="Admin password" autofocus><button type="submit">Login</button></form></main>`);
}

function appPage() {
  return page("wg-captive admin", `<div class="app-shell"><aside class="sidebar"><div class="sidebar-brand"><button id="sidebarToggle" class="hamburger" type="button" aria-label="Toggle sidebar"><span></span><span></span><span></span></button><strong>WireGuard Admin</strong></div><div class="side-group"><span>MANAGEMENT</span><button class="tab active" data-tab="clients">Captive</button><button class="tab" data-tab="settings">Settings</button></div><form class="logout-form" method="post" action="/logout"><button type="submit">Logout</button></form></aside><div class="main-shell"><main class="content"><section id="clientsTab"><div class="section-head"><div><h1>Captive</h1><p>Quan ly trang thai captive cua tung WireGuard client.</p></div><div class="summary-pill"><span id="clientCount">0</span> clients</div></div><div id="clientList" class="client-list"></div></section><section id="settingsTab" class="settings hidden"><div class="section-head"><div><h1>Settings</h1><p>Cau hinh portal va Telegram backup.</p></div></div><form id="settingsForm" class="settings-grid"><label>Portal IP<input name="PORTAL_IP" id="PORTAL_IP"></label><label>Server IP<input name="SERVER_PUBLIC_IP" id="SERVER_PUBLIC_IP"></label><label>Telegram bot token<input name="TELEGRAM_BOT_TOKEN" id="TELEGRAM_BOT_TOKEN"></label><label>Telegram chat ID<input name="TELEGRAM_CHAT_ID" id="TELEGRAM_CHAT_ID"></label><label class="wide">Auto backup times, comma separated HH:MM<input name="AUTO_BACKUP_TIMES" id="AUTO_BACKUP_TIMES" placeholder="02:00,14:00"></label><label class="check"><input type="checkbox" name="BLOCK_DNS" id="BLOCK_DNS"> <span>Block DNS 53</span></label><label class="check"><input type="checkbox" name="BLOCK_DOT" id="BLOCK_DOT"> <span>Block DNS-over-TLS 853</span></label><label class="check"><input type="checkbox" name="TELEGRAM_BACKUP_ENABLED" id="TELEGRAM_BACKUP_ENABLED"> <span>Send backup to Telegram</span></label><label class="check"><input type="checkbox" name="AUTO_BACKUP_ENABLED" id="AUTO_BACKUP_ENABLED"> <span>Enable auto backup</span></label><button type="submit" class="primary save-btn">Save settings</button></form><div class="backup-panel"><button id="backupBtn" class="primary">Backup now</button><form id="restoreForm" enctype="multipart/form-data"><input type="file" id="restoreFile" name="backup" accept=".tar.gz,.tgz,application/gzip"><button type="submit" class="ghost">Restore upload</button></form></div></section></main><footer class="footer">Powered by &#272;&#7841;i An VPN</footer></div></div><div id="toast"></div><script>${clientJs()}</script>`);
}
function css() { return `:root{--bg:#0b1220;--panel:#101827;--panel3:#0e1728;--line:#1e2a3d;--text:#f8fafc;--muted:#93a4bc;--blue:#2f6df6;--blue2:#1d4ed8;--green:#20c76a;--red2:#b91c1c;--shadow:0 18px 42px rgba(0,0,0,.28),0 1px 0 rgba(255,255,255,.04) inset;--shadow2:0 28px 70px rgba(0,0,0,.38),0 10px 24px rgba(2,8,23,.24);--edge:rgba(148,163,184,.14)}*{box-sizing:border-box}html,body{min-height:100%;margin:0;background:#0b1220;color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.app-shell{min-height:100vh;display:flex;background:linear-gradient(180deg,#111827 0,#0b1220 230px),linear-gradient(135deg,rgba(47,109,246,.08),transparent 45%)}.sidebar{width:260px;flex:0 0 260px;display:flex;flex-direction:column;margin:14px 0 14px 14px;border:1px solid var(--edge);border-radius:16px;background:linear-gradient(180deg,#102333,#101827 58%,#0b1220);box-shadow:0 24px 70px rgba(0,0,0,.42),0 1px 0 rgba(255,255,255,.05) inset;padding:18px;transition:width .28s cubic-bezier(.22,1,.36,1),flex-basis .28s cubic-bezier(.22,1,.36,1),height .28s cubic-bezier(.22,1,.36,1),padding .28s cubic-bezier(.22,1,.36,1),box-shadow .28s ease,transform .28s ease;will-change:width,flex-basis,height,padding}.sidebar-brand{display:flex;align-items:center;gap:14px;padding:4px 2px 18px;border-bottom:1px solid #1e3449;transition:justify-content .28s ease,border-color .22s ease,padding .28s cubic-bezier(.22,1,.36,1)}.sidebar-brand strong{font-size:20px;line-height:1;color:#fff;font-weight:900;white-space:nowrap;max-width:190px;overflow:hidden;opacity:1;transform:translateX(0);transition:max-width .24s cubic-bezier(.22,1,.36,1),opacity .16s ease,transform .22s ease}.hamburger{width:36px;display:grid;gap:5px;border:0;background:transparent;padding:7px 3px;cursor:pointer;transition:transform .16s ease}.hamburger:hover{transform:translateY(-1px)}.hamburger span{height:2px;background:#e5edf7;border-radius:999px}.hamburger:hover span{background:#33d1ff}.app-shell.sidebar-collapsed .sidebar{width:74px;flex:0 0 74px;height:74px;align-self:flex-start;padding:18px 12px;overflow:hidden}.app-shell.sidebar-collapsed .sidebar-brand{justify-content:center;gap:0;border-bottom:0;padding-bottom:0}.app-shell.sidebar-collapsed .sidebar-brand strong{max-width:0;opacity:0;visibility:hidden;pointer-events:none;transform:translateX(-10px)}.app-shell.sidebar-collapsed .side-group,.app-shell.sidebar-collapsed .logout-form{opacity:0;visibility:hidden;pointer-events:none;transform:translateX(-10px)}.side-group{display:grid;gap:8px;padding-top:22px;opacity:1;transform:translateX(0);transition:opacity .18s ease,transform .24s ease,visibility .18s ease}.side-group>span{color:#92a1b4;font-size:12px;font-weight:900;letter-spacing:2px;margin:0 0 6px 2px}.side-group>span:before{content:"";display:inline-block;width:4px;height:14px;border-radius:999px;background:#33d1ff;margin-right:12px;vertical-align:-2px}.side-group button{width:100%;border:1px solid transparent;background:transparent;color:#cbd5e1;text-align:left;border-radius:10px;padding:12px 14px;font-size:16px;font-weight:750;cursor:pointer;transition:transform .16s ease,background .16s ease,border-color .16s ease,box-shadow .16s ease}.side-group button:hover{background:#132236;color:#fff;border-color:rgba(34,211,238,.16);box-shadow:0 10px 24px rgba(0,0,0,.18);transform:translateY(-1px)}.side-group .tab.active{background:linear-gradient(135deg,rgba(34,211,238,.16),rgba(47,109,246,.1));box-shadow:inset 3px 0 0 #22d3ee,0 14px 28px rgba(8,47,73,.22);color:#e0faff;border-color:rgba(34,211,238,.22)}.logout-form{margin-top:auto;padding-top:18px;opacity:1;transform:translateX(0);transition:opacity .18s ease,transform .24s ease,visibility .18s ease}.logout-form button{width:100%;border:1px solid #26384d;background:linear-gradient(180deg,#152238,#0f1726);color:#cbd5e1;border-radius:10px;padding:12px 14px;font-size:16px;font-weight:800;text-align:left;cursor:pointer;box-shadow:0 12px 26px rgba(0,0,0,.18);transition:transform .16s ease,box-shadow .16s ease,background .16s ease,border-color .16s ease}.logout-form button:hover{background:linear-gradient(180deg,#351b26,#24111a);border-color:#7f1d1d;color:#fecaca;box-shadow:0 18px 34px rgba(127,29,29,.18);transform:translateY(-1px)}.main-shell{min-width:0;flex:1;display:flex;flex-direction:column}.primary,.ghost{border:0;border-radius:12px;padding:11px 16px;color:white;font-weight:800;font-size:14px;cursor:pointer;white-space:nowrap;transition:transform .16s ease,box-shadow .16s ease,background .16s ease}.primary{background:linear-gradient(180deg,#3b7bff,var(--blue));box-shadow:0 16px 32px rgba(47,109,246,.28),0 1px 0 rgba(255,255,255,.2) inset}.primary:hover{background:linear-gradient(180deg,#2f6df6,var(--blue2));box-shadow:0 22px 42px rgba(47,109,246,.34);transform:translateY(-1px)}.ghost{background:linear-gradient(180deg,#46546a,#323d50);color:#fff;box-shadow:0 12px 26px rgba(0,0,0,.2),0 1px 0 rgba(255,255,255,.08) inset}.ghost:hover{background:linear-gradient(180deg,#53627a,#3b465c);box-shadow:0 18px 34px rgba(0,0,0,.28);transform:translateY(-1px)}.content{width:100%;max-width:1080px;margin:0 auto;padding:22px 20px 26px;flex:1}.section-head{display:flex;align-items:end;justify-content:space-between;gap:16px;margin:0 0 14px}.section-head h1{margin:0;font-size:26px;letter-spacing:0}.section-head p{margin:5px 0 0;color:var(--muted);font-size:14px}.summary-pill{border:1px solid var(--edge);background:linear-gradient(180deg,#122038,#0d1626);color:#dbeafe;border-radius:999px;padding:8px 12px;font-weight:800;font-size:14px;box-shadow:0 12px 28px rgba(0,0,0,.22),0 1px 0 rgba(255,255,255,.06) inset}.client-list{display:grid;gap:10px}.client-row{min-height:72px;background:linear-gradient(180deg,#121d30,#0f1828);border:1px solid var(--edge);border-radius:12px;box-shadow:var(--shadow);display:grid;grid-template-columns:minmax(180px,1fr) 150px 64px;align-items:center;gap:14px;padding:13px 16px;position:relative;transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease,background .18s ease}.client-row:hover{transform:translateY(-3px);border-color:rgba(59,130,246,.36);box-shadow:var(--shadow2);background:linear-gradient(180deg,#15243a,#101b2d)}.name{font-size:19px;font-weight:900;line-height:1.05;margin-bottom:5px}.sub{display:flex;gap:12px;align-items:center;color:#9bc9ff;font-size:15px}.ip{color:#9bc9ff}.status{color:var(--muted);font-size:12px}.status strong{display:block;color:var(--text);font-size:15px;font-weight:850;margin-bottom:3px}.status.allowed strong{color:var(--green)}.status.blocked strong{color:#ff6b6b}.avatar-wrap,.avatar,.dot{display:none}.switch{justify-self:end;position:relative;display:inline-block;width:58px;height:31px}.switch input{display:none}.slider{position:absolute;inset:0;border-radius:999px;background:#334155;transition:.18s;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08),0 10px 20px rgba(0,0,0,.22)}.slider:before{content:"";position:absolute;width:23px;height:23px;right:4px;top:4px;background:white;border-radius:50%;transition:.18s;box-shadow:0 4px 14px rgba(0,0,0,.34)}.switch input:checked+.slider{background:var(--green)}.switch input:not(:checked)+.slider{background:var(--red2)}.switch input:not(:checked)+.slider:before{right:31px}.switch.is-pending{pointer-events:none}.switch input:disabled+.slider{opacity:.55;cursor:wait}.empty{padding:30px 20px;background:linear-gradient(180deg,#121d30,#0f1828);border:1px solid var(--edge);border-radius:12px;color:var(--muted);text-align:center;box-shadow:var(--shadow)}.hidden{display:none}.settings{background:linear-gradient(180deg,#111c2f,#0d1728);border:1px solid var(--edge);border-radius:14px;box-shadow:var(--shadow2);padding:20px}.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.settings label{display:grid;gap:7px;color:#c7d2e2;font-size:12px;font-weight:800}.settings input{border:1px solid #263449;background:linear-gradient(180deg,#0c1627,#08111f);color:var(--text);border-radius:10px;padding:11px 12px;font:inherit;min-width:0;box-shadow:inset 0 2px 8px rgba(0,0,0,.24);transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}.settings input:focus{outline:2px solid rgba(47,109,246,.45);border-color:#3b82f6;box-shadow:inset 0 2px 8px rgba(0,0,0,.24),0 0 0 4px rgba(47,109,246,.12)}.settings .check{display:flex;align-items:center;gap:9px;background:linear-gradient(180deg,#0d1829,#091221);border:1px solid #263449;border-radius:10px;padding:11px 12px;box-shadow:0 10px 22px rgba(0,0,0,.14);transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease}.settings .check:hover{transform:translateY(-1px);border-color:rgba(59,130,246,.32);box-shadow:0 16px 30px rgba(0,0,0,.22)}.settings .check input{width:16px;height:16px}.wide{grid-column:1/-1}.save-btn{justify-self:start;margin-top:2px}.backup-panel{display:flex;align-items:center;gap:10px;margin-top:16px;flex-wrap:wrap}.backup-panel form{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.backup-panel input[type=file]{color:var(--muted);max-width:100%}.footer{padding:12px 16px;color:#7890bc;text-align:center;font-size:15px;border-top:1px solid rgba(30,42,61,.45);background:#0b1220}#toast{position:fixed;right:20px;bottom:20px;max-width:340px;padding:12px 14px;border-radius:10px;background:#e5e7eb;color:#0f172a;opacity:0;transform:translateY(10px);transition:.18s ease;font-weight:750;z-index:20}#toast.show{opacity:1;transform:translateY(0)}.login-shell{min-height:100vh;display:grid;place-items:center;padding:18px;background:linear-gradient(180deg,#111827,#0b1220)}.login-card{width:min(380px,calc(100vw - 28px));background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:24px;box-shadow:var(--shadow)}.login-card h1{font-size:30px;margin:0 0 3px}.login-card p{color:var(--muted);margin:0 0 10px}.login-card input,.login-card button{width:100%;margin-top:12px}.login-card input{border:1px solid #263449;background:#0a1220;color:var(--text);border-radius:10px;padding:11px 12px;font:inherit}.login-card button{border:0;border-radius:12px;background:var(--blue);color:white;padding:11px 14px;font-weight:850;cursor:pointer}.alert{background:#451a1a;color:#fecaca;border-radius:10px;padding:9px 10px;margin-top:12px}@media(max-width:820px){.app-shell{display:block}.sidebar{width:calc(100% - 20px);margin:10px 10px 0;border-radius:14px;padding:12px}.sidebar-brand{padding:2px 2px 12px}.sidebar-brand strong{font-size:20px}.hamburger{width:30px}.app-shell.sidebar-collapsed .sidebar{width:58px;height:58px;flex-basis:auto;padding:12px;overflow:hidden}.app-shell.sidebar-collapsed .sidebar-brand{justify-content:center}.side-group{padding-top:12px;grid-template-columns:1fr 1fr}.side-group>span{grid-column:1/-1}.side-group button{text-align:center;padding:11px 10px;font-size:15px}.content{padding:18px 14px 22px}.section-head{align-items:flex-start;flex-direction:column;margin-bottom:12px}.section-head h1{font-size:25px}.section-head p{font-size:14px}.client-list{gap:10px}.client-row{grid-template-columns:1fr 62px;min-height:74px;padding:14px 15px}.name{font-size:20px}.sub{font-size:15px}.status{display:none}.switch{grid-column:2;grid-row:1;width:62px;height:33px}.switch .slider:before{width:25px;height:25px}.switch input:not(:checked)+.slider:before{right:33px}.settings{padding:16px}.settings-grid{grid-template-columns:1fr}.settings label{font-size:13px}.settings input{padding:12px 13px}.primary,.ghost{padding:11px 14px;font-size:15px}.footer{font-size:14px;padding:10px 14px}.login-card{padding:22px}}`; }
function clientJs() { return `let state={clients:[],config:{}};let toggleSeq=0;const pendingToggles={};const $=(id)=>document.getElementById(id);
function initSidebar(){const shell=document.querySelector('.app-shell');const btn=$('sidebarToggle');if(!shell||!btn)return;let saved=false;try{saved=localStorage.getItem('sidebarCollapsed')==='1'}catch{}shell.classList.toggle('sidebar-collapsed',saved);btn.setAttribute('aria-expanded',String(!saved));btn.addEventListener('click',()=>{const collapsed=!shell.classList.contains('sidebar-collapsed');shell.classList.toggle('sidebar-collapsed',collapsed);btn.setAttribute('aria-expanded',String(!collapsed));try{localStorage.setItem('sidebarCollapsed',collapsed?'1':'0')}catch{}})}
function toast(message){const box=$('toast');box.textContent=message;box.classList.add('show');setTimeout(()=>box.classList.remove('show'),2200)}
async function api(path,options={}){const res=await fetch(path,{headers:{'Content-Type':'application/json',...(options.headers||{})},...options});const data=await res.json();if(!res.ok||data.ok===false)throw new Error(data.error||'Request failed');return data}
function escapeHtml(v){return String(v).replace(/[&<>"']/g,(ch)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]))}
function mergeClientResult(ip,captive,clients){const fresh=(clients||[]).find((item)=>item.ip===ip);state.clients=state.clients.map((client)=>client.ip===ip?{...client,...fresh,captive}:client)}
function renderClients(){const list=$('clientList');const clients=state.clients;const count=$('clientCount');if(count)count.textContent=clients.length;if(!clients.length){list.innerHTML='<div class="empty">No clients found in wg0.json.</div>';return}list.innerHTML=clients.map((c)=>{const pending=pendingToggles[c.ip];const checked=pending?pending.previousChecked:!c.captive;const captive=!checked;return '<div class="client-row" data-ip="'+c.ip+'"><div><div class="name">'+escapeHtml(c.name)+'</div><div class="sub"><span class="ip">'+c.ip+'</span></div></div><div class="status '+(captive?'blocked':'allowed')+'"><strong>'+(captive?'Bi khoa':'Dang hoat dong')+'</strong><span>'+(pending?'updating':(captive?'captive on':'internet open'))+'</span></div><label class="switch '+(pending?'is-pending':'')+'" title="Toggle captive"><input type="checkbox" data-ip="'+c.ip+'" '+(checked?'checked':'')+' '+(pending?'disabled':'')+'><span class="slider"></span></label></div>'}).join('')}
function renderSettings(){for(const key of ['PORTAL_IP','SERVER_PUBLIC_IP','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','AUTO_BACKUP_TIMES'])if($(key))$(key).value=state.config[key]||'';if($('TELEGRAM_BACKUP_ENABLED'))$('TELEGRAM_BACKUP_ENABLED').checked=state.config.TELEGRAM_BACKUP_ENABLED!=='0';if($('AUTO_BACKUP_ENABLED'))$('AUTO_BACKUP_ENABLED').checked=state.config.AUTO_BACKUP_ENABLED==='1';if($('BLOCK_DNS'))$('BLOCK_DNS').checked=state.config.BLOCK_DNS==='1';if($('BLOCK_DOT'))$('BLOCK_DOT').checked=state.config.BLOCK_DOT==='1'}
async function load(){const data=await api('/api/state');state=data;renderClients();renderSettings()}
function activateTab(btn){document.querySelectorAll('.tab').forEach((b)=>b.classList.remove('active'));btn.classList.add('active');$('clientsTab').classList.toggle('hidden',btn.dataset.tab!=='clients');$('settingsTab').classList.toggle('hidden',btn.dataset.tab!=='settings')}
document.querySelectorAll('.tab').forEach((btn)=>btn.addEventListener('click',()=>activateTab(btn)));
$('clientList').addEventListener('change',async(e)=>{if(!e.target.matches('input[type="checkbox"]'))return;const input=e.target;const ip=input.dataset.ip;if(pendingToggles[ip]){input.checked=pendingToggles[ip].previousChecked;return}const nextChecked=input.checked;const previousChecked=!nextChecked;const seq=++toggleSeq;pendingToggles[ip]={previousChecked,nextChecked,seq};input.checked=previousChecked;input.disabled=true;const row=input.closest('.client-row');const label=input.closest('.switch');if(label)label.classList.add('is-pending');const status=row&&row.querySelector('.status span');if(status)status.textContent='updating';try{const data=await api('/api/toggle',{method:'POST',body:JSON.stringify({ip,captive:!nextChecked})});if(!pendingToggles[ip]||pendingToggles[ip].seq!==seq)return;mergeClientResult(ip,!nextChecked,data.clients);delete pendingToggles[ip];toast(nextChecked?'Client active':'Client expired');renderClients()}catch(error){if(pendingToggles[ip]&&pendingToggles[ip].seq===seq)delete pendingToggles[ip];toast(error.message);renderClients()}});
$('settingsForm').addEventListener('submit',async(e)=>{e.preventDefault();const payload=Object.fromEntries(new FormData(e.target).entries());payload.TELEGRAM_BACKUP_ENABLED=$('TELEGRAM_BACKUP_ENABLED').checked?'1':'0';payload.AUTO_BACKUP_ENABLED=$('AUTO_BACKUP_ENABLED').checked?'1':'0';payload.BLOCK_DNS=$('BLOCK_DNS').checked?'1':'0';payload.BLOCK_DOT=$('BLOCK_DOT').checked?'1':'0';const data=await api('/api/settings',{method:'POST',body:JSON.stringify(payload)});state.config=data.config;renderSettings();toast('Settings saved')});
$('backupBtn').addEventListener('click',async()=>{await api('/api/backup',{method:'POST',body:'{}'});toast('Backup created')});
$('restoreForm').addEventListener('submit',async(e)=>{e.preventDefault();const file=$('restoreFile').files[0];if(!file){toast('Choose backup file');return}const form=new FormData();form.append('backup',file);const res=await fetch('/api/restore',{method:'POST',body:form});const data=await res.json();if(!res.ok||data.ok===false)throw new Error(data.error||'Restore failed');toast('Restore complete');await load()});
initSidebar();load().catch((error)=>toast(error.message));`; }

async function handleApi(req, res) {
  if (!isAuthenticated(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  const config = loadConfig();
  if (req.method === "GET" && req.url === "/api/state") return sendJson(res, 200, { ok: true, config, clients: loadClients(config) });
  if (req.method === "POST" && req.url === "/api/sync") return sendJson(res, 200, { ok: true, result: await queueAgentSync() });
  if (req.method === "POST" && req.url === "/api/toggle") {
    if (config.EXPIRED_URL) return sendJson(res, 400, { ok: false, error: "Expired peers are managed by EXPIRED_URL API mode" });
    const body = JSON.parse(await readBody(req) || "{}");
    const ip = String(body.ip || "").trim();
    if (!isValidIp(ip)) return sendJson(res, 400, { ok: false, error: "Invalid IP address" });
    setCaptive(config, ip, Boolean(body.captive));
    const result = await queueAgentSync();
    return sendJson(res, 200, { ok: true, clients: loadClients(config), result });
  }
  if (req.method === "POST" && req.url === "/api/settings") {
    const body = JSON.parse(await readBody(req) || "{}");
    const keys = ["PORTAL_IP","SERVER_PUBLIC_IP","BLOCK_DNS","BLOCK_DOT","TELEGRAM_BOT_TOKEN","TELEGRAM_CHAT_ID","TELEGRAM_BACKUP_ENABLED","AUTO_BACKUP_ENABLED","AUTO_BACKUP_TIMES"];
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
    if (req.method === "POST" && req.url === "/logout") {
      res.writeHead(302, { "Set-Cookie": "wg_captive_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0", Location: "/login" });
      return res.end();
    }
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





