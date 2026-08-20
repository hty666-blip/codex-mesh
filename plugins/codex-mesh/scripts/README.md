# Installation helpers

These scripts copy the dependency-free Node.js agent and CLI into a user-owned
directory. They deliberately do not install a service, elevate privileges,
change firewall settings, install Node.js, or start a process.

- Windows controller using Codex Desktop only: run
  `./scripts/install-controller-desktop.ps1`. It registers the Mesh MCP server
  in `~/.codex/config.toml`, copies the dependency-free MCP runtime to
  `%LOCALAPPDATA%\CodexMesh\controller`, copies the Mesh skill to
  `~/.codex/skills/codex-mesh`, backs up an existing config before changing it,
  and is safe to rerun. It does not install or invoke the Codex CLI. Close all
  Codex Desktop windows before installation and restart the app afterward.

- Windows: run `./scripts/install-agent.ps1`, enroll in a foreground terminal,
  then customize `windows/codex-mesh-agent-task.xml.template` if a least-
  privilege Scheduled Task is wanted.
- Ubuntu: run `sh ./scripts/install-agent.sh`, enroll in a foreground terminal,
  then customize `linux/codex-mesh-agent.service.template`. For a user unit,
  copy it to `~/.config/systemd/user/codex-mesh-agent.service`, run
  `systemctl --user daemon-reload`, and explicitly enable it only after the
  foreground test succeeds. Replace `@@CONFIG_DIR@@` with the directory that
  contains the Agent config (the PID lock is created beside it), and add only
  the workspace-write paths that the service must modify.

Agent and controller JSON files contain bearer tokens. Keep them outside the
Git checkout, restrict them to the account running Codex Mesh, and never commit
them. Enrollment creates the agent config with mode `0600` on Ubuntu.

The child Codex process receives a minimal allowlist of operating-system,
locale, certificate, and Codex-home variables. Every other variable is removed
by default. If Codex truly needs one, enroll with a repeatable `--pass-env NAME`
option or add the exact name to the local config's `passEnv` array.
`CODEX_MESH_*` variables can never be passed through.

On Windows, the native Codex sandbox can be selected without re-enrolling the
node. Prefer `elevated`; use the weaker `unelevated` fallback only when the
elevated sandbox is unavailable:

```powershell
& $Agent configure --windows-sandbox unelevated
```

When Codex itself needs a local HTTP(S) proxy, configure it only for the Codex
child process. The Agent's Hub traffic remains direct, so private-network Hub
addresses do not enter the proxy:

```powershell
& $Agent configure `
  --windows-sandbox unelevated `
  --codex-proxy http://127.0.0.1:7897
```

Use `--clear-codex-proxy` or `--clear-windows-sandbox` to remove an override.
Proxy URLs are stored in the protected local Agent config and are never sent to
the Hub. Avoid embedding proxy credentials in the URL when possible.

Only run one agent process for a given config; the runner enforces this with a
PID lock beside the config file. A Codex workspace is a working-directory and
write boundary, not a strong read-confidentiality boundary. Run workers under a
dedicated low-privilege OS account or inside a VM when the machine contains
unrelated sensitive files.
