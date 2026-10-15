"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { normalizeXrayConfig, buildXrayRuntime } = require("../web/xray-config");
const { adminFixture, ovpn } = require("./relay.test");
const link = "vless://b4b3a86a-b3e9-4d5f-bc98-b647823a115c@exit.example.com:443?type=tcp&security=tls&sni=exit.example.com";

test("VLESS/Trojan imports preserve security, transport and encoded credentials", () => {
  const profile = JSON.parse(normalizeXrayConfig(link));
  assert.equal(profile.protocol, "vless");
  assert.equal(profile.streamSettings.network, "raw");
  assert.equal(profile.streamSettings.tlsSettings.serverName, "exit.example.com");
  const trojan = JSON.parse(normalizeXrayConfig("trojan://p%40ss%3Aword@[2001:db8::1]:8443?type=ws&security=tls&host=example.com&path=%2Fvpn"));
  assert.equal(trojan.settings.servers[0].password, "p@ss:word");
  assert.equal(trojan.settings.servers[0].address, "2001:db8::1");
  assert.equal(trojan.streamSettings.wsSettings.path, "/vpn");
  const reality = JSON.parse(normalizeXrayConfig(link.replace("security=tls", "security=reality&pbk=testkey&sid=abcd&fp=chrome&flow=xtls-rprx-vision")));
  assert.equal(reality.streamSettings.realitySettings.publicKey, "testkey");
  assert.equal(reality.settings.vnext[0].users[0].flow, "xtls-rprx-vision");
  const xhttp = JSON.parse(normalizeXrayConfig(link.replace("type=tcp", "type=xhttp&mode=auto&path=%2Ftest&extra=%7B%22noGRPCHeader%22%3Atrue%7D")));
  assert.equal(xhttp.streamSettings.xhttpSettings.extra.noGRPCHeader, true);
  assert.equal(normalizeXrayConfig(JSON.stringify(profile)), normalizeXrayConfig(link));
});

test("unsupported options and unsafe file/route overrides never silently take effect", () => {
  for (const input of [link + "&unknown=yes", link + "&allowInsecure=1", link + "&type=ws", link.replace("type=tcp", "type=kcp"), link.replace("type=tcp", "type=tcp&path=/lost"), link.replace("security=tls", "security=reality"), "{}", "not a config"]) assert.throws(() => normalizeXrayConfig(input));
  const outbound = JSON.parse(normalizeXrayConfig(link));
  outbound.streamSettings.sockopt = { mark: 32 };
  assert.throws(() => normalizeXrayConfig(JSON.stringify(outbound)), /sockopt/);
  delete outbound.streamSettings.sockopt;
  outbound.streamSettings.tlsSettings.certificates = [{ certificateFile: "/etc/shadow" }];
  assert.throws(() => normalizeXrayConfig(JSON.stringify(outbound)), /certificate/);
  assert.throws(() => normalizeXrayConfig(JSON.stringify({ outbounds: [outbound, outbound] })), /exactly one/);
});

test("runtime owns TUN, routing and DNS; imported full config contributes only the exit", () => {
  const outbound = JSON.parse(normalizeXrayConfig(link));
  const runtime = buildXrayRuntime(JSON.stringify({ outbounds: [outbound, { protocol: "freedom" }], dns: { servers: ["8.8.8.8"] }, inbounds: [{ listen: "0.0.0.0" }], routing: { rules: [{ outboundTag: "direct" }] } }), "203.0.113.10");
  assert.equal(runtime.outbounds.length, 1);
  assert.equal(runtime.outbounds[0].settings.vnext[0].address, "203.0.113.10");
  assert.equal(runtime.outbounds[0].streamSettings.tlsSettings.serverName, "exit.example.com");
  assert.deepEqual(runtime.inbounds[0].settings, { name: "xray-exit", mtu: 1500 });
  assert.equal(runtime.inbounds[1].listen, "127.0.0.1");
  assert.equal(runtime.dns, undefined);
  assert.deepEqual(runtime.routing.rules, []);
  assert.throws(() => buildXrayRuntime(link, "not-an-ip"));
  const ws = buildXrayRuntime(link.replace("type=tcp", "type=ws&path=%2Frelay"), "203.0.113.10");
  assert.equal(ws.outbounds[0].streamSettings.wsSettings.headers.Host, "exit.example.com");
});

test("generated outbounds pass the actual Xray core config test without creating host interfaces", { skip: !process.env.XRAY_TEST_BIN }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xray-core-check-"));
  try {
    const profiles = [link, link.replace("type=tcp", "type=ws&host=exit.example.com&path=%2Fvpn"), link.replace("type=tcp", "type=grpc&serviceName=relay"), link.replace("type=tcp", "type=xhttp&mode=auto&path=%2Frelay"), "trojan://test-password@exit.example.com:443?security=tls&type=tcp", link.replace("security=tls", "security=reality&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=abcd&flow=xtls-rprx-vision")];
    for (const profile of profiles) {
      const file = path.join(dir, "runtime.json");
      const runtime = buildXrayRuntime(profile, "203.0.113.10");
      runtime.inbounds = runtime.inbounds.filter((inbound) => inbound.protocol !== "tun");
      fs.writeFileSync(file, JSON.stringify(runtime));
      require("node:child_process").execFileSync(process.env.XRAY_TEST_BIN, ["run", "-test", "-config", file], { timeout: 8000 });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("migration, independent profile, running guard, backup and restore include Xray", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "captive-xray-"));
  try {
    const { api, dbPath, setStatus } = adminFixture(dir);
    let db = new DatabaseSync(dbPath);
    api.loadConfig();
    const file = path.join(dir, "exit.json");
    db.prepare("UPDATE relay_config SET xray_conf_path=?").run(file);
    db.close();
    await api.importRelayConf(api.loadConfig(), link, "xray");
    await api.importRelayConf(api.loadConfig(), ovpn, "openvpn");
    let relay = api.relayStatus(api.loadConfig());
    assert.equal(relay.profiles.xray.imported, true);
    assert.equal(relay.profiles.openvpn.imported, true);
    assert.equal(relay.profiles.wireguard.imported, true);
    const saved = await api.createBackup(api.loadConfig(), false);
    db = new DatabaseSync(dbPath);
    db.exec("UPDATE relay_config SET xray_conf=NULL;");
    db.close();
    fs.writeFileSync(file, "stale");
    await api.restoreBackup(api.loadConfig(), fs.readFileSync(saved.path));
    assert.equal(JSON.parse(fs.readFileSync(file)).protocol, "vless");
    await api.runRelayAction("relay-select", "xray");
    db = new DatabaseSync(dbPath);
    db.exec("UPDATE relay_config SET protocol='xray';");
    db.close();
    relay = api.relayStatus(api.loadConfig());
    assert.equal(relay.protocol, "xray");
    setStatus("xray_service: active\ntunnel: UP\nroute: DISABLED\n");
    await assert.rejects(api.importRelayConf(api.loadConfig(), link, "xray"), /Stop this tunnel/);
    assert.equal(api.relayStatus(api.loadConfig()).tunnel_running, true);
    const operation = api.startXrayOperation("relay-off");
    assert.equal(operation.state, "running");
    assert.throws(() => api.startXrayOperation("relay-on"), /operation is running/);
    await api.queueRelayOperation(async () => {});
    assert.equal(operation.state, "complete");
    assert.equal(operation.result, "ok");
    assert.throws(() => api.startXrayOperation("arbitrary-command"), /Invalid Xray action/);
    assert.doesNotMatch(api.redactXray(api.loadConfig(), "failure: " + JSON.parse(normalizeXrayConfig(link)).settings.vnext[0].users[0].id), /b4b3a86a/);
    const script = api.clientJs();
    new (require("node:vm").Script)(script);
    assert.match(api.appPage(), /data-tab="xray"/);
    assert.match(api.appPage(), /id="xrayTab"/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
