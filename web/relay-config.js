"use strict";

function relayProtocol(value = "wireguard") {
  if (value !== "wireguard" && value !== "openvpn") throw new Error("Invalid relay protocol");
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

module.exports = { relayProtocol, normalizeOpenVpnConfig };
