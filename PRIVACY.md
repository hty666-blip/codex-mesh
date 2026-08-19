# Privacy

Codex Mesh is self-hosted. The project does not operate a hosted service and does not collect telemetry.

Prompts, task events, results, node metadata, and shared memories are sent only to the Hub URL configured by the operator. The operator is responsible for securing that Hub, its storage, and the private network used to reach it.

The MVP stores this data as plaintext JSON and has no automatic retention or deletion API. A memory's `sensitivity` value is only a label; expiration hides it from search but does not erase it from disk. Do not store secrets, and securely manage or delete the Hub data directory when retention is no longer needed.

Codex Mesh does not programmatically collect Codex authentication files, browser data, SSH keys, or hidden model reasoning. It also strips most environment variables before launching Codex. However, a remote task can cause Codex to read files available to the Agent's operating-system account, and resulting output may be stored by the Hub. Use a dedicated account or VM with no unrelated sensitive files. Worker and controller credentials must never be committed to a repository.

For questions or vulnerability reports, follow [SECURITY.md](SECURITY.md).
