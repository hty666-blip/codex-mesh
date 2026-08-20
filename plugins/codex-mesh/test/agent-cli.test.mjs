import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main as agentMain } from '../src/agent/index.mjs';
import { ControllerClient } from '../src/cli/api-client.mjs';
import { defaultControllerConfigPath, validateControllerConfig } from '../src/cli/config.mjs';

test('controller config defaults to ~/.codex-mesh and supports the legacy token field', () => {
  assert.equal(
    defaultControllerConfigPath({}),
    path.join(os.homedir(), '.codex-mesh', 'controller.json'),
  );
  const modern = validateControllerConfig({
    version: 1,
    hubUrl: 'http://127.0.0.1:7337',
    controllerToken: 'modern-token',
  });
  assert.equal(modern.token, 'modern-token');
  const legacy = validateControllerConfig({
    version: 1,
    hubUrl: 'http://127.0.0.1:7337',
    token: 'legacy-token',
  });
  assert.equal(legacy.controllerToken, 'legacy-token');
});

test('node revoke uses the authenticated kill-switch endpoint', async () => {
  let observed;
  const client = new ControllerClient({
    hubUrl: 'http://127.0.0.1:7337',
    token: 'controller-secret',
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return new Response(JSON.stringify({ node: { id: 'node/unsafe', status: 'revoked' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await client.revokeNode('node/unsafe', { reason: 'device lost' });
  assert.equal(observed.url.pathname, '/v1/nodes/node%2Funsafe/revoke');
  assert.equal(observed.options.method, 'POST');
  assert.equal(observed.options.headers.authorization, 'Bearer controller-secret');
  assert.deepEqual(JSON.parse(observed.options.body), { reason: 'device lost' });
});

test('agent configure updates and clears local Codex execution settings without re-enrollment', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-mesh-configure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'agent.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    hubUrl: 'http://127.0.0.1:7337',
    nodeId: 'node-1',
    token: 'node-token',
    workspaces: [{ id: 'project', path: directory, realPath: directory, mode: 'workspace-write' }],
  }));

  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await agentMain([
      'configure',
      '--config', configPath,
      '--windows-sandbox', 'unelevated',
      '--codex-proxy', 'http://127.0.0.1:7897',
    ]);
    let configured = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(configured.nodeId, 'node-1');
    assert.equal(configured.token, 'node-token');
    assert.equal(configured.windowsSandbox, 'unelevated');
    assert.equal(configured.codexProxy, 'http://127.0.0.1:7897');

    await agentMain([
      'configure',
      '--config', configPath,
      '--clear-windows-sandbox',
      '--clear-codex-proxy',
    ]);
    configured = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal('windowsSandbox' in configured, false);
    assert.equal('codexProxy' in configured, false);
  } finally {
    process.stdout.write = originalWrite;
  }
});
