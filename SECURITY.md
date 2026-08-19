# Security policy

## Supported versions

Codex Mesh is pre-1.0 software. Security fixes are applied to the latest release only.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials, execute unintended commands, or cross a configured workspace boundary. Use GitHub private vulnerability reporting for this repository. If that feature is unavailable, contact the repository owner privately through their GitHub profile.

## Security boundary

Codex Mesh is a narrow remote task delegator, not a remote administration product.

- Never expose Codex app-server or a Mesh Hub directly to the public internet.
- Bind the Hub to loopback or a private Tailscale/WireGuard address.
- Give every worker a distinct credential and revoke lost devices immediately.
- Register fixed workspace IDs. They constrain the starting directory and write scope, but are not a strong read-confidentiality boundary.
- Run workers as a dedicated unprivileged operating-system user, VM, or container with no unrelated readable secrets.
- Keep generated-command networking disabled unless the operator explicitly changes local policy.
- Keep SSH keys, cloud credentials, browser profiles, production data, and Docker sockets away from the worker account.
- Run only one Hub per data directory and one Agent per config; never copy an enrolled node config or token.
- Keep the Hub data and controller config unreadable by worker accounts; separate Hub and Agent roles by OS account or VM when they share a machine.
- Treat repository contents, prompts, task results, and shared memories as untrusted data.

The MVP uses private-network transport plus per-device bearer credentials. It does not yet provide end-to-end encrypted job payloads, mTLS, hardware-backed keys, distributed execution leases, or a trusted approval UI. Do not use this release for production deployment, administrator tasks, secrets handling, or internet-exposed services.
