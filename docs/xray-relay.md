# Xray relay

Xray is an optional exit transport. Routers still connect to wg0 on the relay.
The Xray tab imports one VLESS/Trojan exit profile; it does not manage users on
the exit. An existing Xray server or 3X-UI can provide the client link.

## Install on the relay (Ubuntu 24.04)

Update/install the agent normally first. Then:

```bash
sudo apt-get update
sudo apt-get install -y curl unzip ca-certificates
sudo wg-captive-xray-install
```

The installer downloads the latest stable official Xray-core release, checks the
release SHA-256 digest and tests native TUN configuration support before installing.
To install a specific tested release, use `sudo XRAY_VERSION=v26.3.27 wg-captive-xray-install`.
Only x86_64 and arm64 Linux are supported. A core without native TUN is rejected.
The dedicated binary is `/usr/local/lib/wg-captive-agent/xray/xray`; other Xray
installations and their services are not changed. Agent updates do not implicitly
download or upgrade the optional core. Run the installer again to upgrade it, then
stop/start Xray from the tab.

## Import and switch

1. On the exit, create a VLESS or Trojan inbound and open its TCP port in both the
   VPS firewall and provider firewall. Export its client link or outbound JSON.
2. In **Xray**, paste the `vless://`/`trojan://` link OR select a JSON/text file,
   then press **Import**. Stop Xray and its route before replacing its profile.
3. Turn off the existing WireGuard/OpenVPN route and tunnel in **Relay**.
4. Press **Use Xray**, turn on **Xray service**, then **Check connection**.
5. Check that the displayed exit IP is the expected exit server, then enable **Route**.
6. To switch back: turn off Xray Route and service, then select/start the other
   tunnel in Relay. There is no automatic transport failover.

Link import supports RAW/TCP, WebSocket, gRPC, HTTPUpgrade and XHTTP, with the
security/flow supplied by the link. TLS verification cannot be disabled. Unknown
link parameters produce an error rather than being ignored. Use Xray outbound JSON
for advanced transport options. A full JSON config must contain exactly one VLESS
or Trojan outbound; only that outbound is imported, not its DNS, inbounds or routing.
External files, socket/routing overrides and proxy chaining are rejected. Core
validation runs on import when installed, and always before starting the service.
Importing a config does not establish a network connection.

## Routing and existing policies

- The host binary runs inside wg-easy's network namespace using `nsenter -n`.
  TUN `xray-exit` has no automatic default route or system DNS takeover. Only
  marked client traffic is routed to it by the agent's existing policy table.
- Expired/disabled clients retain captive processing. Malware destination IPs
  are dropped before they can enter the TUN. DNS UDP/TCP 53 and TCP 853 retain
  their normal relay-side path; DoH is ordinary HTTPS and follows the exit.
- The host resolves the exit hostname before entering the container namespace,
  retaining TLS SNI. The VPS default route and system resolver are unchanged.
- Current captive/block policies are IPv4-only. While Xray routing is enabled,
  forwarded IPv6 from wg0 is rejected to prevent bypass, not sent directly.
- A blackhole fallback in the policy table prevents normal client Internet
  traffic from falling through to the relay's uplink if the TUN disappears.
  Explicitly turning Route off restores the original direct-routing behavior.
  This guard belongs to the wg-easy network namespace: recreating that namespace
  removes its firewall/routes until the agent/supervisor reapplies them. It is
  not a host-wide persistent kill switch across Docker namespace recreation.
- User UDP support depends on the selected outbound and exit. Test actual UDP
  applications even when the inter-server transport is TCP. This is a proxy-based
  TUN, not a full layer-3 VPN: ping can be answered locally, so it is not an exit
  connectivity test. The built-in HTTPS check uses the same outbound through a
  loopback-only SOCKS endpoint, not a full wg0/firewall end-to-end test.

## Service, logs and backup

```bash
sudo systemctl status wg-captive-xray --no-pager
sudo journalctl -u wg-captive-xray -n 80 --no-pager
sudo wg-captive-agent relay-status
```

The web starts/stops/checks Xray in background jobs, with bounded command timeouts.
It distinguishes process/TUN readiness from an actual exit check. Polling only
continues while a job runs. The supervisor restarts when wg-easy's namespace changes
and reapplies an enabled route without recursively starting itself.

The imported outbound and selected transport are stored in `relay_config` in
SQLite and included in existing backups. Restore recreates all three tunnel
profiles. Install the optional core before restoring a backup that has Xray
routing enabled. Config files and runtime files are mode 0600; credentials are not
rendered in the Xray tab and are redacted from its logs. Authenticated admin APIs
and backups still contain credentials; protect access to both.

The native TUN design follows the [official Xray TUN documentation](https://github.com/XTLS/Xray-core/blob/main/proxy/tun/README.md).
