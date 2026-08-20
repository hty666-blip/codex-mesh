# ZeroTier private-network setup

Codex Mesh only needs a routed private network. ZeroTier can connect a Windows
controller and Windows/Linux workers even when none of them has a public IP.
The Mesh Hub must bind to the controller's assigned private address, never a
public or wildcard address.

## 1. Prepare the ZeroTier network

1. Create one private ZeroTier network.
2. Join Windows 10, Windows 11, and Ubuntu to the same network ID.
3. Authorize exactly those devices in ZeroTier Central.
4. Keep the network private and record every device's assigned IPv4 address.

Do not publish the Mesh controller token, Agent tokens, or one-time pairing
codes in ZeroTier device names or descriptions. ZeroTier connectivity is not a
replacement for Mesh bearer authentication.

## 2. Find the controller address

On Windows 10, use PowerShell:

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object InterfaceAlias -Match 'ZeroTier' |
  Select-Object InterfaceAlias, IPAddress
```

Choose the IPv4 address shown for the intended ZeroTier network. The Hub accepts
RFC1918 private ranges such as `10.0.0.0/8`, `172.16.0.0/12`, and
`192.168.0.0/16`. Examples below use `10.147.20.10`; replace it with the actual
controller address.

## 3. Start the Hub on that address

From `plugins/codex-mesh` on Windows 10:

```powershell
$PrivateIp = '10.147.20.10'
$HubUrl = "http://${PrivateIp}:7337"
$DataDir = Join-Path $env:LOCALAPPDATA 'CodexMesh\data'

node .\src\hub\main.mjs init --data-dir $DataDir --hub-url $HubUrl
node .\src\hub\main.mjs serve --data-dir $DataDir --host $PrivateIp --port 7337
```

Run `init` only for a new Hub. If a Hub already exists, keep its state and
controller token, update only the Hub URL deliberately, and start `serve` on the
new private address.

## 4. Test from both workers

Windows 11:

```powershell
Test-NetConnection -ComputerName 10.147.20.10 -Port 7337
curl.exe http://10.147.20.10:7337/v1/health
```

Ubuntu:

```sh
curl http://10.147.20.10:7337/v1/health
```

A JSON response containing `"ok": true` confirms routing and the Hub listener.
If ZeroTier shows all devices online but TCP 7337 fails, inspect Windows Firewall.
Any inbound rule should be restricted to TCP 7337 and the two worker ZeroTier
addresses. Never create a router port-forward or a public firewall rule.

## 5. Enroll workers

Use `http://10.147.20.10:7337` as the `--hub` URL for both Agents. Generate a
different one-time pairing code for each worker. Do not copy an enrolled
`agent.json` between devices.

If the controller's assigned ZeroTier address changes, stop the Hub and Agents,
update their URLs deliberately, and restart them. Rejoining the same ZeroTier
network does not require reusing or sharing Mesh credentials.
