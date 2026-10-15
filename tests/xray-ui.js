"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { adminFixture } = require("./relay.test");
const { DatabaseSync } = require("node:sqlite");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xray-ui-"));
  const { api, dbPath } = adminFixture(dir);
  api.loadConfig();
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE relay_config SET xray_conf_path=?").run(path.join(dir, "exit.json"));
  db.close();
  let relay = api.relayStatus(api.loadConfig());
  let operation = null;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === "/") { res.setHeader("Content-Type", "text/html"); return res.end(api.appPage()); }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/v1/state") return res.end(JSON.stringify({ config: {}, clients: [], relay }));
    if (req.url === "/api/v1/xray") return res.end(JSON.stringify({ relay, operation, version: "Xray 26.3.27" }));
    if (req.url === "/api/v1/xray/logs") return res.end(JSON.stringify({ logs: "No errors (mock)" }));
    if (req.url === "/api/v1/xray/import") {
      let body = ""; for await (const chunk of req) body += chunk;
      relay = await api.importRelayConf(api.loadConfig(), JSON.parse(body).content, "xray");
      return res.end(JSON.stringify({ relay }));
    }
    if (req.url === "/api/v1/xray/action") {
      let body = ""; for await (const chunk of req) body += chunk;
      const { action } = JSON.parse(body); requests.push(action);
      operation = { id: String(requests.length), state: "running" };
      res.statusCode = 202; res.end(JSON.stringify({ operation }));
      setTimeout(() => {
        if (action === "relay-select") relay = { ...relay, ...relay.profiles.xray, protocol: "xray" };
        if (action === "relay-tunnel-up") relay.tunnel_up = relay.tunnel_running = true;
        if (action === "relay-on") relay.route_enabled = true;
        if (action === "relay-off") relay.route_enabled = false;
        if (action === "relay-tunnel-down") relay.tunnel_up = relay.tunnel_running = relay.route_enabled = false;
        relay.status = `xray_service: ${relay.tunnel_up ? "active" : "inactive"}\ntunnel: ${relay.tunnel_up ? "UP" : "DOWN"}\nroute: ${relay.route_enabled ? "ENABLED" : "DISABLED"}`;
        operation.state = "complete";
        operation.result = action === "check" ? "Exit IP: 203.0.113.10" : "Complete";
      }, 50);
      return;
    }
    res.end("{}");
  });
  let browser;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { chromium } = require("playwright");
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button", { name: "Xray", exact: true }).click();
    await page.locator("#xrayInput").fill("vless://b4b3a86a-b3e9-4d5f-bc98-b647823a115c@exit.example.com:443?type=tcp&security=tls&sni=exit.example.com");
    await page.locator("#xrayImport").click();
    await page.waitForFunction(() => !document.querySelector("#xraySelect").disabled);
    await page.locator("#xraySelect").click();
    await page.waitForFunction(() => document.querySelector("#xraySelect").textContent === "Selected" && !document.querySelector("#XRAY_SERVICE").disabled);
    await page.locator("label:has(#XRAY_SERVICE)").click();
    await page.waitForFunction(() => !document.querySelector("#xrayCheck").disabled);
    assert.equal(await page.locator("#xrayServiceState").textContent(), "TUN ready");
    await page.locator("#xrayCheck").click();
    await page.waitForFunction(() => document.querySelector("#xrayResult").textContent.includes("Exit IP: 203.0.113.10"));
    await page.locator("label:has(#XRAY_ROUTE)").click();
    await page.waitForFunction(() => document.querySelector("#xraySummary").textContent === "Routing enabled");
    await page.getByRole("button", { name: "Relay", exact: true }).click();
    assert.equal(await page.locator("#relaySelectBtn").isDisabled(), true);
    assert.equal(await page.locator("#RELAY_MASTER").isDisabled(), true);
    await page.getByRole("button", { name: "Xray", exact: true }).click();
    fs.mkdirSync(path.resolve(".artifacts"), { recursive: true });
    await page.screenshot({ path: path.resolve(".artifacts/xray-desktop.png"), fullPage: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => document.querySelector(".app-shell").classList.add("sidebar-collapsed"));
      const overflow = await page.evaluate(() => ({ fits: document.documentElement.scrollWidth <= innerWidth, width: innerWidth, elements: [...document.querySelectorAll('#xrayTab *')].filter((el) => el.getBoundingClientRect().right > innerWidth).map((el) => [el.tagName, el.id, el.className, el.getBoundingClientRect().right]) }));
      assert.equal(overflow.fits, true, JSON.stringify(overflow));
      await page.screenshot({ path: path.resolve(`.artifacts/xray-mobile-${width}.png`), fullPage: true });
    }
    await page.locator("label:has(#XRAY_ROUTE)").click();
    await page.waitForFunction(() => !document.querySelector("#XRAY_ROUTE").checked && !document.querySelector("#XRAY_SERVICE").disabled);
    await page.locator("label:has(#XRAY_SERVICE)").click();
    await page.waitForFunction(() => document.querySelector("#xrayServiceState").textContent === "Stopped");
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, ["relay-select", "relay-tunnel-up", "check", "relay-on", "relay-off", "relay-tunnel-down"]);
    console.log("Xray UI: import, exclusive selection, async lifecycle/check, route and responsive layouts passed");
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
