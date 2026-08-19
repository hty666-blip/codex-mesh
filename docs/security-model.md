# Security model

## Intended use

Codex Mesh is intended for one operator delegating development tasks to computers they own and administer. The initial release is for personal labs and development environments, not production operations or multi-tenant hosting.

## Trust assumptions

- The private Tailscale/WireGuard network is administered by the operator.
- The Hub host and its data directory are trusted.
- Every Agent host may contain untrusted repositories and tool output.
- Prompts, repository text, shared memories, and Codex output are untrusted data rather than policy.
- Local Agent configuration is more authoritative than controller requests.

## Enforced controls

- Distinct controller and per-node bearer credentials.
- Only SHA-256 token digests are kept in Hub state.
- Short-lived, single-use pairing codes.
- Opaque workspace IDs mapped to locally configured canonical paths.
- `codex exec` is spawned with an argument array and `shell: false`.
- Prompts are sent over child stdin rather than exposed in process arguments.
- Only `read-only` and `workspace-write` sandbox modes are accepted.
- Remote task input cannot request `danger-full-access`.
- Codex runs with user configuration ignored, networking and web search disabled, and approval policy fixed to `never`.
- Hosted apps/connectors, hooks, remote plugins, multi-agent delegation, goals, memories, and automatic skill dependency installation are explicitly disabled for remote runs.
- Codex receives a minimal environment allowlist; all other variables require explicit local `passEnv` configuration, and `CODEX_MESH_*` variables are always blocked.
- Task TTLs, idempotency keys, event bounds, request body limits, and basic concurrency limits.
- No MCP method for arbitrary shell, arbitrary path, privilege escalation, plugin installation, deployment, or credential retrieval.

## Known MVP limitations

- Hub traffic is protected by the private network and bearer credentials, not application-layer TLS by default.
- Task payloads and results are visible to a trusted Hub administrator.
- Credentials are stored in local JSON configuration; operating-system secret stores are not yet integrated.
- There is no independent trusted approval UI. Consequential operations are therefore outside the MVP scope.
- Process cancellation is best effort, especially for grandchildren on Windows.
- A registered workspace fixes the starting directory and write ceiling; it is not a reliable read-confidentiality boundary. Codex may read other files available to the Agent's operating-system account, and task output is stored by the Hub.
- The local Agent lock prevents the common duplicate-process case, but copied node credentials/configs are not protected by a distributed execution lease.
- Shared-memory search is lexical and memories are not automatically reviewed for factual accuracy.
- Memory `sensitivity` is only a label, not encryption or access control. Expired memories are hidden from search but remain in Hub storage.
- The MVP has no automatic retention or deletion API for tasks, events, results, or memories; the operator must manage and back up the Hub data file appropriately.

## Operational rules

1. Never bind the Hub to a public interface.
2. Never use Tailscale Funnel for the Hub.
3. Run every Agent as a dedicated, unprivileged user, VM, or container containing no unrelated sensitive files.
4. Register the smallest possible workspace roots.
5. Keep production secrets, SSH keys/agents, cloud credentials, browser profiles, and Docker sockets out of everything that Agent account can read—not only its environment variables.
6. Review task output and diffs before committing or pushing.
7. Revoke a node token and remove its tailnet device when a machine is lost or repurposed.
8. Run one Hub per data directory and one Agent per config. Never clone an enrolled Agent config to another device.
9. Do not run an Agent under an account that can read the Hub data directory or controller config. If one physical computer serves both roles, use separate OS accounts or a VM/container boundary.

## Hardening roadmap

Future compatible layers include controller-signed task envelopes, mTLS, end-to-end encryption through an untrusted relay, OS-backed credential storage, isolated per-task worktrees or containers, a trusted one-shot approval UI, signed update artifacts, and tamper-evident audit checkpoints.
