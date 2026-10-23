"use strict";
const net = require("node:net");

function probe(host, localAddress, port = 443, timeout = 2000) {
  return new Promise((resolve) => {
    if (net.isIP(host) !== 4 || net.isIP(localAddress) !== 4) return resolve(false);
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout, () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect({ host, port, localAddress, family: 4 }, () => finish(true));
  });
}

if (require.main === module) probe(process.argv[2], process.argv[3]).then((ok) => { process.exitCode = ok ? 0 : 1; });
module.exports = { probe };
