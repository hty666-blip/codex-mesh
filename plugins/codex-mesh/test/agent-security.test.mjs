import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { validateAgentConfig } from '../src/agent/config.mjs';
import {
  AgentRunner,
  buildCodexArgs,
  extractAgentMessage,
  resolveWorkspace,
  sanitizedChildEnvironment,
  validateTaskMode,
} from '../src/agent/runner.mjs';

test('Codex argv is locked down and an option-looking prompt is sent only over stdin', async () => {
  const prompt = '--yolo; Write-Output SHOULD_NOT_RUN && touch nope';
  assert.deepEqual(buildCodexArgs(prompt, 'read-only'), [
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
    'read-only',
    '--ephemeral',
    '--ignore-user-config',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    'web_search="disabled"',
    '-c',
    'shell_environment_policy.ignore_default_excludes=false',
    '--skip-git-repo-check',
    '--',
    '-',
  ]);

  const calls = [];
  const events = [];
  let receivedPrompt = '';
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk) => {
      receivedPrompt += chunk;
    });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    process.nextTick(() => {
      child.stdout.end(`${JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'finished safely' },
      })}\n`);
      child.stderr.end('diagnostic\n');
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
  const client = {
    taskEvent: async (_taskId, event) => events.push(event),
    poll: async () => ({ tasks: [], cancellations: [] }),
    heartbeat: async () => ({}),
  };
  const runner = new AgentRunner({
    config: { codexCommand: 'codex-test', workspaces: [], pollIntervalMs: 250 },
    client,
    spawnImpl: fakeSpawn,
    logger: { error() {} },
  });

  process.env.CODEX_MESH_TEST_SECRET = 'must-not-leak';
  try {
    const outcome = await runner.spawnAndMonitor({
      task: { id: 'task-1', prompt },
      workspace: { realPath: 'C:\\safe-workspace' },
      args: buildCodexArgs(prompt, 'read-only'),
    });
    assert.equal(outcome.code, 0);
    assert.equal(outcome.agentMessage, 'finished safely');
  } finally {
    delete process.env.CODEX_MESH_TEST_SECRET;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'codex-test');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, 'C:\\safe-workspace');
  assert.equal(calls[0].options.env.CODEX_MESH_TEST_SECRET, undefined);
  assert.equal(calls[0].options.stdio[0], 'pipe');
  assert.equal(calls[0].args.at(-1), '-');
  assert.equal(calls[0].args.includes(prompt), false);
  assert.equal(calls[0].args.at(-2), '--');
  assert.equal(receivedPrompt, prompt);
  assert.ok(events.some((event) => event.type === 'codex_event'));
  assert.ok(events.some((event) => event.type === 'stderr'));
});

test('workspace ids are exact allowlist lookups and changed realpaths are rejected', async () => {
  const config = {
    workspaces: [{ id: 'project/api', path: 'C:\\projects\\api', realPath: 'C:\\projects\\api', mode: 'workspace-write' }],
  };
  await assert.rejects(
    resolveWorkspace(config, '../project/api'),
    (error) => error.code === 'workspace_denied',
  );
  await assert.rejects(
    resolveWorkspace(config, 'project/api', {
      realpathImpl: async () => 'C:\\unexpected-target',
      statImpl: async () => ({ isDirectory: () => true }),
    }),
    (error) => error.code === 'workspace_changed',
  );
});

test('read-only workspace cannot be upgraded by a remote task', () => {
  assert.equal(validateTaskMode('read-only', 'read-only'), 'read-only');
  assert.throws(
    () => validateTaskMode('workspace-write', 'read-only'),
    (error) => error.code === 'mode_denied',
  );
  assert.throws(
    () => validateTaskMode('danger-full-access', 'workspace-write'),
    (error) => error.code === 'mode_denied',
  );
});

test('mesh secrets are removed case-insensitively from the Codex child environment', () => {
  assert.deepEqual(
    sanitizedChildEnvironment({
      PATH: '/bin',
      HOME: '/home/worker',
      CODEX_MESH_TOKEN: 'secret',
      codex_mesh_pairing_code: 'also-secret',
      GH_TOKEN: 'github-secret',
      AWS_REGION: 'us-east-1',
      SERVICE_PASSWORD: 'password',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      SAFE_VALUE: 'ok',
    }),
    { PATH: '/bin', HOME: '/home/worker' },
  );
  assert.deepEqual(
    sanitizedChildEnvironment(
      { OPENAI_API_KEY: 'explicit', CODEX_MESH_TOKEN: 'never', PATH: '/bin' },
      ['OPENAI_API_KEY', 'CODEX_MESH_TOKEN'],
    ),
    { OPENAI_API_KEY: 'explicit', PATH: '/bin' },
  );
  assert.deepEqual(
    sanitizedChildEnvironment({ CUSTOM_AUTH: 'hidden', LC_ALL: 'C', XDG_CONFIG_HOME: '/config' }),
    { LC_ALL: 'C', XDG_CONFIG_HOME: '/config' },
  );
});

test('agent config validates passEnv and permanently denies CODEX_MESH variables', () => {
  const base = {
    version: 1,
    hubUrl: 'http://127.0.0.1:7337',
    nodeId: 'node-1',
    token: 'node-token',
    workspaces: [{ id: 'project', path: '/project', realPath: '/project', mode: 'read-only' }],
  };
  assert.deepEqual(validateAgentConfig({ ...base }).passEnv, []);
  assert.deepEqual(validateAgentConfig({ ...base, passEnv: ['OPENAI_API_KEY'] }).passEnv, ['OPENAI_API_KEY']);
  assert.throws(
    () => validateAgentConfig({ ...base, passEnv: ['CODEX_MESH_TOKEN'] }),
    /can never include CODEX_MESH/,
  );
});

test('final agent_message is parsed from supported Codex JSONL shapes', () => {
  assert.equal(
    extractAgentMessage({ type: 'item.completed', item: { type: 'agent_message', text: 'one' } }),
    'one',
  );
  assert.equal(extractAgentMessage({ type: 'agent_message', message: 'two' }), 'two');
  assert.equal(
    extractAgentMessage({ type: 'item.completed', item: { type: 'command_execution', text: 'ignored' } }),
    null,
  );
});

test('a workspace outside the allowlist fails remotely without spawning Codex', async () => {
  const completions = [];
  const client = {
    startTask: async () => ({ task: {} }),
    completeTask: async (_taskId, body) => {
      completions.push(body);
      return {};
    },
    heartbeat: async () => ({}),
  };
  let spawned = false;
  const runner = new AgentRunner({
    config: {
      workspaces: [{ id: 'allowed', path: 'C:\\allowed', realPath: 'C:\\allowed', mode: 'workspace-write' }],
    },
    client,
    spawnImpl: () => {
      spawned = true;
    },
    logger: { error() {} },
  });
  await runner.executeTask({
    id: 'task-denied',
    prompt: 'do something',
    workspaceId: 'not-allowed',
    mode: 'read-only',
  });
  assert.equal(spawned, false);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].status, 'failed');
  assert.equal(completions[0].error.code, 'workspace_denied');
});

test('idle polling finalizes cancellation requests left by a previous crashed agent', async () => {
  const controller = new AbortController();
  const completions = [];
  const client = {
    heartbeat: async () => ({}),
    poll: async () => ({
      tasks: [],
      cancellations: [{ taskId: 'orphaned-task', reason: 'operator cancelled' }],
    }),
    completeTask: async (taskId, body) => {
      completions.push({ taskId, body });
      controller.abort();
      return {};
    },
  };
  const runner = new AgentRunner({
    config: { workspaces: [], pollIntervalMs: 250 },
    client,
    logger: { error() {} },
  });
  await runner.run({ signal: controller.signal });
  assert.deepEqual(completions, [{
    taskId: 'orphaned-task',
    body: {
      status: 'cancelled',
      error: { message: 'operator cancelled' },
    },
  }]);
});

test('local TTL terminates Codex even when the hub cannot be reached', async () => {
  let killSignal = null;
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = (signal) => {
      if (killSignal) return true;
      killSignal = signal;
      child.killed = true;
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', null, signal));
      return true;
    };
    return child;
  };
  const runner = new AgentRunner({
    config: { workspaces: [], pollIntervalMs: 250 },
    client: {
      taskEvent: async () => ({}),
      poll: async () => {
        throw new Error('hub offline');
      },
      heartbeat: async () => ({}),
    },
    spawnImpl: fakeSpawn,
    logger: { error() {} },
  });
  const outcome = await runner.spawnAndMonitor({
    task: { id: 'ttl-task', prompt: 'bounded work', expiresAt: new Date(Date.now() + 25).toISOString() },
    workspace: { realPath: '/safe' },
    args: buildCodexArgs('bounded work', 'read-only'),
  });
  assert.equal(killSignal, 'SIGTERM');
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.cancelReason, 'Task TTL expired');
});
