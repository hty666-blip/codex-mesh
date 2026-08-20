import { spawn as nodeSpawn } from 'node:child_process';
import { once } from 'node:events';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { ALLOWED_MODES, WINDOWS_SANDBOX_MODES } from './config.mjs';

const MAX_EVENT_LINE_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;

export class TaskValidationError extends Error {
  constructor(message, code = 'invalid_task') {
    super(message);
    this.name = 'TaskValidationError';
    this.code = code;
  }
}

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export async function resolveWorkspace(config, workspaceId, { realpathImpl = realpath, statImpl = stat } = {}) {
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new TaskValidationError('Task is missing workspaceId', 'workspace_required');
  }
  const workspace = config.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    throw new TaskValidationError(`Workspace "${workspaceId}" is not allowed on this node`, 'workspace_denied');
  }

  const currentRealPath = await realpathImpl(path.resolve(workspace.path));
  if (comparablePath(currentRealPath) !== comparablePath(workspace.realPath)) {
    throw new TaskValidationError(
      `Workspace "${workspaceId}" no longer resolves to its enrolled path`,
      'workspace_changed',
    );
  }
  const info = await statImpl(currentRealPath);
  if (!info.isDirectory()) {
    throw new TaskValidationError(`Workspace "${workspaceId}" is not a directory`, 'workspace_denied');
  }
  return { ...workspace, realPath: currentRealPath };
}

export function validateTaskMode(mode, workspaceMode = 'workspace-write') {
  if (!ALLOWED_MODES.has(mode)) {
    throw new TaskValidationError(`Unsupported task mode "${mode}"`, 'mode_denied');
  }
  if (workspaceMode === 'read-only' && mode !== 'read-only') {
    throw new TaskValidationError('This workspace is enrolled as read-only', 'mode_denied');
  }
  return mode;
}

export function buildCodexArgs(prompt, mode, { windowsSandbox } = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new TaskValidationError('Task prompt must be a non-empty string', 'prompt_required');
  }
  validateTaskMode(mode);
  if (windowsSandbox !== undefined && !WINDOWS_SANDBOX_MODES.has(windowsSandbox)) {
    throw new TaskValidationError('Windows sandbox must be elevated or unelevated', 'invalid_config');
  }
  return [
    '--ask-for-approval',
    'never',
    '--disable',
    'apps',
    '--disable',
    'hooks',
    '--disable',
    'remote_plugin',
    '--disable',
    'multi_agent',
    '--disable',
    'goals',
    '--disable',
    'memories',
    '--disable',
    'skill_mcp_dependency_install',
    'exec',
    '--json',
    '--sandbox',
    mode,
    '--ephemeral',
    '--ignore-user-config',
    ...(windowsSandbox === undefined ? [] : ['-c', `windows.sandbox="${windowsSandbox}"`]),
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    'web_search="disabled"',
    '-c',
    'shell_environment_policy.ignore_default_excludes=false',
    '--skip-git-repo-check',
    '--',
    '-',
  ];
}

const DEFAULT_CHILD_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'PROGRAMDATA',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'TZ',
  'CODEX_HOME',
]);
const DEFAULT_CHILD_ENV_PREFIXES = ['LC_', 'XDG_', 'SSL_CERT_', 'PROGRAMFILES'];

export function sanitizedChildEnvironment(source = process.env, passEnv = []) {
  const explicitlyAllowed = new Set(passEnv.map((name) => String(name).toUpperCase()));
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => {
      const normalized = key.toUpperCase();
      if (normalized.startsWith('CODEX_MESH_')) return false;
      if (explicitlyAllowed.has(normalized)) return true;
      if (DEFAULT_CHILD_ENV_NAMES.has(normalized)) return true;
      return DEFAULT_CHILD_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix));
    }),
  );
}

export function codexChildEnvironment(source = process.env, passEnv = [], codexProxy) {
  const environment = sanitizedChildEnvironment(source, passEnv);
  if (codexProxy !== undefined) {
    environment.HTTP_PROXY = codexProxy;
    environment.HTTPS_PROXY = codexProxy;
    environment.ALL_PROXY = codexProxy;
  }
  return environment;
}

function stringValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value
      .map((part) => (typeof part === 'string' ? part : part?.text))
      .filter((part) => typeof part === 'string')
      .join('');
    return text || null;
  }
  return null;
}

export function extractAgentMessage(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
    return stringValue(event.item.text) ?? stringValue(event.item.content);
  }
  if (event.type === 'agent_message') {
    return stringValue(event.message) ?? stringValue(event.text) ?? stringValue(event.content);
  }
  if (event.event === 'agent_message') {
    return stringValue(event.message) ?? stringValue(event.text) ?? stringValue(event.content);
  }
  return null;
}

function truncateUtf8(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  return { value: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

async function streamLines(stream, onLine) {
  if (!stream) return;
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) await onLine(line);
}

async function completeWithRetry(client, taskId, payload, signal) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await client.completeTask(taskId, payload, { signal });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 500, undefined, { signal }).catch(() => {});
    }
  }
  throw lastError;
}

function cancellationFor(cancellations, taskId) {
  return (Array.isArray(cancellations) ? cancellations : []).find(
    (item) => (item?.taskId ?? item?.id) === taskId,
  );
}

export class AgentRunner {
  constructor({
    config,
    client,
    spawnImpl = nodeSpawn,
    logger = console,
    pollIntervalMs = config.pollIntervalMs ?? 2_000,
    heartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000,
  }) {
    this.config = config;
    this.client = client;
    this.spawnImpl = spawnImpl;
    this.logger = logger;
    this.pollIntervalMs = Math.max(250, Number(pollIntervalMs));
    this.heartbeatIntervalMs = Math.max(5_000, Number(heartbeatIntervalMs));
    this.runningTaskId = null;
    this.runningChild = null;
    this.stopRequested = false;
  }

  publicWorkspaces() {
    return this.config.workspaces.map(({ id, mode = 'workspace-write' }) => ({ id, mode }));
  }

  heartbeatBody(status = this.runningTaskId ? 'busy' : 'idle') {
    return {
      status,
      tags: this.config.tags ?? [],
      capabilities: ['codex-exec'],
      workspaces: this.publicWorkspaces(),
      maxConcurrent: 1,
    };
  }

  async heartbeat(signal) {
    return this.client.heartbeat(this.heartbeatBody(), { signal });
  }

  requestStop() {
    this.stopRequested = true;
    if (this.runningChild && !this.runningChild.killed) this.runningChild.kill('SIGTERM');
  }

  async run({ signal } = {}) {
    await this.heartbeat(signal);
    let consecutiveFailures = 0;
    while (!this.stopRequested && !signal?.aborted) {
      try {
        const response = await this.client.poll({ limit: 1 }, { signal });
        consecutiveFailures = 0;
        for (const cancellation of Array.isArray(response.cancellations) ? response.cancellations : []) {
          const cancelledTaskId = cancellation?.taskId ?? cancellation?.id;
          if (typeof cancelledTaskId !== 'string' || !cancelledTaskId) continue;
          await completeWithRetry(
            this.client,
            cancelledTaskId,
            {
              status: 'cancelled',
              error: { message: cancellation.reason ?? 'Cancelled while the agent was offline' },
            },
            signal,
          );
        }
        const tasks = Array.isArray(response.tasks) ? response.tasks : [];
        const task = tasks[0];
        if (!task) {
          await delay(this.pollIntervalMs, undefined, { signal }).catch(() => {});
          continue;
        }
        await this.executeTask(task, { signal });
      } catch (error) {
        if (this.stopRequested || signal?.aborted) break;
        consecutiveFailures += 1;
        this.logger.error?.(`[codex-mesh] ${error?.message ?? String(error)}`);
        const waitMs = Math.min(30_000, this.pollIntervalMs * 2 ** Math.min(consecutiveFailures - 1, 4));
        await delay(waitMs, undefined, { signal }).catch(() => {});
      }
    }
  }

  async executeTask(originalTask, { signal } = {}) {
    const taskId = originalTask?.id;
    if (typeof taskId !== 'string' || !taskId) {
      throw new TaskValidationError('Hub returned a task without an id');
    }

    this.runningTaskId = taskId;
    try {
      const started = await this.client.startTask(taskId, { signal });
      const task = { ...originalTask, ...(started?.task ?? {}) };
      if (task.expiresAt) {
        const expiry = Date.parse(task.expiresAt);
        if (Number.isNaN(expiry)) throw new TaskValidationError('Task has an invalid expiresAt', 'invalid_task');
        if (expiry <= Date.now()) {
          throw new TaskValidationError('Task expired before it could start', 'task_expired');
        }
      }

      const workspace = await resolveWorkspace(this.config, task.workspaceId);
      const mode = validateTaskMode(task.mode, workspace.mode);
      const args = buildCodexArgs(task.prompt, mode, {
        windowsSandbox: this.config.windowsSandbox,
      });
      const outcome = await this.spawnAndMonitor({ task, workspace, args, signal });

      if (outcome.cancelled) {
        await completeWithRetry(
          this.client,
          taskId,
          {
            status: 'cancelled',
            result: outcome.agentMessage ? { agentMessage: outcome.agentMessage } : undefined,
            error: { message: outcome.cancelReason ?? 'Task cancelled' },
          },
          signal,
        );
      } else if (outcome.code === 0) {
        await completeWithRetry(
          this.client,
          taskId,
          {
            status: 'succeeded',
            result: {
              agentMessage: outcome.agentMessage ?? '',
              exitCode: outcome.code,
            },
          },
          signal,
        );
      } else {
        await completeWithRetry(
          this.client,
          taskId,
          {
            status: 'failed',
            result: outcome.agentMessage ? { agentMessage: outcome.agentMessage } : undefined,
            error: {
              code: 'codex_exit',
              message: `Codex exited with ${outcome.signal ? `signal ${outcome.signal}` : `code ${outcome.code}`}`,
            },
          },
          signal,
        );
      }
    } catch (error) {
      const cancelled = signal?.aborted || this.stopRequested;
      await completeWithRetry(
        this.client,
        taskId,
        {
          status: cancelled ? 'cancelled' : 'failed',
          error: {
            code: cancelled ? 'agent_stopped' : error?.code ?? 'agent_error',
            message: error?.message ?? String(error),
          },
        },
        signal?.aborted ? undefined : signal,
      );
    } finally {
      this.runningTaskId = null;
      this.runningChild = null;
      if (!signal?.aborted && !this.stopRequested) {
        await this.heartbeat(signal).catch((error) => {
          this.logger.error?.(`[codex-mesh] heartbeat failed: ${error?.message ?? String(error)}`);
        });
      }
    }
  }

  async spawnAndMonitor({ task, workspace, args, signal }) {
    const child = this.spawnImpl(this.config.codexCommand ?? 'codex', args, {
      cwd: workspace.realPath,
      env: codexChildEnvironment(
        process.env,
        this.config.passEnv ?? [],
        this.config.codexProxy,
      ),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.runningChild = child;

    if (!child.stdin) throw new Error('Codex child process did not expose stdin');
    child.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') {
        this.logger.error?.(`[codex-mesh] Codex stdin failed: ${error?.message ?? String(error)}`);
      }
    });
    child.stdin.end(task.prompt);

    let agentMessage = null;
    let cancelReason = null;
    let settled = false;
    let forceKillTimer;
    let expiryTimer;

    const terminate = (reason) => {
      if (settled || cancelReason) return;
      cancelReason = reason;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 5_000);
      forceKillTimer.unref?.();
    };

    if (task.expiresAt) {
      const expiresInMs = Date.parse(task.expiresAt) - Date.now();
      if (Number.isFinite(expiresInMs)) {
        if (expiresInMs <= 0) {
          terminate('Task TTL expired');
        } else {
          expiryTimer = setTimeout(() => terminate('Task TTL expired'), expiresInMs);
          expiryTimer.unref?.();
        }
      }
    }

    const abortHandler = () => terminate('Agent stopped');
    signal?.addEventListener('abort', abortHandler, { once: true });

    const reportEvent = async (body) => {
      try {
        await this.client.taskEvent(task.id, body);
      } catch (error) {
        this.logger.error?.(`[codex-mesh] event upload failed: ${error?.message ?? String(error)}`);
      }
    };

    const stdoutTask = streamLines(child.stdout, async (rawLine) => {
      if (!rawLine) return;
      const line = truncateUtf8(rawLine, MAX_EVENT_LINE_BYTES);
      let parsed;
      try {
        parsed = JSON.parse(line.value);
      } catch {
        await reportEvent({
          type: 'stdout',
          message: line.value,
          data: line.truncated ? { truncated: true } : undefined,
        });
        return;
      }
      const candidate = extractAgentMessage(parsed);
      if (candidate !== null) {
        agentMessage = truncateUtf8(candidate, MAX_RESULT_BYTES).value;
      }
      await reportEvent({
        type: 'codex_event',
        data: line.truncated ? { event: parsed, truncated: true } : parsed,
      });
    });

    const stderrTask = streamLines(child.stderr, async (rawLine) => {
      if (!rawLine) return;
      const line = truncateUtf8(rawLine, MAX_EVENT_LINE_BYTES);
      await reportEvent({
        type: 'stderr',
        message: line.value,
        data: line.truncated ? { truncated: true } : undefined,
      });
    });

    const monitorController = new AbortController();
    const monitorTask = this.monitorCancellation(task.id, {
      signal: monitorController.signal,
      onCancel: (reason) => terminate(reason),
    });

    let code;
    let exitSignal;
    try {
      [code, exitSignal] = await once(child, 'close');
    } finally {
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      signal?.removeEventListener('abort', abortHandler);
      monitorController.abort();
      await Promise.allSettled([stdoutTask, stderrTask, monitorTask]);
    }

    return {
      code,
      signal: exitSignal,
      cancelled: cancelReason !== null,
      cancelReason,
      agentMessage,
    };
  }

  async monitorCancellation(taskId, { signal, onCancel }) {
    let lastHeartbeat = 0;
    while (!signal.aborted) {
      await delay(this.pollIntervalMs, undefined, { signal }).catch(() => {});
      if (signal.aborted) break;
      try {
        const response = await this.client.poll({ limit: 0 }, { signal });
        const cancellation = cancellationFor(response.cancellations, taskId);
        if (cancellation) {
          onCancel(cancellation.reason ?? 'Cancelled by controller');
          break;
        }
        if (Date.now() - lastHeartbeat >= this.heartbeatIntervalMs) {
          await this.heartbeat(signal);
          lastHeartbeat = Date.now();
        }
      } catch (error) {
        if (!signal.aborted) {
          this.logger.error?.(`[codex-mesh] cancellation poll failed: ${error?.message ?? String(error)}`);
        }
      }
    }
  }
}
