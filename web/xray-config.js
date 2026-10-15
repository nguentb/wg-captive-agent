"use strict";

const net = require("node:net");

function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function endpoint(outbound) {
  const settings = outbound.settings || {};
  const server = settings.vnext?.[0] || settings.servers?.[0] || settings;
  if (typeof server.address !== "string" || !server.address || /[\s/\\\0]/.test(server.address) || !Number.isInteger(server.port) || server.port < 1 || server.port > 65535) throw new Error("Invalid Xray endpoint");
  return server;
}

function parseLink(text) {
  const url = new URL(text);
  const protocol = url.protocol.slice(0, -1);
  if (!["vless", "trojan"].includes(protocol) || url.password) throw new Error("Use a vless:// or trojan:// link");
  const params = url.searchParams;
  const allowed = new Set(["type", "security", "encryption", "flow", "sni", "serverName", "fp", "pbk", "sid", "spx", "alpn", "host", "path", "serviceName", "mode", "authority", "headerType", "extra", "allowInsecure"]);
  for (const key of params.keys()) {
    if (!allowed.has(key)) throw new Error(`Unsupported link parameter: ${key}; import Xray outbound JSON instead`);
    if (params.getAll(key).length !== 1) throw new Error(`Duplicate link parameter: ${key}`);
  }
  if (params.has("allowInsecure") && !["0", "false"].includes(params.get("allowInsecure"))) throw new Error("TLS certificate verification cannot be disabled");
  const address = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || 443);
  const credential = decodeURIComponent(url.username);
  if (!credential) throw new Error("Missing Xray credential");
  const type = params.get("type") || "tcp";
  const network = type === "tcp" ? "raw" : type;
  if (!["raw", "ws", "grpc", "httpupgrade", "xhttp"].includes(network)) throw new Error(`Unsupported link transport: ${type}; import outbound JSON instead`);
  const security = params.get("security") || (protocol === "trojan" ? "tls" : "none");
  if (!["none", "tls", "reality"].includes(security)) throw new Error("Unsupported transport security");
  const streamSettings = { network, security };
  const serverName = params.get("sni") || params.get("serverName") || address;
  if (security === "tls") {
    streamSettings.tlsSettings = { serverName, allowInsecure: false };
    if (params.get("fp")) streamSettings.tlsSettings.fingerprint = params.get("fp");
    if (params.get("alpn")) streamSettings.tlsSettings.alpn = params.get("alpn").split(",");
  } else if (security === "reality") {
    if (!params.get("pbk")) throw new Error("REALITY requires pbk");
    streamSettings.realitySettings = { serverName, fingerprint: params.get("fp") || "chrome", publicKey: params.get("pbk"), shortId: params.get("sid") || "", spiderX: params.get("spx") || "" };
  }
  const host = params.get("host") || "";
  const path = params.get("path") || "/";
  if (network === "raw") {
    const header = params.get("headerType") || "none";
    if (header !== "none") throw new Error("RAW headers require outbound JSON");
  } else if (network === "grpc") {
    const mode = params.get("mode") || "gun";
    if (!["gun", "multi"].includes(mode)) throw new Error("Unsupported gRPC mode");
    streamSettings.grpcSettings = { serviceName: params.get("serviceName") || "", multiMode: mode === "multi", authority: params.get("authority") || host };
  } else if (network === "xhttp") {
    streamSettings.xhttpSettings = { path, host, mode: params.get("mode") || "auto" };
    if (params.has("extra")) streamSettings.xhttpSettings.extra = JSON.parse(params.get("extra"));
  } else {
    streamSettings[network === "ws" ? "wsSettings" : "httpupgradeSettings"] = network === "ws" ? { path, headers: host ? { Host: host } : {} } : { path, host };
  }
  // Reject irrelevant parameters rather than silently changing the exported profile.
  const transportParams = { path: ["ws", "httpupgrade", "xhttp"], host: ["ws", "httpupgrade", "xhttp", "grpc"], serviceName: ["grpc"], authority: ["grpc"], mode: ["grpc", "xhttp"], extra: ["xhttp"], headerType: ["raw"] };
  for (const [key, networks] of Object.entries(transportParams)) if (params.get(key) && !networks.includes(network)) throw new Error(`${key} does not apply to ${network}`);
  if (security === "none" && ["sni", "serverName", "fp", "alpn", "pbk", "sid", "spx"].some((key) => params.get(key))) throw new Error("Security parameters supplied without TLS/REALITY");
  if (protocol === "trojan" && (params.get("flow") || params.get("encryption"))) throw new Error("VLESS parameters supplied for Trojan");
  const user = { id: credential, encryption: params.get("encryption") || "none" };
  if (params.get("flow")) user.flow = params.get("flow");
  return { protocol, settings: protocol === "vless" ? { vnext: [{ address, port, users: [user] }] } : { servers: [{ address, port, password: credential }] }, streamSettings };
}

function normalizeXrayConfig(input) {
  const text = input.toString("utf8").trim();
  if (!text || text.length > 1024 * 1024 || text.includes("\0")) throw new Error("Invalid Xray config");
  let outbound;
  if (/^(vless|trojan):\/\//.test(text)) outbound = parseLink(text);
  else {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.outbounds)) {
      const candidates = parsed.outbounds.filter((item) => ["vless", "trojan"].includes(item.protocol));
      if (candidates.length !== 1) throw new Error("JSON must contain exactly one VLESS/Trojan outbound");
      outbound = candidates[0];
    } else outbound = parsed;
  }
  if (!object(outbound) || !["vless", "trojan"].includes(outbound.protocol)) throw new Error("Expected VLESS or Trojan outbound");
  for (const key of Object.keys(outbound)) if (!["protocol", "settings", "streamSettings", "mux", "tag"].includes(key)) throw new Error(`Unsupported outbound field: ${key}`);
  if (outbound.settings?.vnext?.length > 1 || outbound.settings?.servers?.length > 1) throw new Error("Use one Xray exit endpoint");
  const server = endpoint(outbound);
  if (outbound.protocol === "vless") {
    const users = server.users || [server];
    if (users.length !== 1 || !users[0].id || typeof users[0].encryption !== "string") throw new Error("VLESS needs one id and encryption setting");
    if (users[0].reverse) throw new Error("Reverse proxy is not supported for relay");
  } else if (!server.password) throw new Error("Missing Trojan password");
  // No imported file paths, external helpers, socket marks or proxy chains.
  function inspect(value) {
    if (!object(value) && !Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (/file|sockopt|dialerProxy|downloadSettings|certificate|keyLog|allowInsecure|insecure/i.test(key) && child !== false) throw new Error(`Unsupported or unsafe outbound setting: ${key}`);
      inspect(child);
    }
  }
  inspect(outbound);
  const result = { ...outbound, tag: "exit" };
  return JSON.stringify(result, null, 2) + "\n";
}

function buildXrayRuntime(input, resolvedAddress) {
  const outbound = JSON.parse(normalizeXrayConfig(input));
  if (!net.isIP(resolvedAddress)) throw new Error("Xray endpoint must be resolved on the host");
  const server = endpoint(outbound);
  const original = server.address;
  server.address = resolvedAddress;
  const stream = outbound.streamSettings ||= {};
  if (stream.security === "tls") (stream.tlsSettings ||= {}).serverName ||= original;
  if (stream.network === "ws") {
    const ws = stream.wsSettings ||= {};
    const headers = ws.headers ||= {};
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "host") && !ws.host) headers.Host = original;
  }
  if (stream.network === "httpupgrade") (stream.httpupgradeSettings ||= {}).host ||= original;
  if (stream.network === "xhttp") (stream.xhttpSettings ||= {}).host ||= original;
  if (stream.network === "grpc") (stream.grpcSettings ||= {}).authority ||= original;
  // Only forwarded, marked wg0 packets use the TUN. Xray's sockets use main.
  return { log: { loglevel: "warning" }, inbounds: [
    { tag: "tun", protocol: "tun", settings: { name: "xray-exit", mtu: 1500 } },
    { tag: "health", listen: "127.0.0.1", port: 51824, protocol: "socks", settings: { auth: "noauth", udp: false } },
  ], outbounds: [outbound], routing: { domainStrategy: "AsIs", rules: [] } };
}

module.exports = { normalizeXrayConfig, buildXrayRuntime, endpoint };

if (require.main === module) {
  const fs = require("node:fs");
  const [action, file, resolved] = process.argv.slice(2);
  const input = fs.readFileSync(file);
  if (action === "endpoint") console.log(endpoint(JSON.parse(normalizeXrayConfig(input))).address);
  else if (action === "runtime" || action === "validate") {
    const config = buildXrayRuntime(input, resolved);
    if (action === "validate") config.inbounds = config.inbounds.filter((inbound) => inbound.protocol !== "tun");
    console.log(JSON.stringify(config, null, 2));
  }
  else throw new Error("Invalid Xray config command");
}
