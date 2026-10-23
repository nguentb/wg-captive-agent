"use strict";

const fs = require("node:fs");
const { isIP } = require("node:net");
const { execFileSync } = require("node:child_process");
const { normalizeAmneziaConfig } = require("./relay-config");

function runtimeConfig(content, resolve) {
  const normalized = normalizeAmneziaConfig(content);
  return normalized.replace(/^Endpoint = (.+):(\d+)$/m, (_, host, port) => {
    host = host.replace(/^\[|\]$/g, "");
    const address = isIP(host) ? host : resolve(host);
    if (!isIP(address)) throw new Error("Cannot resolve AmneziaWG endpoint");
    return `Endpoint = ${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
  });
}

if (require.main === module) {
  try {
    const result = runtimeConfig(fs.readFileSync(process.argv[2]), (host) => {
      const output = execFileSync("getent", ["ahosts", host], { encoding: "utf8", timeout: 8000 });
      return output.trim().split(/\s+/)[0];
    });
    fs.writeFileSync(process.argv[3], result, { mode: 0o600 });
  } catch (error) {
    console.error(`AmneziaWG config: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { runtimeConfig };
