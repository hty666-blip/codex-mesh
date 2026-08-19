# Tailscale private-network setup

This guide connects a Windows 10 controller, a Windows 11 worker, an Ubuntu worker, and any future workers without exposing Codex Mesh to the public internet.

## Cost and network model

Codex Mesh is free and open source. At the time of writing, Tailscale has a free Personal plan that is normally sufficient for an individually owned small fleet; verify the latest terms on the [Tailscale pricing page](https://tailscale.com/pricing). Codex subscriptions or API usage are separate.

Tailscale gives the devices a private encrypted network called a tailnet. The computers may be behind different routers, NAT, mobile connections, or office/home networks. You do not need:

- a public IPv4 address;
- a domain name or DDNS;
- router port forwarding;
- a VPS or public relay that you operate;
- Tailscale Funnel.

Codex Mesh still requires its own controller and per-node bearer credentials. Being on a tailnet is not a substitute for application authentication.

## 1. Install and join one tailnet

Use the official Tailscale installers:

- [Tailscale for Windows](https://tailscale.com/download/windows) on Windows 10 and Windows 11.
- [Tailscale for Linux](https://tailscale.com/download/linux) on Ubuntu.

Sign all three devices into the same account/tailnet. Give them recognizable device names, for example:

| Role | Suggested device name |
|---|---|
| Windows 10 controller + Hub | `controller-win10` |
| Windows 11 worker | `worker-win11` |
| Ubuntu worker | `ubantant` |

Do not enable Funnel for the Hub. Funnel intentionally publishes a service to the internet, which is outside the Codex Mesh security model.

## 2. Record the controller's private address

On Windows 10 PowerShell:

```powershell
tailscale status
$TailIp = (& tailscale ip -4 | Select-Object -First 1).Trim()
$TailIp
```

The output should be a Tailscale IPv4 address, commonly in the `100.64.0.0/10` range. Use the exact value returned on your machine; examples in this repository use `100.x.y.z` as a placeholder.

Codex Mesh uses this Hub URL:

```powershell
$HubUrl = "http://${TailIp}:7337"
```

Tailscale IPs are normally stable while the device remains registered, but do not hard-code an example address. If the controller is removed and re-added to the tailnet, check its address again and deliberately update the Mesh controller/worker configurations.

## 3. Check private reachability

From Windows 11:

```powershell
tailscale status
tailscale ping controller-win10
```

From Ubuntu:

```sh
tailscale status
tailscale ping controller-win10
```

Both should reach the Windows 10 device. `tailscale ping` may report a direct or relayed path; neither requires opening a router port.

MagicDNS device names are convenient for diagnostics, but the first Codex Mesh setup deliberately uses the controller's numeric Tailscale IP so the Hub binds to one explicit private interface.

## 4. Start the Hub on only that address

From the cloned repository on Windows 10:

```powershell
Set-Location .\codex-mesh\plugins\codex-mesh
$DataDir = Join-Path $env:LOCALAPPDATA "CodexMesh\data"
$HubUrl = "http://${TailIp}:7337"

node .\src\hub\main.mjs init --data-dir $DataDir --hub-url $HubUrl
node .\src\hub\main.mjs serve --data-dir $DataDir --host $TailIp --port 7337
```

The `init` command is first-run only. The `serve` command must use the explicit Tailscale IP. Codex Mesh rejects public, unspecified, and wildcard listen addresses, but the operator should still verify the command rather than depending on that guardrail.

Never use any of these for remote Mesh access:

```text
--host 0.0.0.0
--host ::
a public WAN address
Tailscale Funnel
a router port-forward to TCP 7337
```

`localhost` is valid only for same-machine testing; remote workers cannot reach it.

## 5. Test the health endpoint

Keep the Hub process running. From Windows 11:

```powershell
curl.exe http://100.x.y.z:7337/v1/health
```

From Ubuntu:

```sh
curl http://100.x.y.z:7337/v1/health
```

Replace `100.x.y.z` with the Windows 10 Tailscale IP. A JSON health response confirms routing and the Hub listener before pairing any worker.

If this fails while `tailscale ping` succeeds, check:

1. The Hub terminal is still open.
2. `--host` exactly matches `tailscale ip -4`.
3. Both the URL and Hub use port `7337`.
4. Windows Firewall is not blocking the Node process.

If Windows asks for firewall access, allow the Node executable only for the private/Tailscale path. A manually created rule should be narrowly scoped to TCP `7337`, the exact program, and worker Tailscale addresses or the tailnet address range. Do not open the same port on the router or public profile.

## 6. Pair each worker separately

Network membership does not enroll a worker. On the controller, create one short-lived single-use pairing code per computer:

```powershell
node .\src\cli\main.mjs pair --name worker-win11
node .\src\cli\main.mjs pair --name ubantant
```

Use the first code exactly once on Windows 11 and the second exactly once on Ubuntu. Never copy an enrolled `agent.json` between machines. Each node must retain its own token so it can be revoked independently.

Enrollment examples are in [README.zh-CN.md](../README.zh-CN.md) and [README.md](../README.md).

## 7. Optional tailnet access restrictions

For a small tailnet containing only devices you own, the default Tailscale policy may be adequate for an MVP. If the tailnet contains other people or unrelated devices, use Tailscale's access-control policy to restrict TCP `7337` on `controller-win10` to only the intended worker identities/tags.

Policy syntax evolves, so use the current [Tailscale access-control documentation](https://tailscale.com/kb/1018/acls) rather than copying an old rule blindly. Test the policy from both workers after every change.

Tailscale access policy is defense in depth. Do not remove Mesh bearer authentication, and do not share the controller token with workers.

## 8. Host and account separation

The controller token can fully control Mesh tasks and shared memory. The OS identity running a worker Agent must not be able to read `controller.json` or the Hub data directory.

If one physical computer runs both Hub and Agent, use separate OS accounts with filesystem permissions that keep the controller config and Hub data away from the Agent account. A dedicated VM/container for the worker is preferable when the host contains unrelated secrets.

Remember that a registered workspace is a working-directory and maximum-write boundary, not a read-confidentiality boundary. Restrict what the Agent account can read at the operating-system or VM boundary.

## 9. Lost-device response

Use both control planes; they solve different problems:

1. On the Mesh controller, cancel current tasks if the worker is online.
2. Revoke the node with `meshctl node revoke NODE_ID`.
3. In the Tailscale admin console, remove the lost or retired device.
4. If the controller credential may be exposed, stop the Hub and run `rotate-controller-token` before restarting it.

Revocation blocks future authenticated Agent calls. It cannot guarantee termination of a Codex child process that was already running on an unreachable machine; local process/account/VM shutdown is required for that.

## Network checklist

- [ ] Every device is in the intended tailnet.
- [ ] Windows 11 and Ubuntu can `tailscale ping` Windows 10.
- [ ] The Hub binds to the exact Windows 10 Tailscale IPv4 and port `7337`.
- [ ] No public IP, wildcard bind, router forwarding, or Funnel is used.
- [ ] The health endpoint responds from both workers.
- [ ] Windows Firewall access is restricted to the private/Tailscale path.
- [ ] Every worker receives a different pairing code and node token.
- [ ] Worker accounts cannot read Hub data or `controller.json`.
- [ ] Lost devices are revoked in both Mesh and Tailscale.
