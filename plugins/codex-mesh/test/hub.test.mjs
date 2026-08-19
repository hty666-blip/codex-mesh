import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeHubData, listenHub, rotateControllerToken } from '../src/hub/index.mjs';

async function fixture(t, hubOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-mesh-hub-'));
  const initialized = await initializeHubData({
    dataDir: directory,
    controllerConfigPath: join(directory, 'controller.json'),
  });
  const hub = await listenHub({
    storePath: initialized.storePath,
    host: '127.0.0.1',
    port: 0,
    logger: { error() {}, warn() {} },
    ...hubOptions,
  });
  t.after(async () => {
    await hub.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function request(method, path, { token = initialized.controllerToken, body } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${hub.url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    return { response, payload };
  }

  async function enroll(name, { os = 'linux', tags = [], workspaces = [{ id: 'project/api', mode: 'workspace-write' }] } = {}) {
    const pairing = await request('POST', '/v1/pairings', { body: { name, expiresInSeconds: 120 } });
    assert.equal(pairing.response.status, 201);
    const result = await request('POST', '/v1/agents/enroll', {
      token: null,
      body: {
        pairingCode: pairing.payload.pairingCode,
        name,
        os,
        tags,
        capabilities: ['codex'],
        workspaces,
        maxConcurrent: 2,
      },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.payload));
    return result.payload;
  }

  return { ...initialized, hub, request, enroll };
}

test('init stores only the controller token hash and health is public', async (t) => {
  const app = await fixture(t);
  const storeText = await readFile(app.storePath, 'utf8');
  const configText = await readFile(app.controllerConfigPath, 'utf8');
  const controllerConfig = JSON.parse(configText);
  assert.equal(storeText.includes(app.controllerToken), false);
  assert.equal(configText.includes(app.controllerToken), true);
  assert.equal(controllerConfig.controllerToken, app.controllerToken);
  assert.equal('token' in controllerConfig, false);

  const health = await app.request('GET', '/v1/health', { token: null });
  assert.equal(health.response.status, 200);
  assert.equal(health.payload.ok, true);

  const denied = await app.request('GET', '/v1/nodes', { token: 'wrong' });
  assert.equal(denied.response.status, 401);
  assert.equal(denied.payload.error.code, 'unauthorized');
});

test('one-use pairings enroll dynamic nodes without exposing local paths', async (t) => {
  const app = await fixture(t);
  const pairing = await app.request('POST', '/v1/pairings', { body: { name: 'windows-worker' } });
  const enrolled = await app.request('POST', '/v1/agents/enroll', {
    token: null,
    body: {
      pairingCode: pairing.payload.pairingCode,
      name: 'windows-worker',
      os: 'windows',
      tags: ['desktop', 'gpu'],
      workspaces: [{ id: 'project/api', mode: 'workspace-write', path: 'C:\\secret\\repo' }],
    },
  });
  assert.equal(enrolled.response.status, 201);
  assert.match(enrolled.payload.token, /^cmagent_/);
  assert.deepEqual(enrolled.payload.node.workspaces, [{ id: 'project/api', mode: 'workspace-write' }]);
  assert.equal('tokenHash' in enrolled.payload.node, false);

  const reused = await app.request('POST', '/v1/agents/enroll', {
    token: null,
    body: { pairingCode: pairing.payload.pairingCode, name: 'intruder', os: 'linux' },
  });
  assert.equal(reused.response.status, 401);

  const nodes = await app.request('GET', '/v1/nodes');
  assert.equal(nodes.payload.nodes.length, 1);
  assert.equal(nodes.payload.nodes[0].online, true);
  assert.equal(JSON.stringify(nodes.payload).includes('secret'), false);
});

test('multi-node parallel tasks support selectors and idempotency', async (t) => {
  const app = await fixture(t);
  const first = await app.enroll('ubuntu-a', { tags: ['linux', 'build'] });
  const second = await app.enroll('ubuntu-b', { tags: ['linux', 'build'] });
  await app.enroll('windows-c', { os: 'windows', tags: ['desktop'] });

  const body = {
    prompt: 'Run the API tests',
    workspaceId: 'project/api',
    mode: 'read-only',
    execution: 'parallel',
    targets: { selector: { tags: ['build'], os: 'linux', online: true, limit: 10 } },
    idempotencyKey: 'test-run-42',
    ttlSeconds: 300,
  };
  const created = await app.request('POST', '/v1/tasks', { body });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.deepEqual(new Set(created.payload.task.targetNodeIds), new Set([first.node.id, second.node.id]));
  assert.equal(created.payload.task.assignments.length, 2);

  const repeated = await app.request('POST', '/v1/tasks', { body: { ...body, prompt: 'This must not replace the original' } });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.payload.created, false);
  assert.equal(repeated.payload.task.id, created.payload.task.id);
  assert.equal(repeated.payload.task.prompt, 'Run the API tests');
});

test('agents claim, start, stream events, complete, and acknowledge cancellation', async (t) => {
  const app = await fixture(t);
  const first = await app.enroll('worker-a');
  const second = await app.enroll('worker-b');
  const created = await app.request('POST', '/v1/tasks', {
    body: {
      prompt: 'Build in parallel',
      workspaceId: 'project/api',
      mode: 'workspace-write',
      execution: 'parallel',
      targets: { nodeIds: [first.node.id, second.node.id] },
    },
  });
  const taskId = created.payload.task.id;

  for (const agent of [first, second]) {
    const polled = await app.request('POST', '/v1/agents/poll', { token: agent.token, body: { limit: 1 } });
    assert.equal(polled.payload.tasks[0].id, taskId);
    const started = await app.request('POST', `/v1/agents/tasks/${taskId}/start`, { token: agent.token, body: {} });
    assert.equal(started.response.status, 200);
  }
  const event = await app.request('POST', `/v1/agents/tasks/${taskId}/event`, {
    token: first.token,
    body: { type: 'progress', message: 'Tests passed', data: { percent: 90 } },
  });
  assert.equal(event.response.status, 201);
  await app.request('POST', `/v1/agents/tasks/${taskId}/complete`, {
    token: first.token,
    body: { status: 'succeeded', result: { summary: 'done' } },
  });
  const completed = await app.request('POST', `/v1/agents/tasks/${taskId}/complete`, {
    token: second.token,
    body: { status: 'succeeded', artifacts: [{ name: 'test.log', sha256: 'abc' }] },
  });
  assert.equal(completed.payload.task.status, 'succeeded');
  assert.equal(completed.payload.task.events[0].message, 'Tests passed');

  const cancellable = await app.request('POST', '/v1/tasks', {
    body: {
      prompt: 'Long task',
      workspaceId: 'project/api',
      mode: 'read-only',
      execution: 'single',
      targets: { nodeIds: [first.node.id] },
    },
  });
  const cancelTaskId = cancellable.payload.task.id;
  await app.request('POST', '/v1/agents/poll', { token: first.token, body: { limit: 1 } });
  await app.request('POST', `/v1/agents/tasks/${cancelTaskId}/start`, { token: first.token, body: {} });
  const cancelled = await app.request('POST', `/v1/tasks/${cancelTaskId}/cancel`, { body: { reason: 'No longer needed' } });
  assert.equal(cancelled.payload.task.status, 'cancel_requested');
  const cancellationPoll = await app.request('POST', '/v1/agents/poll', { token: first.token, body: { limit: 0 } });
  assert.deepEqual(cancellationPoll.payload.tasks, []);
  assert.deepEqual(cancellationPoll.payload.cancellations, [{ taskId: cancelTaskId, reason: 'No longer needed' }]);
  const acknowledged = await app.request('POST', `/v1/agents/tasks/${cancelTaskId}/complete`, {
    token: first.token,
    body: { status: 'cancelled' },
  });
  assert.equal(acknowledged.payload.task.status, 'cancelled');
});

test('first_available is claimed once and memory can be added, updated, and searched', async (t) => {
  const app = await fixture(t);
  const first = await app.enroll('fast-a', { tags: ['fast'] });
  const second = await app.enroll('fast-b', { tags: ['fast'] });
  const created = await app.request('POST', '/v1/tasks', {
    body: {
      prompt: 'First worker wins',
      workspaceId: 'project/api',
      mode: 'read-only',
      execution: 'first_available',
      targets: { nodeIds: [first.node.id, second.node.id] },
    },
  });
  const firstPoll = await app.request('POST', '/v1/agents/poll', { token: second.token, body: { limit: 1 } });
  assert.equal(firstPoll.payload.tasks[0].id, created.payload.task.id);
  const losingPoll = await app.request('POST', '/v1/agents/poll', { token: first.token, body: { limit: 1 } });
  assert.deepEqual(losingPoll.payload.tasks, []);

  const added = await app.request('POST', '/v1/memories', {
    body: {
      scope: 'project/api',
      key: 'test-command',
      content: 'Use npm test for the API',
      tags: ['testing', 'api'],
    },
  });
  assert.equal(added.response.status, 201);
  const updated = await app.request('POST', '/v1/memories', {
    body: { scope: 'project/api', key: 'test-command', content: 'Use npm run test:api', tags: ['testing'] },
  });
  assert.equal(updated.payload.memory.id, added.payload.memory.id);
  const searched = await app.request('GET', '/v1/memories/search?q=test%3Aapi&scope=project&limit=10');
  assert.equal(searched.payload.memories.length, 1);
  assert.equal(searched.payload.memories[0].content, 'Use npm run test:api');
});

test('task TTL expires unclaimed assignments', async (t) => {
  let now = Date.parse('2026-08-19T10:00:00.000Z');
  const app = await fixture(t, { clock: () => now });
  const agent = await app.enroll('ttl-worker');
  const created = await app.request('POST', '/v1/tasks', {
    body: {
      prompt: 'This task will expire',
      workspaceId: 'project/api',
      mode: 'read-only',
      execution: 'single',
      targets: { nodeIds: [agent.node.id] },
      ttlSeconds: 5,
    },
  });
  now += 6_000;
  const fetched = await app.request('GET', `/v1/tasks/${created.payload.task.id}`);
  assert.equal(fetched.payload.task.status, 'expired');
  assert.equal(fetched.payload.task.assignments[0].status, 'expired');
});

test('controller can revoke a node, invalidate its token, and cancel its active assignment', async (t) => {
  const app = await fixture(t);
  const agent = await app.enroll('lost-laptop');
  const created = await app.request('POST', '/v1/tasks', {
    body: {
      prompt: 'A task on a machine that was lost',
      workspaceId: 'project/api',
      mode: 'read-only',
      execution: 'single',
      targets: { nodeIds: [agent.node.id] },
    },
  });
  const taskId = created.payload.task.id;
  await app.request('POST', '/v1/agents/poll', { token: agent.token, body: { limit: 1 } });
  await app.request('POST', `/v1/agents/tasks/${taskId}/start`, { token: agent.token, body: {} });

  const revoked = await app.request('POST', `/v1/nodes/${agent.node.id}/revoke`, {
    body: { reason: 'Device was lost' },
  });
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.payload.revoked, true);
  assert.equal(revoked.payload.node.status, 'revoked');
  assert.equal(revoked.payload.node.online, false);
  assert.equal('tokenHash' in revoked.payload.node, false);
  assert.deepEqual(revoked.payload.affectedTaskIds, [taskId]);

  const oldToken = await app.request('POST', '/v1/agents/heartbeat', { token: agent.token, body: {} });
  assert.equal(oldToken.response.status, 403);
  const task = await app.request('GET', `/v1/tasks/${taskId}`);
  assert.equal(task.payload.task.status, 'cancelled');
  assert.equal(task.payload.task.assignments[0].status, 'cancelled');

  const repeated = await app.request('POST', `/v1/nodes/${agent.node.id}/revoke`, { body: {} });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.payload.revoked, false);
});

test('tasks require an allowlisted workspace and wildcard listen addresses are rejected', async (t) => {
  const app = await fixture(t);
  const agent = await app.enroll('bounded-worker');
  const missingWorkspace = await app.request('POST', '/v1/tasks', {
    body: {
      prompt: 'Do not run outside an allowlisted workspace',
      mode: 'read-only',
      execution: 'single',
      targets: { nodeIds: [agent.node.id] },
    },
  });
  assert.equal(missingWorkspace.response.status, 400);
  assert.match(missingWorkspace.payload.error.message, /workspaceId/);
  await assert.rejects(
    listenHub({ storePath: app.storePath, host: '0.0.0.0', port: 0 }),
    /wildcard listen address/,
  );
  await assert.rejects(
    listenHub({ storePath: app.storePath, host: '::', port: 0 }),
    /wildcard listen address/,
  );
  await assert.rejects(
    listenHub({ storePath: app.storePath, host: '8.8.8.8', port: 0 }),
    /public\/non-IP host/,
  );
});

test('an assigned task is redelivered to the same agent after a pre-start restart', async (t) => {
  const app = await fixture(t);
  const agent = await app.enroll('restartable-worker');
  const created = await app.request('POST', '/v1/tasks', {
    body: {
      prompt: 'Survive an agent restart before start',
      workspaceId: 'project/api',
      mode: 'read-only',
      execution: 'single',
      targets: { nodeIds: [agent.node.id] },
    },
  });
  const firstPoll = await app.request('POST', '/v1/agents/poll', { token: agent.token, body: { limit: 1 } });
  assert.equal(firstPoll.payload.tasks[0].id, created.payload.task.id);
  assert.equal(firstPoll.payload.tasks[0].assignment.status, 'assigned');

  const afterRestart = await app.request('POST', '/v1/agents/poll', { token: agent.token, body: { limit: 1 } });
  assert.equal(afterRestart.payload.tasks[0].id, created.payload.task.id);
  assert.equal(afterRestart.payload.tasks[0].assignment.status, 'assigned');
  await app.request('POST', `/v1/agents/tasks/${created.payload.task.id}/start`, { token: agent.token, body: {} });
  const whileRunning = await app.request('POST', '/v1/agents/poll', { token: agent.token, body: { limit: 1 } });
  assert.deepEqual(whileRunning.payload.tasks, []);
});

test('local controller-token rotation invalidates the old token and updates only the private config', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-mesh-rotate-'));
  const controllerConfigPath = join(directory, 'controller.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initialized = await initializeHubData({ dataDir: directory, controllerConfigPath });
  const rotated = await rotateControllerToken({ dataDir: directory, controllerConfigPath });
  assert.notEqual(rotated.controllerToken, initialized.controllerToken);
  const config = JSON.parse(await readFile(controllerConfigPath, 'utf8'));
  const storeText = await readFile(initialized.storePath, 'utf8');
  assert.equal(config.controllerToken, rotated.controllerToken);
  assert.equal(storeText.includes(rotated.controllerToken), false);

  const hub = await listenHub({ storePath: initialized.storePath, host: '127.0.0.1', port: 0, logger: { error() {}, warn() {} } });
  t.after(() => hub.close());
  const oldResponse = await fetch(`${hub.url}/v1/nodes`, {
    headers: { authorization: `Bearer ${initialized.controllerToken}` },
  });
  const newResponse = await fetch(`${hub.url}/v1/nodes`, {
    headers: { authorization: `Bearer ${rotated.controllerToken}` },
  });
  assert.equal(oldResponse.status, 401);
  assert.equal(newResponse.status, 200);
});

test('an unresponsive running assignment becomes terminal after TTL cancellation grace', async (t) => {
  let now = Date.parse('2026-08-19T12:00:00.000Z');
  const app = await fixture(t, { clock: () => now, cancellationGraceMs: 60_000 });
  const agent = await app.enroll('offline-during-task');
  const created = await app.request('POST', '/v1/tasks', {
    body: {
      prompt: 'Simulate an agent that disappears while running',
      workspaceId: 'project/api',
      mode: 'read-only',
      execution: 'single',
      targets: { nodeIds: [agent.node.id] },
      ttlSeconds: 5,
    },
  });
  await app.request('POST', '/v1/agents/poll', { token: agent.token, body: { limit: 1 } });
  await app.request('POST', `/v1/agents/tasks/${created.payload.task.id}/start`, { token: agent.token, body: {} });
  now += 6_000;
  const cancellation = await app.request('GET', `/v1/tasks/${created.payload.task.id}`);
  assert.equal(cancellation.payload.task.status, 'cancel_requested');
  assert.equal(cancellation.payload.task.assignments[0].status, 'cancel_requested');
  now += 61_000;
  const terminal = await app.request('GET', `/v1/tasks/${created.payload.task.id}`);
  assert.equal(terminal.payload.task.status, 'expired');
  assert.equal(terminal.payload.task.assignments[0].status, 'expired');
});

test('a late pre-start Agent failure cannot overwrite a controller cancellation', async (t) => {
  const app = await fixture(t);
  const agent = await app.enroll('cancel-race-worker');
  const created = await app.request('POST', '/v1/tasks', {
    body: {
      prompt: 'Do not start after cancellation',
      workspaceId: 'project/api',
      mode: 'read-only',
      execution: 'single',
      targets: { nodeIds: [agent.node.id] },
    },
  });
  const taskId = created.payload.task.id;
  await app.request('POST', '/v1/agents/poll', { token: agent.token, body: { limit: 1 } });
  await app.request('POST', `/v1/tasks/${taskId}/cancel`, { body: { reason: 'Controller changed its mind' } });

  const rejectedStart = await app.request('POST', `/v1/agents/tasks/${taskId}/start`, {
    token: agent.token,
    body: {},
  });
  assert.equal(rejectedStart.response.status, 409);

  const lateFailure = await app.request('POST', `/v1/agents/tasks/${taskId}/complete`, {
    token: agent.token,
    body: { status: 'failed', error: { message: 'start returned 409' } },
  });
  assert.equal(lateFailure.response.status, 200);
  assert.equal(lateFailure.payload.task.status, 'cancelled');
  assert.equal(lateFailure.payload.task.assignments[0].status, 'cancelled');
});

test('a late Agent completion cannot overwrite an expired running assignment', async (t) => {
  let now = Date.parse('2026-08-19T13:00:00.000Z');
  const app = await fixture(t, { clock: () => now, cancellationGraceMs: 60_000 });
  const agent = await app.enroll('ttl-race-worker');
  const created = await app.request('POST', '/v1/tasks', {
    body: {
      prompt: 'Stop at the TTL',
      workspaceId: 'project/api',
      mode: 'read-only',
      execution: 'single',
      targets: { nodeIds: [agent.node.id] },
      ttlSeconds: 5,
    },
  });
  const taskId = created.payload.task.id;
  await app.request('POST', '/v1/agents/poll', { token: agent.token, body: { limit: 1 } });
  await app.request('POST', `/v1/agents/tasks/${taskId}/start`, { token: agent.token, body: {} });
  now += 6_000;

  const lateCompletion = await app.request('POST', `/v1/agents/tasks/${taskId}/complete`, {
    token: agent.token,
    body: { status: 'cancelled', error: { message: 'local TTL stopped Codex' } },
  });
  assert.equal(lateCompletion.response.status, 200);
  assert.equal(lateCompletion.payload.task.status, 'expired');
  assert.equal(lateCompletion.payload.task.assignments[0].status, 'expired');
});

test('heartbeat cannot expand an enrolled node policy', async (t) => {
  const app = await fixture(t);
  const agent = await app.enroll('policy-bound-worker', {
    tags: ['trusted'],
    workspaces: [{ id: 'project/api', mode: 'read-only' }],
  });
  const heartbeat = await app.request('POST', '/v1/agents/heartbeat', {
    token: agent.token,
    body: {
      status: 'busy',
      os: 'forged-os',
      tags: ['untrusted-selector'],
      capabilities: ['anything'],
      workspaces: [
        { id: 'project/api', mode: 'workspace-write' },
        { id: 'secret/project', mode: 'workspace-write' },
      ],
      maxConcurrent: 64,
    },
  });
  assert.equal(heartbeat.response.status, 200);
  assert.equal(heartbeat.payload.node.agentState, 'busy');
  assert.equal(heartbeat.payload.node.os, 'linux');
  assert.deepEqual(heartbeat.payload.node.tags, ['trusted']);
  assert.deepEqual(heartbeat.payload.node.workspaces, [{ id: 'project/api', mode: 'read-only' }]);
  assert.equal(heartbeat.payload.node.maxConcurrent, 2);
});
