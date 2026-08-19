# Contributing

Contributions are welcome. Open an issue before a large protocol, persistence-format, or security-boundary change. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Repository layout

- `plugins/codex-mesh/` is the self-contained Codex plugin and Node.js runtime.
- `.agents/plugins/marketplace.json` is repository-level marketplace metadata.
- `docs/`, `README.md`, and `README.zh-CN.md` are public operator documentation.

Keep plugin-relative paths valid after installation; do not move runtime files back to the repository root.

## Development

Requirements:

- Node.js 20 or newer;
- Git;
- a local Codex CLI only for manual end-to-end Agent testing.

From the repository root, install exactly the locked dependency graph and run tests:

```sh
npm --prefix plugins/codex-mesh ci
npm --prefix plugins/codex-mesh test
```

You can also work inside the plugin directory:

```sh
cd plugins/codex-mesh
npm test
node ./src/hub/main.mjs --help
node ./src/agent/main.mjs --help
node ./src/cli/main.mjs --help
```

Before submitting a change, run:

```sh
git diff --check
npm --prefix plugins/codex-mesh test
```

The CI matrix runs the supported Node versions on Windows and Linux. Changes to installer commands, default ports, config paths, or CLI flags must update tests, examples, both READMEs, and relevant files under `docs/`.

## Security invariants

Preserve these properties unless a reviewed design explicitly replaces them:

- The Hub never listens on a public, unspecified, or wildcard address.
- Every task, including read-only work, requires a registered `workspace_id`.
- A controller cannot request `danger-full-access`, an arbitrary working directory, or an arbitrary-shell MCP operation.
- Agent child processes are spawned without a shell, receive prompts over stdin, and receive only an allowlisted environment.
- Controller credentials never enter the Codex child environment.
- Each enrolled node has its own revocable credential; configurations must not be cloned between workers.
- Documentation must not describe a workspace as a read-confidentiality boundary or task delivery as exactly-once.
- Shared-memory `sensitivity` remains a label unless real encryption and authorization are implemented.

Keep the runtime dependency-free unless a dependency materially improves security or protocol correctness. Never add credentials, real hostnames, real private IP addresses, Hub data, generated configs, or user workspace paths to fixtures.

## Pull requests

Keep changes focused and explain their security impact. Include tests for behavior changes and document operational changes. Use placeholders such as `100.x.y.z`, `NODE_ID`, and `project/example` in public examples.

All contributions are licensed under Apache-2.0.
