"use strict";
const { isIP } = require("node:net");
const fs = require("node:fs");

function host(value) {
  return typeof value === "string" && value.length <= 253 &&
    (isIP(value) || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value));
}

function normalizeRealityConfig(input) {
  const text = String(input).trim();
  if (text.length > 8192) throw new Error("Xray profile is too large");
  let value;
  if (text.startsWith("vless://")) {
    const url = new URL(text);
    const q = url.searchParams;
    const supported = new Set(["security","type","flow","encryption","sni","pbk","sid","fp","spx","headerType"]);
    for (const [key] of q) {
      if (!supported.has(key) || q.getAll(key).length !== 1) throw new Error("Unsupported or duplicate VLESS parameter");
    }
    if (url.password || (url.pathname && url.pathname !== "/") || q.get("security") !== "reality" ||
        !["tcp","raw"].includes(q.get("type") || "tcp") || q.get("flow") !== "xtls-rprx-vision" ||
        (q.get("encryption") || "none") !== "none" || (q.get("headerType") || "none") !== "none") {
      throw new Error("Use a VLESS RAW/TCP + REALITY + Vision profile");
    }
    value = { address: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 443),
      uuid: decodeURIComponent(url.username), sni: q.get("sni"), publicKey: q.get("pbk"),
      shortId: q.get("sid") || "", fingerprint: q.get("fp") || "chrome", spiderX: q.get("spx") || "" };
  } else {
    try { value = JSON.parse(text); } catch { throw new Error("Invalid Xray profile JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(k => !["address","port","uuid","sni","publicKey","shortId","fingerprint","spiderX"].includes(k))) {
    throw new Error("Expected Xray profile fields, not a full core configuration");
  }
  const {address, port, uuid, sni, publicKey, shortId = "", fingerprint = "chrome", spiderX = ""} = value;
  if (!host(address) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Xray server address or port");
  if (typeof uuid !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid)) throw new Error("Invalid VLESS UUID");
  if (!host(sni) || isIP(sni) || !sni.includes(".")) throw new Error("REALITY SNI must be a DNS name");
  if (typeof publicKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(publicKey) ||
      Buffer.from(publicKey,"base64url").toString("base64url") !== publicKey) throw new Error("Invalid REALITY public key");
  if (typeof shortId !== "string" || !/^(?:[0-9a-f]{2}){0,8}$/i.test(shortId)) throw new Error("Short ID must have 0–16 hex digits in pairs");
  if (!["chrome","firefox","safari","edge","ios","android"].includes(fingerprint)) throw new Error("Unsupported TLS fingerprint");
  if (typeof spiderX !== "string" || spiderX.length > 256 || (spiderX && !/^\/[^\x00-\x20]*$/.test(spiderX))) throw new Error("Invalid SpiderX path");
  return JSON.stringify({address, port, uuid, sni, publicKey, shortId, fingerprint, spiderX}) + "\n";
}

function runtime(input, address) {
  const p = JSON.parse(normalizeRealityConfig(input));
  if (!isIP(address)) throw new Error("Xray endpoint must resolve on the host");
  return {
    log: { loglevel: "warning" },
    inbounds: [
      { tag: "relay", protocol: "tun", settings: { name: "xray-exit", mtu: 1420 } },
      { tag: "probe", protocol: "socks", listen: "127.0.0.1", port: 51824, settings: { udp: false } }
    ],
    outbounds: [{ protocol: "vless", tag: "exit", settings: { vnext: [{ address, port: p.port,
      users: [{ id: p.uuid, encryption: "none", flow: "xtls-rprx-vision" }] }] },
      streamSettings: { network: "raw", security: "reality", realitySettings: {
        serverName: p.sni, fingerprint: p.fingerprint, password: p.publicKey, shortId: p.shortId, spiderX: p.spiderX
      } } }]
  };
}

module.exports = { normalizeRealityConfig, runtime };
if (require.main === module) {
  const [action, file, ip] = process.argv.slice(2);
  try {
    const input = fs.readFileSync(file);
    if (action === "endpoint") console.log(JSON.parse(normalizeRealityConfig(input)).address);
    else if (action === "runtime") console.log(JSON.stringify(runtime(input, ip)));
    else throw new Error("Invalid Xray helper command");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
