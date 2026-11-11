"use strict";

function relayProtocol(value = "wireguard") {
  if (!["wireguard", "amneziawg", "reality"].includes(value)) throw new Error("Invalid relay protocol");
  return value;
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

module.exports = { relayProtocol, normalizeAmneziaConfig };
