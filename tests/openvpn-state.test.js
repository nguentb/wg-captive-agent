"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { parseState, getState } = require("../web/openvpn-state");

test("only CONNECTED SUCCESS is ready; a retained TUN cannot fake a TLS connection", () => {
  assert.equal(parseState("171,CONNECTED,SUCCESS,10.250.240.2,203.0.113.10,8443\nEND\n").connected, true);
  for (const state of ["TCP_CONNECT", "WAIT", "AUTH", "GET_CONFIG", "RECONNECTING", "EXITING"]) assert.equal(parseState(`171,${state},init,10.250.240.2\nEND\n`).connected, false);
  assert.equal(parseState("171,CONNECTED,SUCCESS\n172,RECONNECTING,ping-restart\nEND\n").state, "RECONNECTING");
  assert.equal(parseState("unavailable").connected, false);
});

test("management reader handles chunked replies, socket errors and bounded timeout", async () => {
  let writes = "";
  const socket = new EventEmitter();
  socket.write = (data) => { writes += data; if (data === "quit\n") { socket.emit("end"); return; } socket.emit("data", ">INFO:OpenVPN Management Interface\n171,CONNE"); socket.emit("data", "CTED,SUCCESS\nEND\n"); };
  socket.destroy = () => { assert.equal(writes, "state\nquit\n"); };
  const pending = getState("test.sock", () => socket);
  socket.emit("connect");
  assert.equal((await pending).connected, true);
  assert.equal(writes, "state\nquit\n");
  const errorSocket = new EventEmitter(); errorSocket.destroy = () => {};
  const failed = getState("missing.sock", () => errorSocket);
  errorSocket.emit("error", new Error("ENOENT"));
  assert.equal((await failed).state, "UNAVAILABLE");
  const silent = new EventEmitter(); silent.destroy = () => {};
  assert.equal((await getState("silent.sock", () => silent)).state, "UNAVAILABLE");
});
