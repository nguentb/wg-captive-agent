"use strict";

function relayProtocol(value = "wireguard") {
  if (!["wireguard", "openvpn", "amneziawg"].includes(value)) throw new Error("Invalid relay protocol");
  return value;
}

function normalizeOpenVpnConfig(content) {
  const text = content.toString("utf8");
  if (text.includes("\0") || text.length > 1024 * 1024) throw new Error("Invalid OpenVPN config");
  const inline = new Set(["ca", "cert", "key", "tls-auth", "tls-crypt", "tls-crypt-v2"]);
  const allowed = new Set([
    "client", "tls-client", "pull", "nobind", "persist-key", "persist-tun", "auth-nocache", "user", "group",
    "remote-cert-tls", "verify-x509-name", "cipher", "data-ciphers", "data-ciphers-fallback",
    "auth", "key-direction", "tls-version-min", "tls-version-max", "tls-cipher", "tls-ciphersuites",
    "resolv-retry", "connect-retry", "connect-retry-max", "connect-timeout", "server-poll-timeout",
    "ping", "ping-restart", "keepalive", "reneg-sec", "hand-window", "tran-window",
    "tun-mtu", "mssfix", "sndbuf", "rcvbuf", "verb", "mute", "explicit-exit-notify",
    "route-nopull", "route-noexec", "disable-dco", "allow-compression",
  ]);
  const result = [];
  const blocks = new Set();
  let block = "";
  let remote = null;
  let protocol = "";
  let client = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (block) {
      result.push(raw);
      if (line === `</${block}>`) block = "";
      continue;
    }
    if (!line || /^[#;]/.test(line)) continue;
    const tag = line.match(/^<([a-z0-9-]+)>$/);
    if (tag) {
      if (!inline.has(tag[1]) || blocks.has(tag[1])) throw new Error("Unsupported OpenVPN inline block");
      block = tag[1];
      blocks.add(block);
      result.push(line);
      continue;
    }
    const tokens = line.split(/\s+/);
    const key = tokens[0].replace(/^--/, "");
    if (key === "proto") {
      if (protocol || !/^tcp(?:[46])?-client$/.test(tokens[1]) || tokens.length !== 2) throw new Error("OpenVPN must use proto tcp-client (or tcp4-client/tcp6-client)");
      protocol = tokens[1];
      continue;
    }
    if (key === "remote") {
      if (remote || tokens.length < 3 || tokens.length > 4 || !/^[A-Za-z0-9.:-]+$/.test(tokens[1]) || !/^\d+$/.test(tokens[2]) || Number(tokens[2]) < 1 || Number(tokens[2]) > 65535) throw new Error("Use one OpenVPN remote host and port");
      remote = tokens.slice(1);
      continue;
    }
    if (key === "dev") {
      if (!/^tun(?:[\w-]*)$/.test(tokens[1])) throw new Error("OpenVPN relay requires a TUN device");
      continue;
    }
    if (key === "dev-type") {
      if (tokens[1] !== "tun") throw new Error("OpenVPN relay requires dev-type tun");
      continue;
    }
    // Routing and DNS belong to the captive agent, including options in exported profiles.
    if (["redirect-gateway", "redirect-private", "route", "route-ipv6", "dhcp-option", "register-dns", "block-outside-dns"].includes(key)) continue;
    if (!allowed.has(key)) throw new Error(`Unsupported OpenVPN option: ${key}. Use a self-contained certificate profile without scripts or external files.`);
    if (["user", "group"].includes(key) && (tokens.length !== 2 || !/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(tokens[1]))) throw new Error(`Invalid OpenVPN ${key}: expected one local account name`);
    if (key === "allow-compression" && tokens[1] !== "no") throw new Error("OpenVPN compression must be disabled");
    if (key === "remote-cert-tls" && tokens[1] !== "server") throw new Error("OpenVPN must verify the server certificate");
    if (["remote-cert-tls", "route-nopull", "route-noexec"].includes(key)) continue;
    if (key === "client") client = true;
    result.push([key, ...tokens.slice(1)].join(" "));
  }
  if (block || !client || !remote || !["ca", "cert", "key"].every((tag) => blocks.has(tag))) throw new Error("OpenVPN config needs client, remote and inline <ca>, <cert>, <key>");
  const transport = remote[2] || protocol;
  if (!/^tcp(?:[46])?-client$/.test(transport) || (protocol && transport !== protocol)) throw new Error("OpenVPN relay only accepts TCP client profiles");
  return `proto ${transport}\nremote ${remote[0]} ${remote[1]} ${transport}\ndev tun-exit\n${result.join("\n")}\nremote-cert-tls server\nroute-nopull\nroute-noexec\n`;
}

function normalizeAmneziaConfig(content) {
  const { isIP } = require("node:net");
  const text = content.toString("utf8");
  if (text.includes("\0") || text.length > 1024 * 1024) throw new Error("Invalid AmneziaWG config");
  const sections = { Interface: new Map(), Peer: new Map() };
  const ranges16 = ["ContentPaddingAddition", "RekeyAfterTime", "RekeyTimeout", "RejectAfterTime", "KeepaliveTimeout", "MaxHandshakeAttempts", "PersistentKeepalive"];
  const names = ["PrivateKey", "Address", "MTU", "ListenPort", "Jc", "Jmin", "Jmax", "S1", "S2", "S3", "S4", "H1", "H2", "H3", "H4", "I1", "I2", "I3", "I4", "I5", "HeaderProtectionKey", ...ranges16.filter((k) => k !== "PersistentKeepalive"), "RandomTrailers", "DisableCookies"];
  const peerNames = ["PublicKey", "PresharedKey", "AllowedIPs", "Endpoint", "PersistentKeepalive", "AdvancedSecurity"];
  let section = "";
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      const match = line.match(/^\[(Interface|Peer)\]$/i);
      section = match ? (/interface/i.test(match[1]) ? "Interface" : "Peer") : "";
      if (!section || seen.has(section) || (section === "Peer" && !seen.has("Interface"))) throw new Error("Use one AmneziaWG Interface and one exit Peer");
      seen.add(section);
      continue;
    }
    const match = line.match(/^([A-Za-z0-9]+)\s*=\s*(.*)$/);
    if (!section || !match) throw new Error("Invalid AmneziaWG config line");
    const [, key, value] = match;
    if (section === "Interface" && /^(DNS|Table|SaveConfig|PreUp|PostUp|PreDown|PostDown)$/i.test(key)) continue;
    const canonical = (section === "Interface" ? names : peerNames).find((name) => name.toLowerCase() === key.toLowerCase());
    if (!canonical) throw new Error(`Unsupported AmneziaWG option: ${key}`);
    if ((!value && !/^I[1-5]$/.test(canonical)) || sections[section].has(canonical)) throw new Error(`Invalid or duplicate AmneziaWG option: ${canonical}`);
    sections[section].set(canonical, value);
  }
  const iface = sections.Interface, peer = sections.Peer;
  for (const [values, keys] of [[iface, ["PrivateKey", "Address"]], [peer, ["PublicKey", "AllowedIPs", "Endpoint"]]]) {
    for (const key of keys) if (!values.has(key)) throw new Error(`AmneziaWG config needs ${key}`);
  }
  for (const values of [iface, peer]) for (const [key, value] of values) {
    if (/Key$/.test(key) && (!/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, "base64").length !== 32)) throw new Error(`Invalid AmneziaWG ${key}`);
    if (["Address", "AllowedIPs"].includes(key)) for (const item of value.split(/\s*,\s*/)) {
      const [ip, bits, extra] = item.split("/");
      const family = isIP(ip);
      if (!family || extra !== undefined || !/^\d+$/.test(bits || "") || Number(bits) > (family === 4 ? 32 : 128)) throw new Error(`Invalid AmneziaWG ${key}`);
    }
    if (/^(Jc|Jmin|Jmax|S[1-4]|MTU|ListenPort)$/.test(key) && (!/^\d+$/.test(value) || Number(value) > 65535 || (key === "MTU" && Number(value) < 576))) throw new Error(`Invalid AmneziaWG ${key}`);
    if (["RandomTrailers", "DisableCookies", "AdvancedSecurity"].includes(key) && !/^(on|off|0|1)$/i.test(value)) throw new Error(`Invalid AmneziaWG ${key}`);
    if (/^H[1-4]$/.test(key) || ranges16.includes(key)) {
      const range = value.split("-");
      const maximum = ranges16.includes(key) ? 65535 : 4294967295;
      if (range.length > 2 || range.some((n) => !/^\d+$/.test(n) || Number(n) > maximum) || (range.length === 2 && Number(range[0]) > Number(range[1]))) throw new Error(`Invalid AmneziaWG ${key}`);
    }
  }
  if (!iface.get("Address").split(/\s*,\s*/).some((v) => isIP(v.split("/")[0]) === 4)) throw new Error("AmneziaWG relay requires an IPv4 address");
  if (!peer.get("AllowedIPs").split(/\s*,\s*/).includes("0.0.0.0/0")) throw new Error("AmneziaWG exit AllowedIPs must include 0.0.0.0/0");
  const endpoint = peer.get("Endpoint").match(/^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d+)$/);
  if (!endpoint || Number(endpoint[2]) < 1 || Number(endpoint[2]) > 65535 || (endpoint[1].startsWith("[") && isIP(endpoint[1].slice(1, -1)) !== 6)) throw new Error("Invalid AmneziaWG Endpoint");
  if (!peer.has("PersistentKeepalive")) peer.set("PersistentKeepalive", "25");
  return `[Interface]\n${[...iface].map(([k, v]) => `${k} = ${v}`).join("\n")}\nTable = off\n\n[Peer]\n${[...peer].map(([k, v]) => `${k} = ${v}`).join("\n")}\n`;
}

module.exports = { relayProtocol, normalizeOpenVpnConfig, normalizeAmneziaConfig };
