"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const { createRequire } = require("node:module");
const { normalizeOpenVpnConfig, relayProtocol } = require("../web/relay-config");

const ovpn = `client
dev tun
proto tcp4-client
remote exit.example.com 8443
remote-cert-tls server
<ca>
TEST CA
</ca>
<cert>
TEST CERT
</cert>
<key>
TEST KEY
</key>
<tls-crypt>
TEST TLS KEY
</tls-crypt>
`;
const wg = "[Interface]\nPrivateKey = test\nAddress = 10.9.0.2/24\n[Peer]\nPublicKey = test\nAllowedIPs = 0.0.0.0/0\nEndpoint = exit.example.com:51820\n";

test("TCP profile preserves inline credentials and removes exported routes/DNS", () => {
  const config = normalizeOpenVpnConfig(ovpn + "redirect-gateway def1\nroute 0.0.0.0 0.0.0.0\ndhcp-option DNS 8.8.8.8\n");
  assert.match(config, /^dev tun-exit$/m);
  assert.match(config, /^remote exit.example.com 8443 tcp4-client$/m);
  assert.match(config, /^route-nopull$/m);
  assert.match(config, /^route-noexec$/m);
  assert.match(config, /<tls-crypt>\nTEST TLS KEY\n<\/tls-crypt>/);
  assert.doesNotMatch(config, /redirect-gateway|dhcp-option|^route /m);
  assert.equal(normalizeOpenVpnConfig(config), config);
  assert.match(normalizeOpenVpnConfig(ovpn.replaceAll("tls-crypt>", "tls-crypt-v2>")), /<tls-crypt-v2>/);
});

test("accepts OpenVPN UI privilege-drop options while keeping agent routing", () => {
  const exported = ovpn + "user nobody\ngroup nogroup\npersist-key\npersist-tun\nredirect-gateway def1\n";
  const normalized = normalizeOpenVpnConfig(exported);
  assert.match(normalized, /^user nobody$/m);
  assert.match(normalized, /^group nogroup$/m);
  assert.doesNotMatch(normalized, /^redirect-gateway/m);
  assert.equal(normalizeOpenVpnConfig(normalized), normalized);
});

test("rejects UDP, mismatched transport, scripts, includes and external secrets", () => {
  for (const config of [
    ovpn.replace("tcp4-client", "udp"),
    ovpn.replace("8443", "8443 udp"),
    ovpn + "up /tmp/hook\n",
    ovpn + "plugin /tmp/plugin.so\n",
    ovpn + "config /tmp/other.conf\n",
    ovpn + "ca /tmp/ca.crt\n",
    ovpn + "auth-user-pass\n",
    ovpn + "script-security 2\n",
    ovpn + "allow-compression yes\n",
    ovpn + "user nobody extra\n",
    ovpn + "group /tmp/account\n",
    ovpn.replace("</key>", ""),
  ]) assert.throws(() => normalizeOpenVpnConfig(config));
  assert.throws(() => relayProtocol("invalid"));
});

function adminFixture(directory) {
  const sourceFile = path.resolve(__dirname, "../web/wg-captive-admin.js");
  const localRequire = createRequire(sourceFile);
  const dbPath = path.join(directory, "state.db");
  const configFile = path.join(directory, "agent.env");
  const wgPath = path.join(directory, "exit.conf");
  const tcpPath = path.join(directory, "exit.ovpn");
  const agentBin = path.join(directory, "mock-agent");
  fs.writeFileSync(agentBin, "");
  fs.writeFileSync(configFile, `STATE_DB=${dbPath}\nRELAY_EXIT_CONF=${wgPath}\nRELAY_OPENVPN_CONF=${tcpPath}\nRELAY_AMNEZIAWG_CONF=${path.join(directory, "awg.conf")}\nEXPIRED_FILE=${path.join(directory, "expired.txt")}\nBACKUP_DIR=${path.join(directory, "backup")}\n`);
  const oldDb = new DatabaseSync(dbPath);
  oldDb.exec(`CREATE TABLE relay_config(id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, exit_if TEXT NOT NULL DEFAULT 'wg-exit', client_subnet TEXT NOT NULL DEFAULT '10.8.0.0/24', route_table INTEGER NOT NULL DEFAULT 200, exit_conf_path TEXT, exit_conf TEXT, imported_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  oldDb.prepare("INSERT INTO relay_config(id,exit_conf_path,exit_conf) VALUES(1,?,?)").run(wgPath, wg);
  oldDb.close();
  let agentStatus = "tunnel: DOWN\nroute: DISABLED\n";
  const commands = [];
  const childProcess = {
    execFileSync(command, args) {
      if (command === agentBin) return agentStatus;
      if (command !== "sqlite3") throw new Error("Unsupported fixture command: " + command);
      if (args[0] === "-version") return "3.45.0";
      const json = args[0] === "-json";
      const [file, sql] = json ? args.slice(1) : args;
      const db = new DatabaseSync(file);
      try {
        if (sql.startsWith(".backup")) { db.close(); fs.copyFileSync(file, sql.slice(9, -1).replace(/''/g, "'")); return ""; }
        if (json) return JSON.stringify(db.prepare(sql).all());
        if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return db.prepare(sql).all().map((row) => Object.values(row).join("|")).join("\n");
        db.exec(sql);
        return "";
      } finally { if (db.isOpen) db.close(); }
    },
    execFile(command, args, options, callback) {
      commands.push({ command, args });
      if (command === "tar") return require("node:child_process").execFile(command, args, options, callback);
      if (command !== agentBin) return callback(new Error("Unsupported fixture command"), "", "");
      callback(null, "ok", "");
    },
  };
  const source = fs.readFileSync(sourceFile, "utf8").split('\nif (process.env.CAPTIVE_REDIRECT_ONLY === "1")')[0];
  const context = {
    require(name) { return name === "child_process" ? childProcess : localRequire(name); },
    process: { env: { CONFIG_FILE: configFile, AGENT_BIN: agentBin } },
    console, Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setInterval,
  };
  vm.createContext(context);
  vm.runInContext(source + "\nthis.fixture = { initDb, loadConfig, dbRelayFull, relayStatus, importRelayConf, runRelayAction, queueRelayOperation, createBackup, restoreBackup, appPage, clientJs };", context);
  return { api: context.fixture, commands, setStatus(value) { agentStatus = value; }, wgPath, tcpPath, dbPath };
}

// Export the fixture for the optional Playwright check, without starting the admin server.
module.exports = { adminFixture, ovpn, wg };

test("old DB migrates without losing WG; imports remain independent; running profile is protected", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "captive-relay-test-"));
  try {
    const fixture = adminFixture(directory);
    const { api } = fixture;
    const config = api.loadConfig();
    assert.equal(config.RELAY_PROTOCOL, "wireguard");
    assert.equal(api.dbRelayFull(config).exit_conf, wg);
    await api.importRelayConf(config, ovpn, "openvpn");
    const relay = api.relayStatus(api.loadConfig());
    assert.equal(relay.protocol, "wireguard");
    assert.equal(relay.profiles.wireguard.exit_config, wg);
    assert.match(relay.profiles.openvpn.exit_config, /^proto tcp4-client$/m);
    fixture.setStatus("tunnel: UP\nroute: ENABLED\n");
    await assert.rejects(api.importRelayConf(config, wg, "wireguard"), /Stop this tunnel/);
    await api.importRelayConf(config, ovpn, "openvpn");
    const db = new DatabaseSync(fixture.dbPath);
    db.exec("UPDATE relay_config SET protocol='openvpn';");
    db.close();
    fixture.setStatus("openvpn_service: activating\ntunnel: DOWN\nroute: DISABLED\n");
    await assert.rejects(api.importRelayConf(api.loadConfig(), ovpn, "openvpn"), /Stop this tunnel/);
    await api.runRelayAction("relay-select", "openvpn");
    assert.deepEqual(Array.from(fixture.commands.at(-1).args), ["relay-select", "openvpn"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("relay operation queue survives failure and preserves order", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "captive-relay-test-"));
  try {
    const { api } = adminFixture(directory);
    const order = [];
    const first = api.queueRelayOperation(async () => { order.push("first"); throw new Error("test failure"); });
    const second = api.queueRelayOperation(async () => { order.push("second"); return 2; });
    await assert.rejects(first);
    assert.equal(await second, 2);
    assert.deepEqual(order, ["first", "second"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("backup and restore recover both profiles, selected TCP mode and blocked destinations", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "captive-relay-test-"));
  try {
    const { api, dbPath, tcpPath, wgPath, commands } = adminFixture(directory);
    await api.importRelayConf(api.loadConfig(), ovpn, "openvpn");
    let db = new DatabaseSync(dbPath);
    db.exec("UPDATE relay_config SET protocol='openvpn',enabled=1; INSERT INTO node_config(key,value) VALUES('BLOCKED_DEST_IPS','203.0.113.44');");
    db.close();
    const saved = await api.createBackup(api.loadConfig(), false);
    const archive = fs.readFileSync(saved.path);
    db = new DatabaseSync(dbPath);
    db.exec("UPDATE relay_config SET protocol='wireguard',openvpn_conf=NULL; UPDATE node_config SET value='' WHERE key='BLOCKED_DEST_IPS';");
    db.close();
    fs.writeFileSync(tcpPath, "stale TCP config");
    fs.writeFileSync(wgPath, "stale WG config");
    await api.restoreBackup(api.loadConfig(), archive);
    assert.equal(api.loadConfig().RELAY_PROTOCOL, "openvpn");
    assert.equal(api.loadConfig().BLOCKED_DEST_IPS, "203.0.113.44");
    assert.match(fs.readFileSync(tcpPath, "utf8"), /^proto tcp4-client$/m);
    assert.equal(fs.readFileSync(wgPath, "utf8"), wg);
    assert(commands.some((item) => item.args[0] === "relay-disable"));
    assert(commands.some((item) => item.args[0] === "relay-enable"));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("interactive relay changes reject a busy queue instead of waiting behind startup", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "captive-relay-test-"));
  try {
    const { api } = adminFixture(directory);
    let finish;
    const started = api.queueRelayOperation(() => new Promise((resolve) => { finish = resolve; }));
    await Promise.resolve();
    await Promise.resolve();
    let ran = false;
    await assert.rejects(api.queueRelayOperation(() => { ran = true; }, { wait: false }), /Another relay operation/);
    assert.equal(ran, false);
    finish();
    await started;
    assert.equal(await api.queueRelayOperation(() => 3, { wait: false }), 3);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
