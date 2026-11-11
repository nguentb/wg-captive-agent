# Xray REALITY relay

## Exit

Use a Linux [Xray-core release](https://github.com/XTLS/Xray-core/releases/tag/v26.11.9)
with native TUN support on the relay. The agent does not download or update
Xray automatically; install the upstream binary as `/usr/local/bin/xray`.
There is no need to install the captive agent on the exit.

On the exit generate a UUID, an X25519 key pair, and a short ID:

```sh
xray uuid
xray x25519
openssl rand -hex 8
```

Configure the exit's Xray service with the following JSON, replacing the
placeholders. Choose a reachable TLS target using the
[REALITY target guidance](https://xtls.github.io/en/config/transports/reality.html).
The target must not point back to the REALITY listener.

```json
{
  "log": { "loglevel": "warning" },
  "inbounds": [{
    "listen": "0.0.0.0",
    "port": 8443,
    "protocol": "vless",
    "settings": {
      "decryption": "none",
      "clients": [{ "id": "UUID", "flow": "xtls-rprx-vision" }]
    },
    "streamSettings": {
      "network": "raw",
      "security": "reality",
      "realitySettings": {
        "target": "TARGET_NAME:443",
        "serverNames": ["TARGET_NAME"],
        "privateKey": "EXIT_PRIVATE_KEY",
        "shortIds": ["SHORT_ID"]
      }
    }
  }],
  "outbounds": [{ "protocol": "freedom" }]
}
```

Protect the server JSON so only its service account and administrators can
read the private key. Run `xray run -test -config /path/to/server.json`
before starting the service. Allow TCP 8443 to the exit. If Caddy owns TCP 443,
leave it there; a second process cannot bind the same address and TCP port.

## Relay

1. Install the agent and the upstream Xray core on the relay. The relay unit
   creates `xray-exit` in wg-easy's network namespace (or on the host in host
   mode), with no automatic system routes or resolver changes.
2. In **Relay > Xray REALITY**, fill in the exit address, port, UUID, target
   SNI, client-side public key (called Password in newer Xray releases),
   and short ID. Alternatively paste a compatible `vless://` link.
3. Stop the current transport and route before selecting Xray. Start
   **Tunnel** alone. **Test TCP egress** uses a new HTTPS request to
   Cloudflare through Xray's loopback SOCKS listener on TCP 51824. It does
   not test the forwarded TUN path, UDP, or long-term reachability.
4. Enable **Route** and test real client traffic: public IPv4, TCP and UDP,
   permitted DNS bypass, disabled clients and blocked destinations.
   Do not assume that ICMP or IPv6 egress is covered by this IPv4 relay policy.
   Standard [Vision flow](https://xtls.github.io/en/config/outbounds/vless.html#flow)
   intercepts UDP 443; test non-QUIC UDP separately.
5. Keep the previous profile available for rollback. To switch back, turn off
   Xray Route and Tunnel first.

The existing mark-based IPv4 routing remains in the agent; Xray uses no
MASQUERADE on the TUN. Once applied, the Xray route table has a prohibit
fallback to prevent marked traffic from escaping to main if the TUN drops.
The service restarts failed processes. The TCP egress test is on demand,
not an automatic endpoint failover or the WG/AWG watchdog.
