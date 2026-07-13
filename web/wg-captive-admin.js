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
let expiryCheckTimer = null;
let syncQueue = Promise.resolve();
let dbInitPath = "";

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

function loadEnvConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  return parseEnv(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function stateDbPath(config = {}) { return config.STATE_DB || "/etc/wg-captive-agent.db"; }

function sqlQuote(value) {
  if (value === null || value === undefined) return "NULL";
  return '\'' + String(value).replace(/'/g, "''") + '\'';
}

function sqliteRaw(config, sql) {
  const db = stateDbPath(config);
  fs.mkdirSync(path.dirname(db), { recursive: true });
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8", timeout: 5000 });
}

function sqliteRows(config, sql) {
  const db = stateDbPath(config);
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const out = execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8", timeout: 5000 }).trim();
  return out ? JSON.parse(out) : [];
}

function dbAvailable(config) {
  try {
    execFileSync("sqlite3", ["-version"], { encoding: "utf8", timeout: 2000 });
    initDb(config);
    return true;
  } catch {
    return false;
  }
}

function initDb(config) {
  const db = stateDbPath(config);
  if (dbInitPath === db) return;
  sqliteRaw(config, `
CREATE TABLE IF NOT EXISTS client_state (
  ip TEXT PRIMARY KEY,
  name TEXT,
  public_key TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  expired_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_client_state_disabled ON client_state(disabled);
CREATE INDEX IF NOT EXISTS idx_client_state_expires_at ON client_state(expires_at);
CREATE INDEX IF NOT EXISTS idx_client_state_expired_at ON client_state(expired_at);
CREATE TABLE IF NOT EXISTS node_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS relay_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  exit_if TEXT NOT NULL DEFAULT 'wg-exit',
  client_subnet TEXT NOT NULL DEFAULT '10.8.0.0/24',
  route_table INTEGER NOT NULL DEFAULT 200,
  exit_conf_path TEXT NOT NULL DEFAULT '/etc/wg-captive-relay-exit.conf',
  exit_conf TEXT,
  imported_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO relay_config(id) VALUES(1);
`);
  ensureDbColumn(config, "client_state", "expired_at", "TEXT");
  dbInitPath = db;
}

function ensureDbColumn(config, table, column, type) {
  const exists = sqliteRows(config, `PRAGMA table_info(${table})`).some((row) => row.name === column);
  if (!exists) sqliteRaw(config, `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function dbGetNodeConfig(config) {
  if (!dbAvailable(config)) return {};
  const rows = sqliteRows(config, "SELECT key, value FROM node_config");
  return Object.fromEntries(rows.map((row) => [row.key, row.value || ""]));
}

function dbGetRelayConfig(config) {
  if (!dbAvailable(config)) return {};
  const rows = sqliteRows(config, "SELECT enabled, exit_if, client_subnet, route_table, exit_conf_path, imported_at FROM relay_config WHERE id = 1");
  return rows[0] || {};
}

function dbSetNodeConfig(config, patch) {
  if (!dbAvailable(config)) return false;
  const statements = Object.entries(patch).map(([key, value]) => (
    `INSERT INTO node_config(key,value,updated_at) VALUES(${sqlQuote(key)},${sqlQuote(value)},CURRENT_TIMESTAMP) ` +
    `ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`
  ));
  if (statements.length) sqliteRaw(config, statements.join(";\n"));
  return true;
}

function loadConfig() {
  const env = loadEnvConfig();
  const config = { ...env };
  try {
    initDb(config);
    Object.assign(config, dbGetNodeConfig(config));
    const relay = dbGetRelayConfig(config);
    if (Object.keys(relay).length) {
      config.RELAY_ENABLED = String(relay.enabled ? 1 : 0);
      config.RELAY_EXIT_IF = relay.exit_if || config.RELAY_EXIT_IF || "wg-exit";
      config.RELAY_CLIENT_SUBNET = relay.client_subnet || config.RELAY_CLIENT_SUBNET || "10.8.0.0/24";
      config.RELAY_ROUTE_TABLE = String(relay.route_table || config.RELAY_ROUTE_TABLE || "200");
      config.RELAY_EXIT_CONF = relay.exit_conf_path || config.RELAY_EXIT_CONF || "/etc/wg-captive-relay-exit.conf";
      config.RELAY_UPDATED_AT = relay.imported_at || "";
    }
  } catch {}
  return config;
}

function saveConfigPatch(patch) {
  const config = loadEnvConfig();
  const relayPatch = {};
  const nodePatch = { ...patch };
  if ("RELAY_CLIENT_SUBNET" in nodePatch) {
    relayPatch.client_subnet = nodePatch.RELAY_CLIENT_SUBNET;
    delete nodePatch.RELAY_CLIENT_SUBNET;
  }
  if ("RELAY_ENABLED" in nodePatch) {
    relayPatch.enabled = nodePatch.RELAY_ENABLED === "1" ? 1 : 0;
    delete nodePatch.RELAY_ENABLED;
  }
  if ("RELAY_EXIT_CONF" in nodePatch) {
    relayPatch.exit_conf_path = nodePatch.RELAY_EXIT_CONF;
    delete nodePatch.RELAY_EXIT_CONF;
  }
  if (dbAvailable(config)) {
    dbSetNodeConfig(config, nodePatch);
    const assignments = [];
    if ("enabled" in relayPatch) assignments.push(`enabled=${Number(relayPatch.enabled) ? 1 : 0}`);
    if ("client_subnet" in relayPatch) assignments.push(`client_subnet=${sqlQuote(relayPatch.client_subnet || "10.8.0.0/24")}`);
    if ("exit_conf_path" in relayPatch) assignments.push(`exit_conf_path=${sqlQuote(relayPatch.exit_conf_path || "/etc/wg-captive-relay-exit.conf")}`);
    if (assignments.length) sqliteRaw(config, `UPDATE relay_config SET ${assignments.join(", ")}, updated_at=CURRENT_TIMESTAMP WHERE id=1`);
    return;
  }
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
function relayConfPath(config) { return config.RELAY_EXIT_CONF || "/etc/wg-captive-relay-exit.conf"; }

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

function dbUpsertClient(config, client) {
  if (!dbAvailable(config) || !isValidIp(client.ip)) return false;
  sqliteRaw(config,
    `INSERT INTO client_state(ip,name,public_key,updated_at) VALUES(${sqlQuote(client.ip)},${sqlQuote(client.name || client.ip)},${sqlQuote(client.public_key || "")},CURRENT_TIMESTAMP) ` +
    `ON CONFLICT(ip) DO UPDATE SET name=excluded.name, public_key=excluded.public_key, updated_at=CURRENT_TIMESTAMP`
  );
  return true;
}

function dbSetClientDisabled(config, ip, disabled) {
  if (!dbAvailable(config) || !isValidIp(ip)) return false;
  sqliteRaw(config,
    `INSERT INTO client_state(ip,name,disabled,updated_at) VALUES(${sqlQuote(ip)},${sqlQuote(ip)},${disabled ? 1 : 0},CURRENT_TIMESTAMP) ` +
    `ON CONFLICT(ip) DO UPDATE SET disabled=excluded.disabled, updated_at=CURRENT_TIMESTAMP`
  );
  return true;
}

function dbSetClientExpiry(config, ip, name, expiresAt) {
  if (!dbAvailable(config) || !isValidIp(ip)) return false;
  sqliteRaw(config,
    `INSERT INTO client_state(ip,name,expires_at,expired_at,updated_at) VALUES(${sqlQuote(ip)},${sqlQuote(name || ip)},${sqlQuote(expiresAt)},NULL,CURRENT_TIMESTAMP) ` +
    `ON CONFLICT(ip) DO UPDATE SET name=COALESCE(NULLIF(excluded.name,''),client_state.name), expires_at=excluded.expires_at, expired_at=CASE WHEN datetime(excluded.expires_at) > datetime('now') THEN NULL ELSE client_state.expired_at END, updated_at=CURRENT_TIMESTAMP`
  );
  return true;
}

function loadDisabled(config) {
  if (!dbAvailable(config)) return [];
  return sqliteRows(config, "SELECT ip FROM client_state WHERE disabled=1 ORDER BY ip").map((row) => row.ip).filter(isValidIp);
}

function expiryIsPast(value) {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() <= Date.now();
}

function blockedState(config) {
  const disabled = new Set(loadDisabled(config));
  const expiry = loadExpiry(config);
  const expired = new Set(Object.entries(expiry).filter(([, item]) => item?.expired_at).map(([ip]) => ip).filter(isValidIp));
  const blocked = [...new Set([...disabled, ...expired])].filter(isValidIp).sort(compareIp);
  saveExpired(config, blocked);
  return { disabled, expired, blocked: new Set(blocked), expiry };
}
function loadExpiry(config) {
  if (!dbAvailable(config)) return {};
  const rows = sqliteRows(config, "SELECT ip, name, expires_at, expired_at, updated_at FROM client_state WHERE expires_at IS NOT NULL AND expires_at != '' ORDER BY ip");
  return Object.fromEntries(rows.filter((row) => isValidIp(row.ip)).map((row) => [row.ip, { name: row.name || row.ip, expires_at: row.expires_at || "", expired_at: row.expired_at || "", updated_at: row.updated_at || "" }]));
}

function setClientExpiry(config, ip, expiresAt) {
  if (!isValidIp(ip)) throw new Error("Invalid IP address");
  const when = new Date(expiresAt);
  if (!Number.isFinite(when.getTime())) throw new Error("Invalid expiry time");
  const clients = loadClients(config);
  const client = clients.find((item) => item.ip === ip) || { name: ip };
  const item = { name: client.name || ip, expires_at: when.toISOString(), updated_at: new Date().toISOString() };
  if (!dbSetClientExpiry(config, ip, item.name, item.expires_at)) throw new Error("SQLite database is required");
  blockedState(config);
  return item;
}

function addMonths(date, months) {
  const next = new Date(date.getTime());
  const day = next.getDate();
  next.setMonth(next.getMonth() + months, 1);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
}

function extendClientExpiry(config, ip, months) {
  const count = Number(months);
  if (!Number.isInteger(count) || count <= 0 || count > 120) throw new Error("Invalid extension months");
  const expiry = loadExpiry(config);
  const current = expiry[ip]?.expires_at ? new Date(expiry[ip].expires_at) : null;
  const base = current && Number.isFinite(current.getTime()) && current.getTime() > Date.now() ? current : new Date();
  return setClientExpiry(config, ip, addMonths(base, count).toISOString());
}

function markExpiredClients(config) {
  if (!dbAvailable(config)) throw new Error("SQLite database is required");
  const now = new Date().toISOString();
  const newlyExpired = sqliteRows(config,
    "SELECT ip, name, expires_at FROM client_state " +
    "WHERE expires_at IS NOT NULL AND expires_at != '' " +
    "AND datetime(expires_at) <= datetime('now') " +
    "AND (expired_at IS NULL OR expired_at = '') ORDER BY ip"
  ).filter((row) => isValidIp(row.ip));
  if (newlyExpired.length) {
    sqliteRaw(config,
      `UPDATE client_state SET expired_at=${sqlQuote(now)}, updated_at=CURRENT_TIMESTAMP ` +
      "WHERE expires_at IS NOT NULL AND expires_at != '' " +
      "AND datetime(expires_at) <= datetime('now') " +
      "AND (expired_at IS NULL OR expired_at = '')"
    );
  }
  const state = blockedState(config);
  return { checked_at: now, newly_expired: newlyExpired, blocked_users: state.blocked.size };
}

async function runExpiryCheck(config = loadConfig()) {
  const result = markExpiredClients(config);
  result.sync = await queueAgentSync();
  return result;
}

function scheduleTimes(value, fallback) {
  const items = String(value || fallback).split(",").map((item) => item.trim()).filter(Boolean);
  return items.filter((item) => /^\d{2}:\d{2}$/.test(item));
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

function readWgEasyConf(config) {
  const file = wgEasyConfPath(config);
  if (wgEasyContainer(config)) {
    try {
      return execFileSync("docker", ["exec", wgEasyContainer(config), "cat", wgEasyContainerConf(config)], { encoding: "utf8", timeout: 5000 });
    } catch {
      if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
      return "";
    }
  }
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  return "";
}

function loadWgConfClients(config) {
  const text = readWgEasyConf(config);
  if (!text) return [];
  const clients = [];
  let peer = null;
  let lastComment = "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      lastComment = trimmed.replace(/^#+\s*/, "").trim();
      continue;
    }
    if (/^\[Peer\]$/i.test(trimmed)) {
      if (peer?.ip) clients.push(peer);
      peer = { name: lastComment || "", ip: "", enabled: true, updated_at: "", public_key: "" };
      lastComment = "";
      continue;
    }
    if (!peer) continue;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (key === "publickey") peer.public_key = value;
    if (key === "allowedips") peer.ip = firstIp(value);
  }
  if (peer?.ip) clients.push(peer);
  return clients.map((client) => ({ ...client, name: client.name || client.ip })).filter((client) => isValidIp(client.ip)).sort((a, b) => compareIp(a.ip, b.ip));
}

function loadWgEasyClients(config) {
  const rawJson = readWgEasyJson(config);
  if (!rawJson) return loadWgConfClients(config);
  let data;
  try { data = JSON.parse(rawJson); } catch { return loadWgConfClients(config); }
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

function syncWgEasyClientsToDb(config) {
  const clients = loadWgEasyClients(config);
  if (!clients.length || !dbAvailable(config)) return clients;
  const statements = clients.map((client) => (
    `INSERT INTO client_state(ip,name,public_key,updated_at) VALUES(${sqlQuote(client.ip)},${sqlQuote(client.name || client.ip)},${sqlQuote(client.public_key || "")},CURRENT_TIMESTAMP) ` +
    `ON CONFLICT(ip) DO UPDATE SET name=excluded.name, public_key=excluded.public_key, updated_at=CURRENT_TIMESTAMP`
  ));
  if (statements.length) sqliteRaw(config, statements.join(";\n"));
  return clients;
}

function loadDbClients(config) {
  if (!dbAvailable(config)) return [];
  return sqliteRows(config, "SELECT ip, name, public_key, disabled, expires_at, updated_at FROM client_state ORDER BY ip").filter((row) => isValidIp(row.ip));
}

function loadClients(config) {
  const wgClients = syncWgEasyClientsToDb(config);
  const state = blockedState(config);
  const byIp = new Map();
  const dbClients = loadDbClients(config);
  if (dbClients.length) {
    for (const row of dbClients) byIp.set(row.ip, { name: row.name || row.ip, ip: row.ip, enabled: true, updated_at: row.updated_at || "", public_key: row.public_key || "" });
  } else {
    for (const client of wgClients) byIp.set(client.ip, client);
  }
  for (const ip of state.blocked) if (!byIp.has(ip)) byIp.set(ip, { name: ip, ip, enabled: true, updated_at: "", public_key: "" });
  for (const ip of Object.keys(state.expiry)) if (isValidIp(ip) && !byIp.has(ip)) byIp.set(ip, { name: state.expiry[ip]?.name || ip, ip, enabled: true, updated_at: "", public_key: "" });
  return [...byIp.values()].sort((a, b) => compareIp(a.ip, b.ip)).map((client) => {
    const item = state.expiry[client.ip] || {};
    const disabled = state.disabled.has(client.ip);
    const expired = state.expired.has(client.ip);
    const status = disabled ? "disabled" : (expired ? "expired" : "active");
    return { ...client, expires_at: item.expires_at || "", expired_at: item.expired_at || "", captive: status !== "active", disabled, expired, status };
  });
}

function setCaptive(config, ip, captive) {
  if (!dbSetClientDisabled(config, ip, Boolean(captive))) throw new Error("SQLite database is required");
  blockedState(config);
}
function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        const cleanError = String(stderr || error.message || "Command failed").trim();
        if (cleanError) error.message = cleanError.replace(/^wg-captive-agent:\s*/i, "");
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
  const state = blockedState(config);
  const blocked = [...state.blocked].sort(compareIp);
  const disabled = [...state.disabled].sort(compareIp);
  const expiredUsers = [...state.expired].sort(compareIp);
  const backupName = `wg-captive-${config.SERVER_NAME || os.hostname()}-${timestamp()}.tar.gz`.replace(/[^A-Za-z0-9_.-]/g, "_");
  const backupPath = path.join(backupDir, backupName);

  fs.writeFileSync(path.join(workDir, "blocked-ips"), `${blocked.join("\n")}${blocked.length ? "\n" : ""}`);
  const wg0Content = readWgEasyJson(config);
  fs.writeFileSync(path.join(workDir, "wg0"), wg0Content || "{}\n");
  const dbPath = stateDbPath(config);
  const dbBackupName = "state-db";
  if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, path.join(workDir, dbBackupName));
  const metadata = {
    server_name: config.SERVER_NAME || os.hostname(),
    server_ip: config.SERVER_PUBLIC_IP || "",
    backup_time: new Date().toISOString(),
    blocked_users: blocked.length,
    disabled_users: disabled.length,
    expired_users: expiredUsers.length,
    wg_easy_json: wgEasyFilePath(config),
    expired_file: expiredFilePath(config),
    state_db: stateDbPath(config),
  };
  fs.writeFileSync(path.join(workDir, "metadata"), `${JSON.stringify(metadata, null, 2)}\n`);

  const backupFiles = ["blocked-ips", "metadata", "wg0"];
  if (fs.existsSync(path.join(workDir, "state-db"))) backupFiles.push("state-db");
  await execFilePromise("tar", ["-czf", backupPath, "-C", workDir, ...backupFiles]);
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
  const stateDbFile = path.join(workDir, "state-db");
  if (!fs.existsSync(stateDbFile)) throw new Error("Backup does not contain SQLite state-db");
  const dbPath = stateDbPath(config);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(stateDbFile, dbPath);
  dbInitPath = "";
  blockedState(config);
  const restored = { state_db: true, blocked_ips: fs.existsSync(blockedFile), wg0_present: fs.existsSync(wg0File), wg0_restored: false };
  fs.rmSync(workDir, { recursive: true, force: true });
  const sync = await queueAgentSync();
  return { ...restored, sync };
}
function normalizeWireGuardConfig(content) {
  let text = content.toString("utf8").trim();
  if (text.includes("\\n")) text = text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  const lines = text.split(/\r?\n/);
  const result = [];
  let inInterface = false;
  let tableFound = false;
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped === "[Interface]") {
      inInterface = true;
      tableFound = false;
      result.push(line);
      continue;
    }
    if (stripped === "[Peer]") {
      if (inInterface && !tableFound) result.push("Table = off");
      inInterface = false;
      result.push(line);
      continue;
    }
    if (inInterface && stripped.toLowerCase().startsWith("table")) {
      result.push("Table = off");
      tableFound = true;
      continue;
    }
    result.push(line);
  }
  if (inInterface && !tableFound) result.push("Table = off");
  return `${result.join("\n").trim()}\n`;
}

function dbRelayFull(config) {
  if (!dbAvailable(config)) return null;
  return sqliteRows(config, "SELECT enabled, exit_if, client_subnet, route_table, exit_conf_path, exit_conf, imported_at FROM relay_config WHERE id=1")[0] || null;
}

function saveRelayConfigFile(config, content) {
  const file = relayConfPath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

function dbSetRelayExitConfig(config, file, content) {
  if (!dbAvailable(config)) return false;
  sqliteRaw(config, `UPDATE relay_config SET exit_conf_path=${sqlQuote(file)}, exit_conf=${sqlQuote(content)}, imported_at=${sqlQuote(new Date().toISOString())}, updated_at=CURRENT_TIMESTAMP WHERE id=1`);
  return true;
}

function dbClearRelayExitConfig(config) {
  if (!dbAvailable(config)) return false;
  sqliteRaw(config, "UPDATE relay_config SET enabled=0, exit_conf=NULL, imported_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=1");
  return true;
}

function relayStatus(config) {
  const relay = dbRelayFull(config);
  const file = relay?.exit_conf_path || relayConfPath(config);
  const imported = Boolean(relay?.exit_conf) || fs.existsSync(file);
  let status = "";
  let exitConfig = relay?.exit_conf || "";
  try {
    if (!exitConfig && fs.existsSync(file)) exitConfig = fs.readFileSync(file, "utf8");
    if (exitConfig && !fs.existsSync(file)) saveRelayConfigFile({ ...config, RELAY_EXIT_CONF: file }, exitConfig);
  } catch (error) {
    exitConfig = `Failed to read exit config: ${error.message}`;
  }
  try {
    if (fs.existsSync(AGENT_BIN)) status = execFileSync(AGENT_BIN, ["relay-status"], { encoding: "utf8", timeout: 5000 });
  } catch (error) {
    status = String(error.stderr || error.stdout || error.message || "").trim();
  }
  const tunnelUp = /tunnel:\s*UP/i.test(status);
  const routeEnabled = /route:\s*ENABLED/i.test(status) || config.RELAY_ENABLED === "1";
  return { enabled: routeEnabled, route_enabled: routeEnabled, tunnel_up: tunnelUp, conf_path: file, imported, updated_at: relay?.imported_at || config.RELAY_UPDATED_AT || "", exit_config: exitConfig, status };
}

function runRelayAction(action) {
  const allowed = new Set(["relay-enable", "relay-disable", "relay-delete-config", "relay-tunnel-up", "relay-tunnel-down", "relay-restart", "relay-on", "relay-off", "relay-restore"]);
  if (!allowed.has(action)) throw new Error("Invalid relay action");
  return execFilePromise(AGENT_BIN, [action]);
}

async function applyRelayEnabled(enabled) {
  const result = await runRelayAction(enabled ? "relay-on" : "relay-off");
  saveConfigPatch({ RELAY_ENABLED: enabled ? "1" : "0" });
  return result;
}

async function importRelayConf(config, content) {
  const text = normalizeWireGuardConfig(content);
  if (!text || !/^\s*\[Interface\]/m.test(text) || !/^\s*\[Peer\]/m.test(text)) throw new Error("Invalid WireGuard .conf file");
  const file = saveRelayConfigFile(config, text);
  dbSetRelayExitConfig(config, file, text);
  const nextConfig = loadConfig();
  if (nextConfig.RELAY_ENABLED === "1") await runRelayAction("relay-restart");
  return relayStatus(loadConfig());
}
function parseMultipart(req, body, fieldName = "backup") {
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
      if (headers.includes(`name="${fieldName}"`)) chunks.push(content);
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
function bearerToken(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}
function isApiAuthenticated(req, config) {
  const token = config.ADMIN_API_TOKEN || process.env.ADMIN_API_TOKEN || "";
  if (token && bearerToken(req) === token) return true;
  return isAuthenticated(req);
}
function noStoreHeaders(extra = {}) { return { "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate", Pragma: "no-cache", Expires: "0", ...extra }; }
function sendHtml(res, status, body) { res.writeHead(status, noStoreHeaders({ "Content-Type": "text/html; charset=utf-8" })); res.end(body); }
function sendJson(res, status, body) { res.writeHead(status, noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" })); res.end(JSON.stringify(body)); }
function redirect(res, location) { res.writeHead(303, noStoreHeaders({ Location: location })); res.end(); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[char])); }

function page(title, content) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${css()}</style></head><body>${content}</body></html>`;
}

function loginPage(message = "") {
  return page("WireGuard Admin", `<main class="login-shell"><form class="login-card" method="post" action="/login"><h1>WireGuard Admin</h1>${message ? `<div class="alert">${escapeHtml(message)}</div>` : ""}<input type="password" name="password" placeholder="Admin password" autofocus><button type="submit">Login</button></form></main><script>window.addEventListener("pageshow",()=>{fetch("/api/state",{cache:"no-store"}).then((res)=>{if(res.ok)location.replace("/")}).catch(()=>{})});</script>`);
}

function appPage() {
  return page("WireGuard Admin", `<div class="app-shell"><aside class="sidebar"><div class="sidebar-brand"><button id="sidebarToggle" class="hamburger" type="button" aria-label="Toggle sidebar"><span></span><span></span><span></span></button><strong>WireGuard Admin</strong></div><div class="side-group"><span>MANAGEMENT</span><button class="tab active" data-tab="clients">Captive</button><button class="tab" data-tab="relay">Relay</button><button class="tab" data-tab="settings">Settings</button></div><form class="logout-form" method="post" action="/logout"><button type="submit">Logout</button></form></aside><div class="main-shell"><main class="content"><section id="clientsTab"><div class="section-head"><div><h1>Captive</h1><p>Quan ly trang thai captive cua tung WireGuard client.</p></div><div class="section-actions"><button type="button" id="expiryCheckBtn" class="ghost compact">Check het han</button><div class="client-filters" id="clientFilters"><button type="button" class="filter-pill active" data-filter="all">Total <span id="countAll">0</span></button><button type="button" class="filter-pill" data-filter="active">Active <span id="countActive">0</span></button><button type="button" class="filter-pill" data-filter="expired">Expired <span id="countExpired">0</span></button><button type="button" class="filter-pill" data-filter="disabled">Disabled <span id="countDisabled">0</span></button></div></div></div><div id="clientList" class="client-list"></div></section><section id="relayTab" class="settings hidden"><div class="section-head"><div><div class="relay-title-line"><h1>Relay</h1><label class="switch relay-master-switch" title="Toggle relay"><input type="checkbox" id="RELAY_MASTER"><span class="slider"></span></label></div><p>Import WireGuard .conf cua exit server, tao tunnel wg-exit trong container wg-easy va route client qua exit node.</p></div></div><div class="backup-panel"><form id="relayImportForm" enctype="multipart/form-data"><input type="file" id="relayConfFile" name="relayConf" accept=".conf,text/plain"><button type="submit" class="ghost">Import .conf</button><button type="button" id="relayDeleteConfigBtn" class="ghost danger">Delete config</button></form></div><div class="relay-ops"><div class="relay-op-row"><div><strong>Tunnel</strong><span>Start or stop wg-exit inside wg-easy.</span></div><div class="relay-op-actions"><button class="ghost relay-action" data-action="relay-restart">Restart</button><label class="switch relay-switch" title="Toggle tunnel"><input type="checkbox" id="RELAY_TUNNEL"><span class="slider"></span></label></div></div><div class="relay-op-row"><div><strong>Route</strong><span>Route active clients through the exit node.</span></div><label class="switch relay-switch" title="Toggle route"><input type="checkbox" id="RELAY_ROUTE"><span class="slider"></span></label></div></div><div class="relay-status-grid"><div class="relay-card"><h2>Exit config</h2><div id="relayConfigCard" class="relay-kv"></div></div><div class="relay-card"><h2>Status</h2><div id="relayHealthCard" class="relay-kv"></div></div></div></section><section id="settingsTab" class="settings hidden"><div class="section-head"><div><h1>Settings</h1><p>Cau hinh portal va Telegram backup.</p></div></div><form id="settingsForm" class="settings-grid"><label>Portal IP<input name="PORTAL_IP" id="PORTAL_IP"></label><label>Server IP<input name="SERVER_PUBLIC_IP" id="SERVER_PUBLIC_IP"></label><label>Relay client subnet<input name="RELAY_CLIENT_SUBNET" id="RELAY_CLIENT_SUBNET" placeholder="10.8.0.0/24"></label><label>Telegram bot token<input name="TELEGRAM_BOT_TOKEN" id="TELEGRAM_BOT_TOKEN"></label><label>Telegram chat ID<input name="TELEGRAM_CHAT_ID" id="TELEGRAM_CHAT_ID"></label><div class="settings-check-grid"><label class="check"><input type="checkbox" name="BLOCK_DNS" id="BLOCK_DNS"> <span>Block DNS 53</span></label><label class="check"><input type="checkbox" name="BLOCK_DOT" id="BLOCK_DOT"> <span>Block DNS-over-TLS 853</span></label><label class="check"><input type="checkbox" name="TELEGRAM_BACKUP_ENABLED" id="TELEGRAM_BACKUP_ENABLED"> <span>Send backup to Telegram</span></label><div class="check auto-backup-card" id="autoBackupCard"><div class="check-line"><input type="checkbox" name="AUTO_BACKUP_ENABLED" id="AUTO_BACKUP_ENABLED"> <span>Enable auto backup</span></div><label class="auto-backup-times">Auto backup times, comma separated HH:MM<input name="AUTO_BACKUP_TIMES" id="AUTO_BACKUP_TIMES" placeholder="02:00,14:00"></label></div></div><button type="submit" class="primary save-btn">Save settings</button></form><div class="backup-panel"><button id="backupBtn" class="primary">Backup now</button><form id="restoreForm" enctype="multipart/form-data"><input type="file" id="restoreFile" name="backup" accept=".tar.gz,.tgz,application/gzip"><button type="submit" class="ghost">Restore upload</button></form></div></section></main><footer class="footer">Powered by &#272;&#7841;i An VPN</footer></div></div><div id="toast"></div><script>${clientJs()}</script>`);
}

function css() { return `:root{--bg:#0b1220;--panel:#101827;--panel3:#0e1728;--line:#1e2a3d;--text:#f8fafc;--muted:#93a4bc;--blue:#2f6df6;--blue2:#1d4ed8;--green:#20c76a;--red2:#b91c1c;--shadow:0 18px 42px rgba(0,0,0,.28),0 1px 0 rgba(255,255,255,.04) inset;--shadow2:0 28px 70px rgba(0,0,0,.38),0 10px 24px rgba(2,8,23,.24);--edge:rgba(148,163,184,.14)}*{box-sizing:border-box}html,body{min-height:100%;margin:0;background:#0b1220;color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.app-shell{min-height:100vh;display:flex;align-items:flex-start;background:linear-gradient(180deg,#111827 0,#0b1220 230px),linear-gradient(135deg,rgba(47,109,246,.08),transparent 45%)}.sidebar{width:260px;flex:0 0 260px;min-height:calc(100vh - 28px);display:flex;flex-direction:column;margin:14px 0 14px 14px;border:1px solid var(--edge);border-radius:16px;background:linear-gradient(180deg,#102333,#101827 58%,#0b1220);box-shadow:0 24px 70px rgba(0,0,0,.42),0 1px 0 rgba(255,255,255,.05) inset;padding:18px;transition:width .28s cubic-bezier(.22,1,.36,1),flex-basis .28s cubic-bezier(.22,1,.36,1),height .28s cubic-bezier(.22,1,.36,1),min-height .28s cubic-bezier(.22,1,.36,1),padding .28s cubic-bezier(.22,1,.36,1),box-shadow .28s ease,transform .28s ease;will-change:width,flex-basis,height,min-height,padding}.sidebar-brand{display:flex;align-items:center;gap:14px;padding:4px 2px 18px;border-bottom:1px solid #1e3449;transition:justify-content .28s ease,border-color .22s ease,padding .28s cubic-bezier(.22,1,.36,1)}.sidebar-brand strong{font-size:18px;line-height:1;color:#fff;font-weight:900;white-space:nowrap;max-width:174px;overflow:hidden;opacity:1;transform:translateX(0);transition:max-width .24s cubic-bezier(.22,1,.36,1),opacity .16s ease,transform .22s ease}.hamburger{width:36px;display:grid;gap:5px;border:0;background:transparent;padding:7px 3px;cursor:pointer;transition:transform .16s ease}.hamburger:hover{transform:translateY(-1px)}.hamburger span{height:2px;background:#e5edf7;border-radius:999px}.hamburger:hover span{background:#33d1ff}.app-shell.sidebar-collapsed .sidebar{width:74px;flex:0 0 74px;height:74px;min-height:74px;align-self:flex-start;padding:18px 12px;overflow:hidden}.app-shell.sidebar-collapsed .sidebar-brand{justify-content:center;gap:0;border-bottom:0;padding-bottom:0}.app-shell.sidebar-collapsed .sidebar-brand strong{max-width:0;opacity:0;visibility:hidden;pointer-events:none;transform:translateX(-10px)}.app-shell.sidebar-collapsed .side-group,.app-shell.sidebar-collapsed .logout-form{opacity:0;visibility:hidden;pointer-events:none;transform:translateX(-10px)}.side-group{display:grid;gap:8px;padding-top:22px;opacity:1;transform:translateX(0);transition:opacity .18s ease,transform .24s ease,visibility .18s ease}.side-group>span{color:#92a1b4;font-size:12px;font-weight:900;letter-spacing:2px;margin:0 0 6px 2px}.side-group>span:before{content:"";display:inline-block;width:4px;height:14px;border-radius:999px;background:#33d1ff;margin-right:12px;vertical-align:-2px}.side-group button{width:100%;border:1px solid transparent;background:transparent;color:#cbd5e1;text-align:left;border-radius:10px;padding:12px 14px;font-size:16px;font-weight:750;cursor:pointer;transition:transform .16s ease,background .16s ease,border-color .16s ease,box-shadow .16s ease}.side-group button:hover{background:#132236;color:#fff;border-color:rgba(34,211,238,.16);box-shadow:0 10px 24px rgba(0,0,0,.18);transform:translateY(-1px)}.side-group .tab.active{background:linear-gradient(135deg,rgba(34,211,238,.16),rgba(47,109,246,.1));box-shadow:inset 3px 0 0 #22d3ee,0 14px 28px rgba(8,47,73,.22);color:#e0faff;border-color:rgba(34,211,238,.22)}.logout-form{margin-top:auto;padding-top:18px;opacity:1;transform:translateX(0);transition:opacity .18s ease,transform .24s ease,visibility .18s ease;display:flex;justify-content:flex-start}.logout-form button{width:auto;min-width:92px;border:1px solid #26384d;background:linear-gradient(180deg,#152238,#0f1726);color:#cbd5e1;border-radius:10px;padding:9px 13px;font-size:14px;font-weight:800;text-align:center;cursor:pointer;box-shadow:0 12px 26px rgba(0,0,0,.18);transition:transform .16s ease,box-shadow .16s ease,background .16s ease,border-color .16s ease}.logout-form button:hover{background:linear-gradient(180deg,#351b26,#24111a);border-color:#7f1d1d;color:#fecaca;box-shadow:0 18px 34px rgba(127,29,29,.18);transform:translateY(-1px)}.main-shell{min-width:0;min-height:100vh;flex:1;display:flex;flex-direction:column}.primary,.ghost{border:0;border-radius:12px;padding:11px 16px;color:white;font-weight:800;font-size:14px;cursor:pointer;white-space:nowrap;transition:transform .16s ease,box-shadow .16s ease,background .16s ease}.primary{background:linear-gradient(180deg,#3b7bff,var(--blue));box-shadow:0 16px 32px rgba(47,109,246,.28),0 1px 0 rgba(255,255,255,.2) inset}.primary:hover{background:linear-gradient(180deg,#2f6df6,var(--blue2));box-shadow:0 22px 42px rgba(47,109,246,.34);transform:translateY(-1px)}.ghost{background:linear-gradient(180deg,#46546a,#323d50);color:#fff;box-shadow:0 12px 26px rgba(0,0,0,.2),0 1px 0 rgba(255,255,255,.08) inset}.ghost:hover{background:linear-gradient(180deg,#53627a,#3b465c);box-shadow:0 18px 34px rgba(0,0,0,.28);transform:translateY(-1px)}.ghost.danger{background:linear-gradient(180deg,#7f1d1d,#5f1717)}.ghost.danger:hover{background:linear-gradient(180deg,#991b1b,#7f1d1d)}.content{width:100%;max-width:1080px;margin:0 auto;padding:22px 20px 26px;flex:1}.section-head{display:flex;align-items:end;justify-content:space-between;gap:16px;margin:0 0 14px}.section-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap}.compact{padding:8px 12px;font-size:13px;border-radius:10px}.client-filters{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}.filter-pill{border:1px solid var(--edge);background:linear-gradient(180deg,#122038,#0d1626);color:#dbeafe;border-radius:999px;padding:8px 11px;font-weight:850;font-size:13px;cursor:pointer;box-shadow:0 12px 28px rgba(0,0,0,.18),0 1px 0 rgba(255,255,255,.06) inset;transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease,background .16s ease}.filter-pill span{margin-left:5px;color:#fff}.filter-pill:hover{transform:translateY(-1px);border-color:rgba(59,130,246,.34);box-shadow:0 16px 32px rgba(0,0,0,.24)}.filter-pill.active{background:linear-gradient(180deg,#3b7bff,var(--blue));border-color:rgba(96,165,250,.48);color:#fff;box-shadow:0 16px 32px rgba(47,109,246,.25),0 1px 0 rgba(255,255,255,.18) inset}.section-head h1{margin:0;font-size:26px;letter-spacing:0}.relay-title-line{display:flex;align-items:center;gap:14px}.relay-master-switch{justify-self:start}.section-head p{margin:5px 0 0;color:var(--muted);font-size:14px}.summary-pill{border:1px solid var(--edge);background:linear-gradient(180deg,#122038,#0d1626);color:#dbeafe;border-radius:999px;padding:8px 12px;font-weight:800;font-size:14px;box-shadow:0 12px 28px rgba(0,0,0,.22),0 1px 0 rgba(255,255,255,.06) inset}.client-list{display:grid;gap:8px;contain:layout paint style}.client-row{min-height:72px;background:linear-gradient(180deg,#121d30,#0f1828);border:1px solid var(--edge);border-radius:12px;box-shadow:0 6px 14px rgba(0,0,0,.16),0 1px 0 rgba(255,255,255,.035) inset;content-visibility:auto;contain-intrinsic-size:74px;contain:layout paint style;display:grid;grid-template-columns:minmax(180px,1fr) 150px 86px 64px;align-items:center;gap:14px;padding:13px 16px;position:relative;transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease,background .18s ease}.client-row:hover{transform:translateY(-1px);border-color:rgba(59,130,246,.3);box-shadow:0 10px 22px rgba(0,0,0,.2),0 1px 0 rgba(255,255,255,.05) inset;background:linear-gradient(180deg,#142238,#101b2d)}.name{font-size:19px;font-weight:900;line-height:1.05}.name-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:5px}.expiry-badge{border:1px solid rgba(148,163,184,.16);border-radius:999px;padding:4px 8px;font-size:11px;font-weight:850;color:#dbeafe;background:rgba(15,23,42,.5)}.expiry-badge.good{color:#86efac;border-color:rgba(34,197,94,.22);background:rgba(20,83,45,.24)}.expiry-badge.bad{color:#fecaca;border-color:rgba(239,68,68,.22);background:rgba(127,29,29,.24)}.expiry-badge.none{color:#93a4bc}.renew-open{justify-self:end;padding:9px 12px;font-size:12px}.renew-panel{grid-column:1/-1;border:1px solid rgba(38,52,73,.8);background:rgba(8,17,31,.65);border-radius:10px;padding:12px;display:grid;gap:12px;box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}.renew-quick{display:flex;gap:8px;flex-wrap:wrap}.renew-quick .ghost{padding:9px 11px;font-size:12px}.renew-manual{display:flex;align-items:end;gap:10px;flex-wrap:wrap}.renew-manual label{display:grid;gap:6px;color:#c7d2e2;font-size:12px;font-weight:800}.date-display{border:1px solid #263449;background:linear-gradient(180deg,#0c1627,#08111f);color:#eaf2ff;border-radius:10px;padding:10px 12px;min-width:190px;font:inherit;font-weight:900;text-align:left;cursor:pointer;box-shadow:inset 0 2px 8px rgba(0,0,0,.24);transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}.date-display:hover{border-color:rgba(34,211,238,.42);box-shadow:inset 0 2px 8px rgba(0,0,0,.24),0 12px 24px rgba(8,47,73,.18);transform:translateY(-1px)}.date-popover{position:fixed;z-index:50;width:min(360px,calc(100vw - 24px));border:1px solid rgba(38,52,73,.9);background:linear-gradient(180deg,#111923,#0a121d);border-radius:13px;padding:12px;box-shadow:0 28px 70px rgba(0,0,0,.46),0 1px 0 rgba(255,255,255,.06) inset}.picker-head{display:grid;grid-template-columns:1fr 88px 34px;align-items:center;gap:8px;margin-bottom:10px}.picker-head select,.picker-head input{min-width:0;border:1px solid #263449;background:#101923;color:#eaf2ff;border-radius:9px;padding:8px 9px;font:inherit;font-size:12px;font-weight:900}.picker-close,.date-day{border:0;border-radius:9px;background:transparent;color:#cbd5e1;font-weight:850;cursor:pointer}.picker-close{height:34px;background:#263244;font-size:18px;line-height:1}.picker-close:hover,.date-day:hover{background:#1f2c3e;color:#fff}.picker-week,.picker-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px;text-align:center}.picker-week span{color:#7d8ba1;font-size:11px;font-weight:900}.date-day{height:31px;font-size:12px}.date-day.active{background:#0ea5b7;color:#ecfeff;box-shadow:0 10px 20px rgba(14,165,183,.22)}.time-row{margin-top:10px;display:grid;gap:6px;color:#c7d2e2;font-size:12px;font-weight:800}.time-row input{border:1px solid #263449;background:#101923;color:#eaf2ff;border-radius:10px;padding:9px 11px;font:inherit;font-weight:900;min-width:140px}.renew-manual .primary{padding:10px 13px;font-size:12px}.sub{display:flex;gap:12px;align-items:center;color:#9bc9ff;font-size:15px}.ip{color:#9bc9ff}.status{color:var(--muted);font-size:12px}.status strong{display:block;color:var(--text);font-size:15px;font-weight:850;margin-bottom:3px}.status.active strong{color:var(--green)}.status.disabled strong{color:#fbbf24}.status.expired strong{color:#ff6b6b}.avatar-wrap,.avatar,.dot{display:none}.switch{--switch-w:58px;--switch-h:31px;--knob:23px;--gap:4px;justify-self:end;position:relative;display:inline-block;width:var(--switch-w);height:var(--switch-h);line-height:0;vertical-align:middle}.switch input{display:none}.slider{position:absolute;inset:0;border-radius:999px;background:#334155;transition:background .18s ease;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08),0 10px 20px rgba(0,0,0,.22)}.slider:before{content:"";position:absolute;width:var(--knob);height:var(--knob);left:var(--gap);top:0;bottom:0;margin:auto 0;background:white;border-radius:50%;transform:translateX(calc(var(--switch-w) - var(--knob) - (var(--gap) * 2)));transition:transform .18s ease,box-shadow .18s ease;box-shadow:0 4px 14px rgba(0,0,0,.34)}.switch input:checked+.slider{background:var(--green)}.switch input:not(:checked)+.slider{background:var(--red2)}.switch input:not(:checked)+.slider:before{transform:translateX(0)}.switch.is-pending{pointer-events:none}.switch input:disabled+.slider{opacity:.55;cursor:wait}.empty{padding:30px 20px;background:linear-gradient(180deg,#121d30,#0f1828);border:1px solid var(--edge);border-radius:12px;color:var(--muted);text-align:center;box-shadow:var(--shadow)}.hidden{display:none}.settings{background:linear-gradient(180deg,#111c2f,#0d1728);border:1px solid var(--edge);border-radius:14px;box-shadow:var(--shadow2);padding:20px}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.settings label{display:grid;gap:7px;color:#c7d2e2;font-size:12px;font-weight:800}.settings input{border:1px solid #263449;background:linear-gradient(180deg,#0c1627,#08111f);color:var(--text);border-radius:10px;padding:11px 12px;font:inherit;min-width:0;box-shadow:inset 0 2px 8px rgba(0,0,0,.24);transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}.settings input:focus{outline:2px solid rgba(47,109,246,.45);border-color:#3b82f6;box-shadow:inset 0 2px 8px rgba(0,0,0,.24),0 0 0 4px rgba(47,109,246,.12)}.settings-check-grid{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.settings .check{display:flex;align-items:center;gap:8px;background:linear-gradient(180deg,#0d1829,#091221);border:1px solid #263449;border-radius:10px;padding:9px 10px;min-height:46px;box-shadow:0 10px 22px rgba(0,0,0,.14);transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease}.settings .check:hover{transform:translateY(-1px);border-color:rgba(59,130,246,.32);box-shadow:0 16px 30px rgba(0,0,0,.22)}.settings .check input{width:14px;height:14px;flex:0 0 14px}.settings .check span{font-size:12px;line-height:1.2}.check-line{display:flex;align-items:center;gap:8px}.auto-backup-card{display:grid!important;align-items:stretch!important;gap:10px}.auto-backup-times{display:none!important}.auto-backup-card.is-enabled .auto-backup-times{display:grid!important}.auto-backup-card .auto-backup-times input{width:100%;margin-top:0}.wide{grid-column:1/-1}.save-btn{justify-self:start;margin-top:2px}.backup-panel{display:flex;align-items:center;gap:10px;margin-top:16px;flex-wrap:wrap}.backup-panel form{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.backup-panel input[type=file]{color:var(--muted);max-width:100%}.relay-switch{flex:0 0 58px}.relay-ops{display:grid;gap:10px;margin-top:16px}.relay-op-row{display:flex;align-items:center;justify-content:space-between;gap:16px;border:1px solid #263449;background:linear-gradient(180deg,#0d1829,#091221);border-radius:12px;padding:12px 14px;box-shadow:0 10px 22px rgba(0,0,0,.14)}.relay-op-row strong{display:block;font-size:15px}.relay-op-row span{display:block;color:var(--muted);font-size:12px;margin-top:3px}.relay-op-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:176px;margin-left:auto}.relay-op-row>.relay-switch{margin-left:auto}.relay-status-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}.relay-card{background:linear-gradient(180deg,#0d1829,#091221);border:1px solid #263449;border-radius:12px;padding:13px 14px;box-shadow:0 14px 30px rgba(0,0,0,.2),0 1px 0 rgba(255,255,255,.04) inset}.relay-card h2{margin:0 0 10px;font-size:14px;line-height:1;color:#eaf2ff}.relay-kv{display:grid;gap:7px}.relay-kv-row{display:grid;grid-template-columns:minmax(120px,.75fr) minmax(0,1fr);gap:10px;align-items:center;border:1px solid rgba(38,52,73,.7);border-radius:9px;background:rgba(6,16,31,.46);padding:8px 10px;min-height:36px}.relay-kv-row span{color:#93a4bc;font-size:12px;font-weight:800;text-transform:capitalize}.relay-kv-row strong{min-width:0;color:#e5edf7;font-size:13px;font-weight:850;overflow-wrap:anywhere}.relay-kv-row strong.good{color:var(--green)}.relay-kv-row strong.bad{color:#ff6b6b}.relay-kv-row strong.warn{color:#fbbf24}.relay-section{margin:6px 0 1px;color:#6fdcff;font-size:11px;font-weight:900;letter-spacing:1.4px;text-transform:uppercase}.relay-empty{color:var(--muted);font-size:13px;padding:8px 0}.relay-conf-pre{margin:0;background:rgba(6,16,31,.58);border:1px solid rgba(38,52,73,.7);border-radius:10px;padding:11px;color:#dbeafe;font-size:12px;line-height:1.45;white-space:pre-wrap;overflow:auto;max-height:320px}.relay-path{color:#93a4bc;font-size:12px;font-weight:800;margin:-2px 0 9px;overflow-wrap:anywhere}.relay-status-pre{margin:0;background:rgba(6,16,31,.58);border:1px solid rgba(38,52,73,.7);border-radius:10px;padding:11px;color:#dbeafe;font-size:12px;line-height:1.45;white-space:pre-wrap;overflow:auto;max-height:320px}.status-token.good{color:var(--green);font-weight:900}.status-token.bad{color:#ff6b6b;font-weight:900}.status-token.warn{color:#fbbf24;font-weight:900}.footer{padding:12px 16px;color:#7890bc;text-align:center;font-size:15px;border-top:1px solid rgba(30,42,61,.45);background:#0b1220}#toast{position:fixed;right:20px;bottom:20px;max-width:340px;padding:12px 14px;border-radius:10px;background:#e5e7eb;color:#0f172a;opacity:0;transform:translateY(10px);transition:.18s ease;font-weight:750;z-index:20}#toast.show{opacity:1;transform:translateY(0)}.login-shell{min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:18px;background:linear-gradient(180deg,#111827,#0b1220)}.login-card{width:min(420px,calc(100vw - 28px));background:linear-gradient(180deg,#111c2f,#0d1728);border:1px solid var(--edge);border-radius:16px;padding:28px;box-shadow:var(--shadow2)}.login-card h1{font-size:32px;margin:0 0 18px;line-height:1.05}.login-card p{color:var(--muted);margin:0 0 18px;font-size:15px}.login-card input,.login-card button{width:100%;margin-top:12px}.login-card input{border:1px solid #263449;background:linear-gradient(180deg,#0c1627,#08111f);color:var(--text);border-radius:12px;padding:14px 14px;font:inherit;font-size:16px;line-height:1.2;min-height:50px;box-shadow:inset 0 2px 8px rgba(0,0,0,.24)}.login-card button{border:0;border-radius:12px;background:linear-gradient(180deg,#3b7bff,var(--blue));color:white;padding:14px 14px;min-height:50px;font-size:16px;font-weight:850;cursor:pointer;box-shadow:0 16px 32px rgba(47,109,246,.28),0 1px 0 rgba(255,255,255,.2) inset}.alert{background:#451a1a;color:#fecaca;border-radius:10px;padding:9px 10px;margin-top:12px}@media(max-width:820px){.client-row{content-visibility:visible;contain:none}.settings-check-grid{grid-template-columns:1fr}.app-shell{display:block}.sidebar{width:calc(100% - 20px);margin:10px 10px 0;border-radius:14px;padding:12px}.sidebar-brand{padding:2px 2px 12px}.sidebar-brand strong{font-size:18px}.hamburger{width:30px}.app-shell.sidebar-collapsed .sidebar{width:58px;height:58px;flex-basis:auto;padding:12px;overflow:hidden}.app-shell.sidebar-collapsed .sidebar-brand{justify-content:center}.side-group{padding-top:12px;grid-template-columns:1fr 1fr}.side-group>span{grid-column:1/-1}.side-group button{text-align:center;padding:11px 10px;font-size:15px}.content{padding:18px 14px 22px}.section-head{align-items:flex-start;flex-direction:column;margin-bottom:12px}.section-head h1{font-size:25px}.section-head p{font-size:14px}.client-list{gap:10px}.client-row{grid-template-columns:1fr 62px;min-height:74px;padding:14px 15px}.renew-open{grid-column:1;justify-self:start}.renew-panel{grid-column:1/-1}.date-display{min-width:0;width:100%}.name{font-size:20px}.sub{font-size:15px}.status{display:none}.switch{--switch-w:62px;--switch-h:33px;--knob:25px;--gap:4px;grid-column:2;grid-row:1;width:var(--switch-w);height:var(--switch-h)}.settings{padding:16px}.settings-grid{grid-template-columns:1fr}.relay-status-grid{grid-template-columns:1fr}.relay-op-row{align-items:flex-start}.relay-op-actions{align-self:flex-end}.settings label{font-size:13px}.settings input{padding:12px 13px}.primary,.ghost{padding:11px 14px;font-size:15px}.footer{font-size:14px;padding:10px 14px}.login-shell{padding:20px 14px;align-items:center}.login-card{width:min(440px,calc(100vw - 28px));padding:30px 22px;border-radius:18px}.login-card h1{font-size:34px;margin-bottom:20px}.login-card p{font-size:16px;margin-bottom:20px}.login-card input,.login-card button{margin-top:14px;min-height:54px;font-size:17px;border-radius:14px}.login-card input{padding:15px 15px}.login-card button{padding:15px 15px}}`; }
function clientJs() { return `let state={clients:[],config:{},relay:{}};let activeClientFilter='all';let toggleSeq=0;const pendingToggles={};const $=(id)=>document.getElementById(id);
function initSidebar(){const shell=document.querySelector('.app-shell');const btn=$('sidebarToggle');if(!shell||!btn)return;let saved=false;try{saved=localStorage.getItem('sidebarCollapsed')==='1'}catch{}shell.classList.toggle('sidebar-collapsed',saved);btn.setAttribute('aria-expanded',String(!saved));btn.addEventListener('click',()=>{const collapsed=!shell.classList.contains('sidebar-collapsed');shell.classList.toggle('sidebar-collapsed',collapsed);btn.setAttribute('aria-expanded',String(!collapsed));try{localStorage.setItem('sidebarCollapsed',collapsed?'1':'0')}catch{}})}
function toast(message){const box=$('toast');box.textContent=message;box.classList.add('show');setTimeout(()=>box.classList.remove('show'),2200)}
const API_BASE='/api/v1';const API_ENDPOINTS={state:API_BASE+'/state',sync:API_BASE+'/sync',clientStatus:(ip)=>API_BASE+'/clients/'+encodeURIComponent(ip)+'/status',clientExpiry:(ip)=>API_BASE+'/clients/'+encodeURIComponent(ip)+'/expiry',settings:API_BASE+'/settings',relayAction:API_BASE+'/relay/action',relayImport:API_BASE+'/relay/import',backup:API_BASE+'/backup',restore:API_BASE+'/restore',expiryCheck:API_BASE+'/expiry/check'};async function api(path,options={}){const res=await fetch(path,{headers:{'Content-Type':'application/json',...(options.headers||{})},...options});const data=await res.json();if(!res.ok||data.ok===false)throw new Error(data.error||'Request failed');return data}
function escapeHtml(v){return String(v).replace(/[&<>"']/g,(ch)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]))}
function mergeClientResult(ip,captive,clients){const fresh=(clients||[]).find((item)=>item.ip===ip);state.clients=state.clients.map((client)=>client.ip===ip?{...client,...fresh,captive}:client)}
function formatExpiry(value){if(!value)return 'Chua co han';const date=new Date(value);if(!Number.isFinite(date.getTime()))return 'Han khong hop le';return 'Het han: '+date.toLocaleString('vi-VN',{hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}
function expiryClass(value){if(!value)return 'none';const date=new Date(value);if(!Number.isFinite(date.getTime()))return 'bad';return date.getTime()<=Date.now()?'bad':'good'}
function pad2(v){return String(v).padStart(2,'0')}
function addClientMonths(date,months){const next=new Date(date.getTime());const day=next.getDate();next.setMonth(next.getMonth()+months,1);const last=new Date(next.getFullYear(),next.getMonth()+1,0).getDate();next.setDate(Math.min(day,last));return next}
function toDateTimeLocal(value){const date=value?new Date(value):new Date();if(!Number.isFinite(date.getTime()))return '';return date.getFullYear()+'-'+pad2(date.getMonth()+1)+'-'+pad2(date.getDate())+'T'+pad2(date.getHours())+':'+pad2(date.getMinutes())}
function formatDateTimeInput(value){const date=value?new Date(value):new Date();if(!Number.isFinite(date.getTime()))return '';return pad2(date.getDate())+'/'+pad2(date.getMonth()+1)+'/'+date.getFullYear()+' '+pad2(date.getHours())+':'+pad2(date.getMinutes())}
function clientCounts(){const counts={all:state.clients.length,active:0,expired:0,disabled:0};state.clients.forEach((client)=>{const status=client.status||'active';if(counts[status]!==undefined)counts[status]++});return counts}
function renderClientFilters(){const counts=clientCounts();const ids={all:'countAll',active:'countActive',expired:'countExpired',disabled:'countDisabled'};Object.entries(ids).forEach(([key,id])=>{const el=$(id);if(el)el.textContent=counts[key]||0});document.querySelectorAll('.filter-pill').forEach((btn)=>btn.classList.toggle('active',btn.dataset.filter===activeClientFilter))}
function visibleClients(){return activeClientFilter==='all'?state.clients:state.clients.filter((client)=>(client.status||'active')===activeClientFilter)}
function renderClients(){const list=$('clientList');renderClientFilters();const clients=visibleClients();if(!state.clients.length){list.innerHTML='<div class="empty">No clients found in wg0.json.</div>';return}if(!clients.length){list.innerHTML='<div class="empty">No clients in this status.</div>';return}list.innerHTML=clients.map((c)=>{const pending=pendingToggles[c.ip];const status=c.status||'active';const checked=pending?pending.previousChecked:!c.disabled;const expiryText=formatExpiry(c.expires_at);const expClass=expiryClass(c.expires_at);const pickerValue=toDateTimeLocal(c.expires_at);const statusTitle=status==='active'?'Dang hoat dong':(status==='disabled'?'Disabled':'Expired');const statusSub=pending?'updating':(status==='active'?'internet open':(status==='disabled'?'admin off':'het han'));return '<div class="client-row" data-ip="'+c.ip+'"><div><div class="name-line"><div class="name">'+escapeHtml(c.name)+'</div><span class="expiry-badge '+expClass+'">'+escapeHtml(expiryText)+'</span></div><div class="sub"><span class="ip">'+c.ip+'</span></div></div><div class="status '+status+'"><strong>'+statusTitle+'</strong><span>'+statusSub+'</span></div><button type="button" class="ghost renew-open" data-ip="'+c.ip+'">Gia han</button><label class="switch '+(pending?'is-pending':'')+'" title="Toggle active/disabled"><input type="checkbox" data-ip="'+c.ip+'" '+(checked?'checked':'')+' '+(pending?'disabled':'')+'><span class="slider"></span></label><div class="renew-panel hidden" data-panel-ip="'+c.ip+'"><div class="renew-quick"><button type="button" class="ghost renew-quick-btn" data-ip="'+c.ip+'" data-months="1">+1 thang</button><button type="button" class="ghost renew-quick-btn" data-ip="'+c.ip+'" data-months="3">+3 thang</button><button type="button" class="ghost renew-quick-btn" data-ip="'+c.ip+'" data-months="6">+6 thang</button><button type="button" class="ghost renew-quick-btn" data-ip="'+c.ip+'" data-months="12">+1 nam</button></div><form class="renew-manual" data-ip="'+c.ip+'"><label>Thoi gian het han<button type="button" class="date-display" data-ip="'+c.ip+'">'+escapeHtml(formatDateTimeInput(pickerValue))+'</button><input type="hidden" name="expires_at" value="'+pickerValue+'"></label><button type="submit" class="primary">Luu thoi gian</button></form></div></div>'}).join('')}function pickerDate(ip){const input=document.querySelector('.renew-manual[data-ip="'+ip+'"] input[name="expires_at"]');const date=input?.value?new Date(input.value):new Date();return Number.isFinite(date.getTime())?date:new Date()}
function datePickerEl(){let box=$('datePickerPopover');if(!box){box=document.createElement('div');box.id='datePickerPopover';box.className='date-popover hidden';document.body.appendChild(box)}return box}
function clamp(value,min,max){return Math.max(min,Math.min(max,value))}
let activeDatePickerIp='';
function closeDatePicker(){const box=$('datePickerPopover');if(box)box.classList.add('hidden');activeDatePickerIp=''}
function positionDatePicker(anchor){const box=$('datePickerPopover');if(!box||!anchor)return;const rect=anchor.getBoundingClientRect();const width=box.offsetWidth||360;const height=box.offsetHeight||320;const left=clamp(rect.left,12,Math.max(12,window.innerWidth-width-12));let top=rect.bottom+8;if(top+height>window.innerHeight-12)top=rect.top-height-8;top=clamp(top,12,Math.max(12,window.innerHeight-height-12));box.style.left=left+'px';box.style.top=top+'px'}
function openDatePicker(ip,anchor){activeDatePickerIp=ip;const box=datePickerEl();renderFloatingDatePicker(box,ip);box.classList.remove('hidden');positionDatePicker(anchor)}
function syncOpenPicker(ip){const box=$('datePickerPopover');if(box&&!box.classList.contains('hidden')&&activeDatePickerIp===ip)renderFloatingDatePicker(box,ip)}
function setPickerDate(ip,date){const form=document.querySelector('.renew-manual[data-ip="'+ip+'"]');if(!form)return;form.querySelector('input[name="expires_at"]').value=toDateTimeLocal(date);const display=form.querySelector('.date-display');if(display)display.textContent=formatDateTimeInput(date);syncOpenPicker(ip)}
function renderFloatingDatePicker(box,ip){const selected=pickerDate(ip);const monthOptions=Array.from({length:12},(_,i)=>'<option value="'+i+'" '+(i===selected.getMonth()?'selected':'')+'>Thang '+(i+1)+'</option>').join('');const month=new Date(selected.getFullYear(),selected.getMonth(),1);const start=(month.getDay()+6)%7;const days=new Date(selected.getFullYear(),selected.getMonth()+1,0).getDate();let cells='';for(let i=0;i<start;i++)cells+='<span></span>';for(let d=1;d<=days;d++){const active=d===selected.getDate();cells+='<button type="button" class="date-day '+(active?'active':'')+'" data-day="'+d+'">'+d+'</button>'}box.innerHTML='<div class="picker-head"><select class="picker-month">'+monthOptions+'</select><input class="picker-year" type="number" min="2020" max="2099" value="'+selected.getFullYear()+'"><button type="button" class="picker-close" title="Dong">x</button></div><div class="picker-week"><span>T2</span><span>T3</span><span>T4</span><span>T5</span><span>T6</span><span>T7</span><span>CN</span></div><div class="picker-grid">'+cells+'</div><label class="time-row">Gio het han<input type="time" value="'+pad2(selected.getHours())+':'+pad2(selected.getMinutes())+'"></label>'}function updateAutoBackupCard(){const card=$('autoBackupCard');const input=$('AUTO_BACKUP_ENABLED');if(card&&input)card.classList.toggle('is-enabled',input.checked)}
function renderSettings(){for(const key of ['PORTAL_IP','SERVER_PUBLIC_IP','RELAY_CLIENT_SUBNET','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','AUTO_BACKUP_TIMES'])if($(key))$(key).value=state.config[key]||'';if($('TELEGRAM_BACKUP_ENABLED'))$('TELEGRAM_BACKUP_ENABLED').checked=state.config.TELEGRAM_BACKUP_ENABLED!=='0';if($('AUTO_BACKUP_ENABLED'))$('AUTO_BACKUP_ENABLED').checked=state.config.AUTO_BACKUP_ENABLED==='1';if($('BLOCK_DNS'))$('BLOCK_DNS').checked=state.config.BLOCK_DNS==='1';if($('BLOCK_DOT'))$('BLOCK_DOT').checked=state.config.BLOCK_DOT==='1';updateAutoBackupCard()}
function relayTokenClass(value){const v=String(value||'').toLowerCase();if(/\\b(up|enabled|yes|ok|active|running)\\b/.test(v))return 'good';if(/\\b(down|disabled|no|failed|error|missing|not found)\\b/.test(v))return 'bad';if(/\\b(warn|partial|unknown)\\b/.test(v))return 'warn';return 'neutral'}
function highlightRelayStatus(text){return escapeHtml(text).replace(/\\b(UP|DOWN|ENABLED|DISABLED|yes|no|OK|FAILED|ERROR|missing|not found|UNKNOWN|WARN|ACTIVE|RUNNING)\\b/g,(token)=>'<span class="status-token '+relayTokenClass(token)+'">'+token+'</span>')}
function renderRelayConfig(relay){const box=$('relayConfigCard');if(!box)return;const config=String(relay.exit_config||'').trim();if(!config){box.innerHTML='<div class="relay-empty">No imported exit config</div>';return}box.innerHTML='<div class="relay-path">'+escapeHtml(relay.conf_path||'')+'</div><pre class="relay-conf-pre">'+escapeHtml(config)+'</pre>'}
function renderRelayStatus(relay){const box=$('relayHealthCard');if(!box)return;const status=String(relay.status||'').trim();if(!status){box.innerHTML='<div class="relay-empty">No relay status yet</div>';return}box.innerHTML='<pre class="relay-status-pre">'+highlightRelayStatus(status)+'</pre>'}
function renderRelay(){const relay=state.relay||{};if($('RELAY_MASTER'))$('RELAY_MASTER').checked=!!relay.route_enabled;if($('RELAY_TUNNEL'))$('RELAY_TUNNEL').checked=!!relay.tunnel_up;if($('RELAY_ROUTE'))$('RELAY_ROUTE').checked=!!relay.route_enabled;renderRelayConfig(relay);renderRelayStatus(relay)}
function bindRelaySwitch(id,onAction,offAction,onToast,offToast){const input=$(id);if(!input)return;input.addEventListener('change',async()=>{const targetChecked=input.checked;const previousChecked=!targetChecked;if(targetChecked&&!state.relay?.imported&&(id==='RELAY_MASTER'||id==='RELAY_TUNNEL'||id==='RELAY_ROUTE')){input.checked=previousChecked;toast('Import relay exit config before enabling relay');return}const label=input.closest('.switch');input.checked=previousChecked;input.disabled=true;if(label)label.classList.add('is-pending');try{const data=await api(API_ENDPOINTS.relayAction,{method:'POST',body:JSON.stringify({action:targetChecked?onAction:offAction})});state.config=data.config;state.relay=data.relay;renderRelay();toast(targetChecked?onToast:offToast)}catch(error){input.checked=previousChecked;toast(error.message)}finally{input.disabled=false;if(label)label.classList.remove('is-pending')}})}
async function load(){const data=await api(API_ENDPOINTS.state);state=data;renderClients();renderSettings();renderRelay()}
function activateTab(btn){document.querySelectorAll('.tab').forEach((b)=>b.classList.remove('active'));btn.classList.add('active');$('clientsTab').classList.toggle('hidden',btn.dataset.tab!=='clients');$('relayTab').classList.toggle('hidden',btn.dataset.tab!=='relay');$('settingsTab').classList.toggle('hidden',btn.dataset.tab!=='settings')}
document.querySelectorAll('.tab').forEach((btn)=>btn.addEventListener('click',()=>activateTab(btn)));
document.querySelectorAll('.filter-pill').forEach((btn)=>btn.addEventListener('click',()=>{activeClientFilter=btn.dataset.filter||'all';renderClients()}));
$('clientList').addEventListener('change',async(e)=>{if(!e.target.matches('input[type="checkbox"]'))return;const input=e.target;const ip=input.dataset.ip;if(pendingToggles[ip]){input.checked=pendingToggles[ip].previousChecked;return}const nextChecked=input.checked;const previousChecked=!nextChecked;const seq=++toggleSeq;pendingToggles[ip]={previousChecked,nextChecked,seq};input.checked=previousChecked;input.disabled=true;const row=input.closest('.client-row');const label=input.closest('.switch');if(label)label.classList.add('is-pending');const status=row&&row.querySelector('.status span');if(status)status.textContent='updating';try{const data=await api(API_ENDPOINTS.clientStatus(ip),{method:'POST',body:JSON.stringify({status:nextChecked?'active':'disabled'})});if(!pendingToggles[ip]||pendingToggles[ip].seq!==seq)return;mergeClientResult(ip,!nextChecked,data.clients);delete pendingToggles[ip];toast(nextChecked?'Client active':'Client disabled');renderClients()}catch(error){if(pendingToggles[ip]&&pendingToggles[ip].seq===seq)delete pendingToggles[ip];toast(error.message);renderClients()}});
$('clientList').addEventListener('click',async(e)=>{const open=e.target.closest('.renew-open');if(open){const panel=document.querySelector('[data-panel-ip="'+open.dataset.ip+'"]');if(panel)panel.classList.toggle('hidden');return}const display=e.target.closest('.date-display');if(display){openDatePicker(display.dataset.ip,display);return}const quick=e.target.closest('.renew-quick-btn');if(quick){setPickerDate(quick.dataset.ip,addClientMonths(pickerDate(quick.dataset.ip),Number(quick.dataset.months)));return}});
document.addEventListener('click',(e)=>{const box=$('datePickerPopover');const display=e.target.closest('.date-display');if(display)return;if(box&&e.target.closest('#datePickerPopover')){const close=e.target.closest('.picker-close');if(close){closeDatePicker();return}const day=e.target.closest('.date-day');if(day&&activeDatePickerIp){const date=pickerDate(activeDatePickerIp);date.setDate(Number(day.dataset.day));setPickerDate(activeDatePickerIp,date)}return}closeDatePicker()});
document.addEventListener('keydown',(e)=>{if(e.key==='Escape')closeDatePicker()});
document.addEventListener('change',(e)=>{const box=e.target.closest('#datePickerPopover');if(!box||!activeDatePickerIp)return;const date=pickerDate(activeDatePickerIp);if(e.target.matches('.picker-month')){const month=Number(e.target.value);const maxDay=new Date(date.getFullYear(),month+1,0).getDate();date.setMonth(month,Math.min(date.getDate(),maxDay));setPickerDate(activeDatePickerIp,date);return}if(e.target.matches('.time-row input')){const [hh,mm]=String(e.target.value||'00:00').split(':').map(Number);date.setHours(Number.isFinite(hh)?hh:0,Number.isFinite(mm)?mm:0,0,0);setPickerDate(activeDatePickerIp,date)}});
document.addEventListener('input',(e)=>{const box=e.target.closest('#datePickerPopover');if(!box||!activeDatePickerIp)return;if(e.target.matches('.picker-year')){const year=Number(e.target.value);if(!Number.isFinite(year)||year<2020||year>2099)return;const date=pickerDate(activeDatePickerIp);const maxDay=new Date(year,date.getMonth()+1,0).getDate();date.setFullYear(year,date.getMonth(),Math.min(date.getDate(),maxDay));setPickerDate(activeDatePickerIp,date)}});
window.addEventListener('resize',()=>{if(!activeDatePickerIp)return;const anchor=document.querySelector('.date-display[data-ip="'+activeDatePickerIp+'"]');positionDatePicker(anchor)});
$('clientList').addEventListener('submit',async(e)=>{if(!e.target.matches('.renew-manual'))return;e.preventDefault();const form=e.target;const value=new FormData(form).get('expires_at');if(!value){toast('Chon thoi gian het han');return}const button=form.querySelector('button[type="submit"]');button.disabled=true;try{const data=await api(API_ENDPOINTS.clientExpiry(form.dataset.ip),{method:'POST',body:JSON.stringify({expires_at:value})});state.clients=data.clients;closeDatePicker();renderClients();toast('Da luu thoi gian het han')}catch(error){toast(error.message)}finally{button.disabled=false}});$('AUTO_BACKUP_ENABLED').addEventListener('change',updateAutoBackupCard);
$('settingsForm').addEventListener('submit',async(e)=>{e.preventDefault();const payload=Object.fromEntries(new FormData(e.target).entries());payload.TELEGRAM_BACKUP_ENABLED=$('TELEGRAM_BACKUP_ENABLED').checked?'1':'0';payload.AUTO_BACKUP_ENABLED=$('AUTO_BACKUP_ENABLED').checked?'1':'0';payload.BLOCK_DNS=$('BLOCK_DNS').checked?'1':'0';payload.BLOCK_DOT=$('BLOCK_DOT').checked?'1':'0';const data=await api(API_ENDPOINTS.settings,{method:'POST',body:JSON.stringify(payload)});state.config=data.config;renderSettings();toast('Settings saved')});
bindRelaySwitch('RELAY_MASTER','relay-enable','relay-disable','Relay enabled','Relay disabled');
bindRelaySwitch('RELAY_TUNNEL','relay-tunnel-up','relay-tunnel-down','Tunnel started','Tunnel stopped');
bindRelaySwitch('RELAY_ROUTE','relay-on','relay-off','Route enabled','Route disabled');
$('relayDeleteConfigBtn').addEventListener('click',async()=>{const relay=state.relay||{};if(relay.tunnel_up&&relay.route_enabled){toast('Turn off relay tunnel and route before deleting config');return}if(relay.tunnel_up){toast('Turn off relay tunnel before deleting config');return}if(relay.route_enabled){toast('Turn off relay route before deleting config');return}const btn=$('relayDeleteConfigBtn');btn.disabled=true;try{const data=await api(API_ENDPOINTS.relayAction,{method:'POST',body:JSON.stringify({action:'relay-delete-config'})});state.config=data.config;state.relay=data.relay;renderRelay();toast('Relay config deleted')}catch(error){toast(error.message)}finally{btn.disabled=false}});
$('relayImportForm').addEventListener('submit',async(e)=>{e.preventDefault();const file=$('relayConfFile').files[0];if(!file){toast('Choose .conf file');return}const form=new FormData();form.append('relayConf',file);const res=await fetch(API_ENDPOINTS.relayImport,{method:'POST',body:form});const data=await res.json();if(!res.ok||data.ok===false)throw new Error(data.error||'Import failed');state.config=data.config;state.relay=data.relay;renderRelay();toast('Relay config imported')});
document.querySelectorAll('.relay-action').forEach((btn)=>btn.addEventListener('click',async()=>{btn.disabled=true;try{const data=await api(API_ENDPOINTS.relayAction,{method:'POST',body:JSON.stringify({action:btn.dataset.action})});state.config=data.config;state.relay=data.relay;renderRelay();toast('Tunnel restarted')}catch(error){toast(error.message)}finally{btn.disabled=false}}));
$('expiryCheckBtn').addEventListener('click',async()=>{const btn=$('expiryCheckBtn');btn.disabled=true;try{const data=await api(API_ENDPOINTS.expiryCheck,{method:'POST',body:'{}'});state.clients=data.clients||state.clients;renderClients();const count=data.result?.newly_expired?.length||0;toast(count?'Da dua '+count+' user ve expired':'Khong co user moi het han')}catch(error){toast(error.message)}finally{btn.disabled=false}});
$('backupBtn').addEventListener('click',async()=>{await api(API_ENDPOINTS.backup,{method:'POST',body:'{}'});toast('Backup created')});
$('restoreForm').addEventListener('submit',async(e)=>{e.preventDefault();const file=$('restoreFile').files[0];if(!file){toast('Choose backup file');return}const form=new FormData();form.append('backup',file);const res=await fetch(API_ENDPOINTS.restore,{method:'POST',body:form});const data=await res.json();if(!res.ok||data.ok===false)throw new Error(data.error||'Restore failed');toast('Restore complete');await load()});
initSidebar();load().catch((error)=>toast(error.message));`; }

async function handleApi(req, res) {
  const config = loadConfig();
  if (!isApiAuthenticated(req, config)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  const url = new URL(req.url, "http://wg-captive.local");
  const pathname = url.pathname;
  const jsonBody = async () => JSON.parse(await readBody(req) || "{}");
  const clientsPayload = async (extra = {}) => ({ ok: true, clients: loadClients(config), ...extra });

  if (req.method === "GET" && pathname === "/api/v1") {
    return sendJson(res, 200, { ok: true, version: "v1", auth: "Bearer ADMIN_API_TOKEN or admin cookie", endpoints: {
      state: "GET /api/v1/state",
      clients: "GET /api/v1/clients",
      client_status: "POST /api/v1/clients/{ip}/status { status: active|disabled }",
      client_expiry: "POST /api/v1/clients/{ip}/expiry { expires_at: ISO-8601 }",
      settings_get: "GET /api/v1/settings",
      settings_update: "POST /api/v1/settings",
      expiry_check: "POST /api/v1/expiry/check",
      relay_get: "GET /api/v1/relay",
      relay_action: "POST /api/v1/relay/action { action }",
      relay_import: "POST /api/v1/relay/import multipart relayConf",
      backup: "POST /api/v1/backup",
      restore: "POST /api/v1/restore multipart backup",
      sync: "POST /api/v1/sync"
    } });
  }

  if (req.method === "GET" && (pathname === "/api/v1/state" || pathname === "/api/state")) {
    return sendJson(res, 200, { ok: true, config, clients: loadClients(config), relay: relayStatus(config) });
  }
  if (req.method === "GET" && pathname === "/api/v1/clients") return sendJson(res, 200, await clientsPayload());
  if (req.method === "GET" && pathname === "/api/v1/settings") return sendJson(res, 200, { ok: true, config });
  if (req.method === "GET" && pathname === "/api/v1/relay") return sendJson(res, 200, { ok: true, relay: relayStatus(config), config });

  if (req.method === "POST" && (pathname === "/api/v1/sync" || pathname === "/api/sync")) return sendJson(res, 200, { ok: true, result: await queueAgentSync() });

  const clientStatusMatch = pathname.match(/^\/api\/v1\/clients\/([^/]+)\/status$/);
  if (req.method === "POST" && (clientStatusMatch || pathname === "/api/toggle")) {
    if (config.EXPIRED_URL) return sendJson(res, 400, { ok: false, error: "Expired peers are managed by EXPIRED_URL API mode" });
    const body = await jsonBody();
    const ip = clientStatusMatch ? decodeURIComponent(clientStatusMatch[1]) : String(body.ip || "").trim();
    if (!isValidIp(ip)) return sendJson(res, 400, { ok: false, error: "Invalid IP address" });
    const status = String(body.status || "").trim().toLowerCase();
    const disabled = status ? status === "disabled" : Boolean(body.captive);
    if (status && !["active", "disabled"].includes(status)) return sendJson(res, 400, { ok: false, error: "status must be active or disabled" });
    setCaptive(config, ip, disabled);
    const result = await queueAgentSync();
    return sendJson(res, 200, await clientsPayload({ result }));
  }

  const clientExpiryMatch = pathname.match(/^\/api\/v1\/clients\/([^/]+)\/expiry$/);
  if (req.method === "POST" && (clientExpiryMatch || pathname === "/api/expiry/set")) {
    const body = await jsonBody();
    const ip = clientExpiryMatch ? decodeURIComponent(clientExpiryMatch[1]) : String(body.ip || "").trim();
    if (!isValidIp(ip)) return sendJson(res, 400, { ok: false, error: "Invalid IP address" });
    const expiry = setClientExpiry(config, ip, body.expires_at);
    const result = await queueAgentSync();
    return sendJson(res, 200, await clientsPayload({ expiry, result }));
  }

  if (req.method === "POST" && pathname === "/api/v1/expiry/check") {
    return sendJson(res, 200, { ok: true, result: await runExpiryCheck(config), clients: loadClients(config) });
  }

  if (req.method === "POST" && pathname === "/api/expiry/extend") {
    const body = await jsonBody();
    const ip = String(body.ip || "").trim();
    if (!isValidIp(ip)) return sendJson(res, 400, { ok: false, error: "Invalid IP address" });
    const expiry = extendClientExpiry(config, ip, Number(body.months));
    const result = await queueAgentSync();
    return sendJson(res, 200, await clientsPayload({ expiry, result }));
  }

  if (req.method === "POST" && (pathname === "/api/v1/settings" || pathname === "/api/settings")) {
    const body = await jsonBody();
    const keys = ["PORTAL_IP","SERVER_PUBLIC_IP","RELAY_CLIENT_SUBNET","BLOCK_DNS","BLOCK_DOT","TELEGRAM_BOT_TOKEN","TELEGRAM_CHAT_ID","TELEGRAM_BACKUP_ENABLED","AUTO_BACKUP_ENABLED","AUTO_BACKUP_TIMES","EXPIRY_CHECK_TIMES","EXPIRY_CHECK_ENABLED","ADMIN_API_TOKEN"];
    const patch = {};
    for (const key of keys) if (body[key] !== undefined) patch[key] = String(body[key]).trim();
    saveConfigPatch(patch);
    if (body.EXPIRY_CHECK_TIMES !== undefined || body.EXPIRY_CHECK_ENABLED !== undefined) scheduleExpiryCheckLoop();
    return sendJson(res, 200, { ok: true, config: loadConfig() });
  }

  if (req.method === "POST" && (pathname === "/api/v1/relay/action" || pathname === "/api/relay/action" || pathname === "/api/relay/settings")) {
    const body = await jsonBody();
    let action = String(body.action || "").trim();
    if (!action && pathname === "/api/relay/settings") action = String(body.RELAY_ENABLED || "0") === "1" ? "relay-enable" : "relay-disable";
    const result = await runRelayAction(action);
    if (action === "relay-enable" || action === "relay-on") saveConfigPatch({ RELAY_ENABLED: "1" });
    if (action === "relay-disable" || action === "relay-off" || action === "relay-delete-config") saveConfigPatch({ RELAY_ENABLED: "0" });
    if (action === "relay-delete-config") dbClearRelayExitConfig(config);
    const nextConfig = loadConfig();
    const relay = relayStatus(nextConfig);
    relay.last_result = result;
    return sendJson(res, 200, { ok: true, config: nextConfig, relay });
  }

  if (req.method === "POST" && (pathname === "/api/v1/relay/import" || pathname === "/api/relay/import")) {
    const body = await readBodyBuffer(req);
    const file = parseMultipart(req, body, "relayConf");
    if (!file) return sendJson(res, 400, { ok: false, error: "Missing relay .conf file" });
    const relay = await importRelayConf(config, file);
    return sendJson(res, 200, { ok: true, config: loadConfig(), relay });
  }

  if (req.method === "POST" && (pathname === "/api/v1/backup" || pathname === "/api/backup")) return sendJson(res, 200, { ok: true, backup: await createBackup(config, true) });
  if (req.method === "POST" && (pathname === "/api/v1/restore" || pathname === "/api/restore")) {
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
    if (req.method === "GET" && req.url === "/login") return isAuthenticated(req) ? redirect(res, "/") : sendHtml(res, 200, loginPage());
    if (req.method === "POST" && req.url === "/logout") {
      res.writeHead(303, noStoreHeaders({ "Set-Cookie": "wg_captive_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0", Location: "/login" }));
      return res.end();
    }
    if (req.method === "POST" && req.url === "/login") {
      const params = new URLSearchParams(await readBody(req));
      if (String(params.get("password") || "") !== PASSWORD) return sendHtml(res, 401, loginPage("Wrong password"));
      res.writeHead(303, noStoreHeaders({ "Set-Cookie": `wg_captive_admin=${makeSessionToken()}; HttpOnly; SameSite=Lax; Path=/`, Location: "/" }));
      return res.end();
    }
    if (!isAuthenticated(req)) return redirect(res, "/login");
    if (req.method === "GET" && req.url === "/") return sendHtml(res, 200, appPage());
    return sendHtml(res, 404, "Not found");
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error.message, stderr: error.stderr ? String(error.stderr) : undefined });
  }
}

function nextScheduledExpiryCheck(config, now = new Date()) {
  const times = scheduleTimes(config.EXPIRY_CHECK_TIMES, "00:10,12:10");
  if (!times.length) return null;
  let next = null;
  for (const item of times) {
    const [hour, minute] = item.split(":").map(Number);
    const candidate = new Date(now.getTime());
    candidate.setHours(hour, minute, 0, 0);
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
    if (!next || candidate < next) next = candidate;
  }
  return next;
}

function scheduleExpiryCheckLoop() {
  if (expiryCheckTimer) {
    clearTimeout(expiryCheckTimer);
    expiryCheckTimer = null;
  }
  const config = loadConfig();
  if (config.EXPIRY_CHECK_ENABLED === "0") return;
  const next = nextScheduledExpiryCheck(config);
  if (!next) return;
  const delay = Math.max(1000, next.getTime() - Date.now());
  expiryCheckTimer = setTimeout(async () => {
    try {
      const result = await runExpiryCheck(loadConfig());
      if (result.newly_expired.length) console.log(`expiry check: marked ${result.newly_expired.length} client(s) expired`);
    } catch (error) {
      console.error("expiry check failed", error.message);
    } finally {
      scheduleExpiryCheckLoop();
    }
  }, delay);
  expiryCheckTimer.unref?.();
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
  scheduleExpiryCheckLoop();
});





