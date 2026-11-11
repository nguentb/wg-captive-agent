"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { normalizeRealityConfig, runtime } = require("../web/reality-config");
const { adminFixture } = require("./relay.test");

const profile = {
  address: "exit.example.com", port: 8443, uuid: "01381da5-93c4-424b-92c0-5093d70e07bc",
  sni: "www.example.com", publicKey: Buffer.alloc(32, 9).toString("base64url"),
  shortId: "1234", fingerprint: "chrome", spiderX: ""
};
const link = `vless://${profile.uuid}@${profile.address}:8443?type=tcp&security=reality&flow=xtls-rprx-vision&sni=${profile.sni}&pbk=${profile.publicKey}&sid=1234`;

test("Xray profile link and form produce only managed TUN and REALITY options", () => {
  assert.deepEqual(JSON.parse(normalizeRealityConfig(link)), profile);
  const config = runtime(JSON.stringify(profile), "203.0.113.9");
  assert.deepEqual(config.inbounds[0].settings, { name: "xray-exit", mtu: 1420 });
  assert.equal(config.inbounds[1].listen, "127.0.0.1");
  const outbound = config.outbounds[0];
  assert.equal(outbound.settings.vnext[0].address, "203.0.113.9");
  assert.equal(outbound.streamSettings.realitySettings.serverName, profile.sni);
  assert.equal(outbound.streamSettings.realitySettings.password, profile.publicKey);
  assert.throws(() => runtime(link, "unresolved.example.com"));
  for (const invalid of [
    link + "&sid=34", link + "&allowInsecure=1", link.replace("type=tcp", "type=xhttp"),
    link.replace("security=reality", "security=none"), link.replace("sid=1234", "sid=123"),
    JSON.stringify({ ...profile, inbounds: [] }), JSON.stringify({ ...profile, port: 0 })
  ]) assert.throws(() => normalizeRealityConfig(invalid));
});

test("Xray profile secrets stay out of relay state; live and pending routes protect edits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reality-test-"));
  try {
    const fixture = adminFixture(dir);
    const api = fixture.api;
    await api.importRelayConf(api.loadConfig(), link, "reality");
    const db = new DatabaseSync(fixture.dbPath);
    db.exec("UPDATE relay_config SET protocol='reality' WHERE id=1");
    db.close();
    const config = api.loadConfig();
    const status = api.relayStatus(config);
    assert.equal(status.protocol, "reality");
    assert.equal(status.endpoint.address, profile.address);
    assert.equal(status.imported, true);
    assert.equal(status.exit_config, "");
    assert(!JSON.stringify(status).includes(profile.uuid));
    assert(!JSON.stringify(status).includes(profile.publicKey));
    for (const text of ["reality_service: activating\ntunnel: DOWN", "route_requested: yes\nroute: DISABLED"]) {
      fixture.setStatus(text);
      await assert.rejects(api.importRelayConf(config, link, "reality"), /Stop this tunnel/);
    }
    fixture.setStatus("tunnel: DOWN\nroute: DISABLED");
    const backup = await api.createBackup(config, false);
    fs.unlinkSync(config.RELAY_REALITY_CONF);
    await api.restoreBackup(config, fs.readFileSync(backup.path));
    assert.deepEqual(JSON.parse(fs.readFileSync(config.RELAY_REALITY_CONF)), profile);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
