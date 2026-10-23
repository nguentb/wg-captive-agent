"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { normalizeAmneziaConfig, relayProtocol } = require("../web/relay-config");
const { runtimeConfig } = require("../web/amnezia-config");
const { adminFixture, ovpn, wg } = require("./relay.test");
const key = Buffer.alloc(32, 7).toString("base64");
const awg = `[Interface]\nPrivateKey = ${key}\nAddress = 10.42.0.2/32\nDNS = 1.1.1.1\nTable = auto\nPostUp = touch /tmp/must-not-run\nSaveConfig = true\nJc = 4\nJmin = 40\nJmax = 70\nS1 = 64\nS2 = 40\nS3 = 20\nS4 = 16\nH1 = 100-200\nH2 = 300\nH3 = 400\nH4 = 500\nI1 = <b 0x010203>\n[Peer]\nPublicKey = ${key}\nPresharedKey = ${key}\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = exit.example.com:51820\n`;
module.exports = { awg };

test("AWG preserves modern parameters but cannot set DNS/routes or execute hooks", () => {
  assert.equal(relayProtocol("amneziawg"), "amneziawg");
  const normalized = normalizeAmneziaConfig(awg);
  for (const line of ["S3 = 20", "S4 = 16", "H1 = 100-200", "I1 = <b 0x010203>", "PersistentKeepalive = 25", "Table = off"]) assert(normalized.includes(line));
  assert.doesNotMatch(normalized, /DNS|PostUp|SaveConfig|touch/);
  assert.equal(normalizeAmneziaConfig(normalized), normalized);
  const advanced = awg.replace("I1 = <b 0x010203>", `I1 =\nHeaderProtectionKey = ${key}\nContentPaddingAddition = 10-20\nRekeyTimeout = 4-6\nRandomTrailers = on\nDisableCookies = 0`) + "AdvancedSecurity = on\nPersistentKeepalive = 20-25\n";
  const v3 = normalizeAmneziaConfig(advanced);
  assert(v3.includes(`HeaderProtectionKey = ${key}`));
  assert(v3.includes("PersistentKeepalive = 20-25"));
  assert.equal(normalizeAmneziaConfig(v3), v3);
});

test("AWG rejects incomplete, multiple-exit, invalid and unsupported profiles", () => {
  for (const input of [
    awg.replace("10.42.0.2/32", "not-an-ip/32"),
    awg.replace("0.0.0.0/0", "10.0.0.0/8"),
    awg.replace(`PrivateKey = ${key}`, "PrivateKey = invalid"),
    awg.replace("S3 = 20", "S3 = 999999"),
    awg.replace("H1 = 100-200", "H1 = 200-100"),
    awg.replace("51820", "99999"), awg + "Unknown = 1\n", awg + "[Peer]\n",
    awg.replace("Jc = 4", "Jc = 4\nJc = 5"), awg + "\0",
    awg.replace("S1 = 64", "NewOption = 64"),
  ]) assert.throws(() => normalizeAmneziaConfig(input));
});

test("AWG resolves endpoints on host, supports IPv6 literals and preserves credentials", () => {
  let resolved = "";
  const runtime = runtimeConfig(awg, (host) => { resolved = host; return "203.0.113.10"; });
  assert.equal(resolved, "exit.example.com");
  assert.match(runtime, /^Endpoint = 203.0.113.10:51820$/m);
  assert(runtime.includes(`PrivateKey = ${key}`));
  assert.match(runtimeConfig(awg, () => "2001:db8::1"), /^Endpoint = \[2001:db8::1\]:51820$/m);
  assert.match(runtimeConfig(awg.replace("exit.example.com", "[2001:db8::2]"), () => { throw new Error("must not resolve literal"); }), /\[2001:db8::2\]:51820/);
  assert.throws(() => runtimeConfig(awg, () => ""), /Cannot resolve/);
});

test("AWG profile is independent, protects active service and survives backup/migration", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awg-test-"));
  try {
    const fixture = adminFixture(dir), { api } = fixture;
    await api.importRelayConf(api.loadConfig(), ovpn, "openvpn");
    await api.importRelayConf(api.loadConfig(), awg, "amneziawg");
    const db = new DatabaseSync(fixture.dbPath);
    db.exec("UPDATE relay_config SET protocol='amneziawg'");
    db.close();
    const config = api.loadConfig();
    assert.equal(config.RELAY_PROTOCOL, "amneziawg");
    assert.equal(api.dbRelayFull(config).exit_conf, wg);
    fixture.setStatus("amneziawg_service: active\ntunnel: DOWN\nroute: DISABLED\n");
    assert.equal(api.relayStatus(config).tunnel_running, true);
    await assert.rejects(api.importRelayConf(config, awg, "amneziawg"), /Stop this tunnel/);
    fixture.setStatus("tunnel: DOWN\nroute: DISABLED\n");
    const backup = await api.createBackup(config, false);
    const saved = fs.readFileSync(config.RELAY_AMNEZIAWG_CONF, "utf8");
    fs.unlinkSync(config.RELAY_AMNEZIAWG_CONF);
    await api.restoreBackup(config, fs.readFileSync(backup.path));
    assert.equal(api.loadConfig().RELAY_PROTOCOL, "amneziawg");
    assert.equal(fs.readFileSync(config.RELAY_AMNEZIAWG_CONF, "utf8"), saved);
    assert.equal(api.relayStatus(api.loadConfig()).profiles.openvpn.imported, true);
    await api.runRelayAction("relay-select", "amneziawg");
    assert.deepEqual(Array.from(fixture.commands.at(-1).args), ["relay-select", "amneziawg"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
