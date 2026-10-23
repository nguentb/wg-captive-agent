"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { adminFixture, wg } = require("./relay.test");
const { relayProtocol } = require("../web/relay-config");

test("retired transport migrates disabled, preserves archived config and cannot appear in UI/API", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retired-transport-"));
  try {
    const fixture = adminFixture(dir);
    const db = new DatabaseSync(fixture.dbPath);
    db.exec("ALTER TABLE relay_config ADD COLUMN protocol TEXT DEFAULT 'wireguard'; ALTER TABLE relay_config ADD COLUMN xray_conf TEXT; UPDATE relay_config SET protocol='xray', enabled=1, xray_conf='archived-profile';");
    db.close();
    const config = fixture.api.loadConfig();
    assert.equal(config.RELAY_PROTOCOL, "wireguard");
    const row = fixture.api.dbRelayFull(config);
    assert.equal(row.enabled, 0);
    assert.equal(row.exit_conf, wg);
    assert.equal(row.xray_conf, "archived-profile");
    assert.deepEqual(Object.keys(fixture.api.relayStatus(config).profiles), ["wireguard", "openvpn", "amneziawg"]);
    assert.doesNotMatch(fixture.api.appPage(), /xray/i);
    assert.doesNotThrow(() => new (require("node:vm").Script)(fixture.api.clientJs()));
    assert.throws(() => relayProtocol("xray"), /Invalid/);
    await assert.rejects(fixture.api.importRelayConf(config, "{}", "xray"), /Invalid/);
    const saved = await fixture.api.createBackup(config, false);
    await fixture.api.restoreBackup(config, fs.readFileSync(saved.path));
    assert.equal(fixture.api.dbRelayFull(fixture.api.loadConfig()).xray_conf, "archived-profile");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
