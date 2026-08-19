import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, '..');
const MCP_ENTRY = path.join(PROJECT_ROOT, 'src', 'mcp', 'server.mjs');

test('stdio MCP initializes, lists annotated tools, and calls the Hub', async (t) => {
  const requests = [];
  const hub = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    if (request.method === 'GET' && request.url === '/v1/nodes') {
      const body = JSON.stringify({
        nodes: [{ id: 'worker-win11', online: true, tags: ['windows', 'build'] }],
      });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }));
  });
  hub.listen(0, '127.0.0.1');
  await once(hub, 'listening');
  t.after(() => hub.close());

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-mesh-mcp-'));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const configPath = path.join(tempDir, 'controller.json');
  const address = hub.address();
  await writeFile(configPath, JSON.stringify({
    hubUrl: `http://127.0.0.1:${address.port}`,
    controllerToken: 'test_controller_token_123456789',
    requestTimeoutMs: 5_000,
  }));

  const child = spawn(process.execPath, [MCP_ENTRY, '--stdio', '--config', configPath], {
    cwd: PROJECT_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => child.kill());
  const rpc = createRpcClient(child);

  rpc.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  const initialized = await rpc.next();
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.equal(initialized.result.serverInfo.name, 'codex-mesh');

  rpc.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  rpc.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listed = await rpc.next();
  assert.equal(listed.id, 2);
  const names = listed.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'mesh_list_nodes',
    'mesh_create_pairing',
    'mesh_start_readonly_task',
    'mesh_start_workspace_task',
    'mesh_get_task',
    'mesh_cancel_task',
    'mesh_search_memory',
    'mesh_add_memory',
  ]);
  assert.equal(findTool(listed, 'mesh_list_nodes').annotations.readOnlyHint, true);
  assert.equal(findTool(listed, 'mesh_start_workspace_task').annotations.destructiveHint, true);
  assert.equal(findTool(listed, 'mesh_start_readonly_task').annotations.openWorldHint, true);
  assert.equal(findTool(listed, 'mesh_start_workspace_task').annotations.openWorldHint, true);
  assert.equal(findTool(listed, 'mesh_add_memory').annotations.destructiveHint, true);
  assert.deepEqual(findTool(listed, 'mesh_start_readonly_task').inputSchema.required, [
    'prompt',
    'workspace_id',
    'targets',
  ]);
  assert.equal(findTool(listed, 'mesh_list_nodes').annotations.openWorldHint, false);

  rpc.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'mesh_list_nodes', arguments: {} },
  });
  const called = await rpc.next();
  assert.equal(called.id, 3);
  assert.deepEqual(called.result.structuredContent.nodes, [
    { id: 'worker-win11', online: true, tags: ['windows', 'build'] },
  ]);
  assert.equal(called.result.content[0].type, 'text');
  assert.match(called.result.content[0].text, /worker-win11/);
  assert.deepEqual(requests, [{
    method: 'GET',
    url: '/v1/nodes',
    authorization: 'Bearer test_controller_token_123456789',
  }]);
});

function findTool(message, name) {
  return message.result.tools.find((tool) => tool.name === name);
}

function createRpcClient(child) {
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const messages = [];
  const waiters = [];
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else messages.push(message);
  });
  child.once('error', (error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  child.once('exit', (code) => {
    if (code !== null && code !== 0) {
      const error = new Error(`MCP child exited with code ${code}`);
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    }
  });
  return {
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    next() {
      if (messages.length > 0) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for MCP response')), 5_000);
        waiters.push({
          resolve(message) {
            clearTimeout(timer);
            resolve(message);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
    },
  };
}
