"use strict";

const net = require("node:net");

function parseState(text) {
  const states = text.split(/\r?\n/).map((line) => line.replace(/^>STATE:/, "")).filter((line) => /^\d+,[A-Z_]+,/.test(line));
  const fields = states.at(-1)?.split(",") || [];
  return { state: fields[1] || "UNAVAILABLE", detail: fields[2] || "", connected: fields[1] === "CONNECTED" && fields[2] === "SUCCESS" };
}

function getState(socketPath, connect = net.createConnection) {
  return new Promise((resolve) => {
    let buffer = "";
    let finished = false;
    let closeTimer;
    const socket = connect(socketPath);
    const timer = setTimeout(() => finish(), 700);
    function cleanup() {
      clearTimeout(closeTimer);
      socket.destroy();
    }
    function finish(graceful = false) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (graceful) {
        // Let OpenVPN close its management session before closing our socket.
        closeTimer = setTimeout(cleanup, 300);
        socket.write("quit\n");
      } else cleanup();
      resolve(parseState(buffer));
    }
    socket.on("connect", () => socket.write("state\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (finished) return;
      if (/(?:^|\n)END\r?(?:\n|$)/.test(buffer)) finish(true);
      else if (buffer.length > 16000) finish();
    });
    socket.on("error", () => { finish(); cleanup(); });
    socket.on("end", () => { finish(); cleanup(); });
    socket.on("close", () => { finish(); clearTimeout(closeTimer); });
  });
}

module.exports = { parseState, getState };
if (require.main === module) {
  getState(process.argv[3] || "/run/wg-captive-openvpn/management.sock").then((result) => {
    if (process.argv[2] === "ready") process.exitCode = result.connected ? 0 : 1;
    else console.log(`openvpn_connection: ${result.state}\nopenvpn_detail: ${result.detail}`);
  }).catch(() => { process.exitCode = 1; });
}
