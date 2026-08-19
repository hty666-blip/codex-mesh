# Architecture

Codex Mesh is a hub-and-worker system for delegating scoped Codex tasks across computers connected by a private network.

```text
Codex / MCP client
        |
        v
  Controller API
        |
        v
     Mesh Hub  <------ Worker Agent A ------> local Codex CLI
        ^       <------ Worker Agent B ------> local Codex CLI
        |       <------ Worker Agent N ------> local Codex CLI
  task and memory store
```

## Components

### Plugin and MCP server

The plugin supplies workflow guidance and a local stdio MCP server. The MCP server exposes focused operations for listing nodes, pairing workers, creating scoped tasks, following or cancelling tasks, and reading or adding shared memory. It never exposes an arbitrary remote shell method.

### Hub

The Hub is the persistent control plane. It authenticates controllers and workers, tracks dynamic node membership, selects workers, assigns tasks, stores bounded task events, handles cancellation, and stores explicitly added shared memories. The Hub is intended to bind only to loopback or a private Tailscale/WireGuard address.

### Agent

Each Agent runs beside a locally installed and authenticated Codex CLI. It maps opaque workspace IDs to local canonical paths, polls the Hub for work, starts `codex exec` without a shell, streams bounded events, and reports a final state. A controller cannot choose an arbitrary working directory or raise a task above the workspace's locally configured write ceiling.

The workspace map is not a confidentiality sandbox. Codex sandbox modes principally constrain writes and network access; depending on the operating system, the worker may still read other files available to its OS account. Run the Agent under a dedicated low-privilege account, VM, or container that contains no unrelated secrets.

### CLI

`meshctl` provides a human-operated alternative to the MCP server for pairing, node inspection, task submission, cancellation, and memory administration.

## Multi-node routing

A task targets either explicit node IDs or a selector. Selectors can filter by operating system, tags, online status, and limit. Execution strategies are:

- `single`: exactly one matching worker.
- `parallel`: one child task per selected worker.
- `first_available`: the first eligible worker that accepts the task.

Independent read-only work can fan out. Workspace-write tasks should normally target one node per project. If multiple nodes must edit the same repository, use isolated Git branches or worktrees and merge their results separately.

## State

The Hub persists nodes, token hashes, pairings, tasks, bounded events, idempotency keys, and shared memory in an atomically replaced JSON document. This keeps the MVP dependency-free and easy to inspect. A later storage adapter can replace this with SQLite or PostgreSQL without changing the public HTTP or MCP contracts.

Run exactly one Hub process for a data directory. Run exactly one Agent process for each Agent config and never copy a node config or token to another machine. The Agent uses a local PID lock for the common duplicate-process case; distributed claims and leases are future hardening.

Task states include `queued`, `assigned`, `running`, `cancel_requested`, `cancelled`, `succeeded`, `failed`, and `expired`.

## Transport

The MVP uses HTTP inside a private encrypted network such as Tailscale. Bearer credentials remain mandatory even on that private network. Public internet exposure is unsupported. TLS, mTLS, and end-to-end encrypted task envelopes are planned hardening layers, not claims made by the MVP.
