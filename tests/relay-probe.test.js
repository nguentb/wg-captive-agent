"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { probe } = require("../web/relay-probe");

test("TCP health probe binds a source, handles refusals and rejects hostnames", async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    assert.equal(await probe("127.0.0.1", "127.0.0.1", port, 500), true);
    assert.equal(await probe("example.com", "127.0.0.1", port), false);
    assert.equal(await probe("127.0.0.1", "invalid", port), false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
  assert.equal(await probe("127.0.0.1", "127.0.0.1", port, 500), false);
});
