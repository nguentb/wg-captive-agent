"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { adminFixture } = require("./relay.test");
const { awg } = require("./amneziawg.test");
const preview = process.argv.includes("--preview");

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "captive-relay-ui-"));
  const { api } = adminFixture(directory);
  await api.importRelayConf(api.loadConfig(), awg, "amneziawg");
  let relay = api.relayStatus(api.loadConfig());
  const profiles = JSON.parse(JSON.stringify(relay.profiles));
  const errors = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html");
      const html = api.appPage();
      return res.end(preview ? html.replace("</body>", '<script>document.querySelector(\'[data-tab="relay"]\').click()</script></body>') : html);
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/v1/state") return res.end(JSON.stringify({ config: {}, clients: [], relay }));
    if (req.url === "/api/v1/settings") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const config = JSON.parse(text);
      assert.equal(config.BLOCKED_DEST_IPS, "203.0.113.10");
      assert.equal(config.BLOCKED_DEST_ENABLED, "0");
      return res.end(JSON.stringify({ ok: true, config, result: { ok: true } }));
    }
    if (req.url === "/api/v1/relay") return res.end(JSON.stringify({ config: {}, relay }));
    if (req.url === "/api/v1/relay/reality/profile") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      const saved = await api.importRelayConf(api.loadConfig(), body.link || JSON.stringify(body.profile), "reality");
      profiles.reality = saved.profiles.reality;
      relay.profiles = profiles;
      return res.end(JSON.stringify({ ok: true, relay }));
    }
    if (req.url === "/api/v1/relay/action") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      if (body.action === "relay-reality-test") {
        return res.end(JSON.stringify({ config: {}, relay: { ...relay, last_result: { stdout: "ip=203.0.113.9\n" } } }));
      }
      if (body.action === "relay-select") {
        assert.equal(relay.tunnel_up, false);
        assert.equal(relay.route_enabled, false);
        relay = { ...profiles[body.protocol], profiles, tunnel_up: false, route_enabled: false, status: "tunnel: DOWN\nroute: DISABLED" };
      } else if (body.action === "relay-enable") {
        relay.tunnel_up = relay.route_enabled = true;
        relay.status = "tunnel: UP\nroute: ENABLED";
      } else if (body.action === "relay-disable") {
        relay.tunnel_up = relay.route_enabled = false;
        relay.status = "tunnel: DOWN\nroute: DISABLED";
      } else if (["relay-tunnel-up", "relay-restart"].includes(body.action)) {
        relay.tunnel_up = true;
      } else if (body.action === "relay-tunnel-down") {
        relay.tunnel_up = relay.route_enabled = false;
      } else if (body.action === "relay-on") {
        relay.tunnel_up = relay.route_enabled = true;
      } else if (body.action === "relay-off") {
        relay.route_enabled = false;
      } else if (body.action === "relay-delete-config") {
        relay.imported = profiles[relay.protocol].imported = false;
        relay.exit_config = profiles[relay.protocol].exit_config = "";
      }
      relay.status = `relay_protocol: ${relay.protocol}\ntunnel: ${relay.tunnel_up ? "UP" : "DOWN"}\nroute: ${relay.route_enabled ? "ENABLED" : "DISABLED"}`;
      return res.end(JSON.stringify({ config: {}, relay }));
    }
    res.end("{}");
  });
  let browser;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    if (preview) {
      console.log(`Relay preview: http://127.0.0.1:${server.address().port}`);
      await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
      return;
    }
    const { chromium } = require("playwright");
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button", { name: "Relay", exact: true }).click();
    await page.getByRole("tab", { name: "AmneziaWG UDP" }).click();
    await page.getByRole("button", { name: "Use this tunnel" }).click();
    await page.waitForFunction(() => document.querySelector("#relaySelectBtn").textContent === "Selected");
    assert.equal(await page.locator("#relayTunnelLabel").textContent(), "awg-exit / UDP");
    assert.equal(await page.locator("#relayLogsBtn").textContent(), "AmneziaWG logs");
    assert.equal(await page.locator("#relayImportBtn").textContent(), "Import .conf");
    await page.locator("label:has(#RELAY_MASTER)").click();
    await page.waitForFunction(() => document.querySelector("#RELAY_ROUTE").checked);
    await page.getByRole("tab", { name: "WireGuard UDP" }).click();
    assert.equal(await page.locator("#relaySelectBtn").isDisabled(), true);
    await page.locator("label:has(#RELAY_MASTER)").click();
    await page.waitForFunction(() => !document.querySelector("#relaySelectBtn").disabled);
    assert.equal(await page.getByRole("tab", { name: "OpenVPN TCP" }).count(), 0);
    await page.getByRole("button", { name: "Use this tunnel" }).click();
    await page.waitForFunction(() => document.querySelector("#relaySelectBtn").textContent === "Selected");
    assert.equal(await page.locator("#relayImportBtn").textContent(), "Import .conf");
    relay.tunnel_up = false;
    relay.tunnel_running = true;
    relay.route_enabled = false;
    await page.locator("#relayRefreshBtn").click();
    await page.waitForFunction(() => document.querySelector("#relayActiveLabel").textContent.includes("Connecting / reconnecting"));
    relay.tunnel_running = false;
    await page.locator("#relayRefreshBtn").click();
    await page.waitForFunction(() => document.querySelector("#relayActiveLabel").textContent.includes("Stopped"));
    await page.getByRole("tab", { name: "AmneziaWG UDP" }).click();
    await page.getByRole("button", { name: "Use this tunnel" }).click();
    await page.waitForFunction(() => document.querySelector("#relaySelectBtn").textContent === "Selected");
    fs.mkdirSync(path.resolve(".artifacts"), { recursive: true });
    await page.screenshot({ path: path.resolve(".artifacts/relay-desktop.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.querySelector(".app-shell").classList.add("sidebar-collapsed"));
    await page.screenshot({ path: path.resolve(".artifacts/relay-mobile.png"), fullPage: true, animations: "disabled" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("tab", { name: "Xray REALITY" }).click();
    assert.equal(await page.locator("#relayFilePanel").isVisible(), false);
    await page.getByLabel("Profile input").selectOption("link");
    await page.getByLabel("VLESS link", { exact: true }).fill("vless://01381da5-93c4-424b-92c0-5093d70e07bc@exit.example.com:8443?security=reality&flow=xtls-rprx-vision&sni=www.example.com&pbk=" + Buffer.alloc(32,9).toString("base64url") + "&sid=1234");
    await page.getByRole("button", { name: "Save profile" }).click();
    await page.waitForFunction(() => document.querySelector("#realitySummary").textContent.includes("exit.example.com"));
    assert.equal(await page.locator("#realityForm input[name=link]").inputValue(), "");
    await page.getByRole("button", { name: "Use this tunnel" }).click();
    await page.waitForFunction(() => document.querySelector("#relaySelectBtn").textContent === "Selected");
    await page.screenshot({ path: path.resolve(".artifacts/reality-desktop.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Edit profile" }).click();
    assert.equal(await page.getByLabel("Server address").inputValue(), "exit.example.com");
    await page.getByRole("button", { name: "Cancel edit" }).click();
    await page.locator("label:has(#RELAY_TUNNEL)").click();
    await page.getByRole("button", { name: "Test TCP egress" }).click();
    await page.waitForFunction(() => document.querySelector("#realityTestResult").textContent.includes("203.0.113.9"));
    assert.equal(await page.locator("#realitySave").isDisabled(), true);
    assert.equal(await page.locator("#RELAY_ROUTE").isChecked(), false);
    for (const width of [390,320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => scrollTo(0,0));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.resolve(".artifacts/reality-mobile-"+width+".png"), fullPage: true, animations: "disabled" });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
    const blockToggle = page.locator("#BLOCKED_DEST_ENABLED");
    const blockList = page.locator("#BLOCKED_DEST_IPS");
    assert(await blockList.isDisabled());
    await blockToggle.check();
    await blockList.fill("203.0.113.10");
    await blockToggle.uncheck();
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.waitForFunction(() => document.querySelector("#toast").textContent === "Settings saved");
    assert(await blockList.isDisabled());
    assert.equal(await blockList.inputValue(), "203.0.113.10");
    assert.deepEqual(errors, []);
    console.log("Relay UI: desktop/mobile and manual protocol switching passed");
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
