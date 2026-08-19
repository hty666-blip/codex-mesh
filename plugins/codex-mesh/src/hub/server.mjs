import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { AtomicJsonStore } from './store.mjs';
import { HubCore } from './core.mjs';
import { bearerToken } from '../shared/security.mjs';
import { notFound } from '../shared/errors.mjs';
import { readJson, sendError, sendJson } from '../shared/http.mjs';

function routeId(pathname, suffix = '') {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^/v1/(?:agents/)?tasks/([^/]+)${escapedSuffix}$`).exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function revokedNodeId(pathname) {
  const match = /^\/v1\/nodes\/([^/]+)\/revoke$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function createRequestHandler(core, { logger = console } = {}) {
  return async function handleRequest(request, response) {
    try {
      const url = new URL(request.url, 'http://codex-mesh.local');
      const { pathname, searchParams } = url;

      if (request.method === 'GET' && pathname === '/v1/health') {
        sendJson(response, 200, await core.health());
        return;
      }

      if (request.method === 'POST' && pathname === '/v1/agents/enroll') {
        sendJson(response, 201, await core.enrollAgent(await readJson(request)));
        return;
      }

      if (pathname.startsWith('/v1/agents/')) {
        const agent = await core.authenticateAgent(bearerToken(request.headers));
        if (request.method === 'POST' && pathname === '/v1/agents/heartbeat') {
          sendJson(response, 200, await core.heartbeatAgent(agent.id, await readJson(request)));
          return;
        }
        if (request.method === 'POST' && pathname === '/v1/agents/poll') {
          sendJson(response, 200, await core.pollAgent(agent.id, await readJson(request)));
          return;
        }
        const startId = routeId(pathname, '/start');
        if (request.method === 'POST' && startId) {
          await readJson(request);
          sendJson(response, 200, await core.startAgentTask(agent.id, startId));
          return;
        }
        const eventId = routeId(pathname, '/event');
        if (request.method === 'POST' && eventId) {
          sendJson(response, 201, await core.addAgentEvent(agent.id, eventId, await readJson(request)));
          return;
        }
        const completeId = routeId(pathname, '/complete');
        if (request.method === 'POST' && completeId) {
          sendJson(response, 200, await core.completeAgentTask(agent.id, completeId, await readJson(request)));
          return;
        }
        throw notFound('Agent endpoint not found');
      }

      await core.authenticateController(bearerToken(request.headers));

      if (request.method === 'POST' && pathname === '/v1/pairings') {
        sendJson(response, 201, await core.createPairing(await readJson(request)));
        return;
      }
      if (request.method === 'GET' && pathname === '/v1/nodes') {
        sendJson(response, 200, await core.listNodes());
        return;
      }
      const nodeIdToRevoke = revokedNodeId(pathname);
      if (request.method === 'POST' && nodeIdToRevoke) {
        sendJson(response, 200, await core.revokeNode(nodeIdToRevoke, await readJson(request)));
        return;
      }
      if (request.method === 'POST' && pathname === '/v1/tasks') {
        const result = await core.createTask(await readJson(request));
        sendJson(response, result.created ? 201 : 200, result);
        return;
      }
      if (request.method === 'GET' && pathname === '/v1/tasks') {
        sendJson(response, 200, await core.listTasks({ status: searchParams.get('status') || undefined, limit: searchParams.get('limit') || undefined }));
        return;
      }
      const taskId = routeId(pathname);
      if (request.method === 'GET' && taskId) {
        sendJson(response, 200, await core.getTask(taskId));
        return;
      }
      const cancelId = routeId(pathname, '/cancel');
      if (request.method === 'POST' && cancelId) {
        sendJson(response, 200, await core.cancelTask(cancelId, await readJson(request)));
        return;
      }
      if (request.method === 'DELETE' && taskId) {
        sendJson(response, 200, await core.cancelTask(taskId));
        return;
      }
      if (request.method === 'POST' && pathname === '/v1/memories') {
        sendJson(response, 201, await core.addMemory(await readJson(request)));
        return;
      }
      if (request.method === 'GET' && (pathname === '/v1/memories' || pathname === '/v1/memories/search')) {
        sendJson(response, 200, await core.searchMemories({
          q: searchParams.get('q') || undefined,
          scope: searchParams.get('scope') || undefined,
          limit: searchParams.get('limit') || undefined,
        }));
        return;
      }
      throw notFound('Endpoint not found');
    } catch (error) {
      if (!response.headersSent) sendError(response, error, logger);
      else response.destroy(error);
    }
  };
}

export async function createHubServer({ storePath, logger = console, onlineWindowMs, cancellationGraceMs, clock } = {}) {
  if (!storePath) throw new TypeError('storePath is required');
  const store = await AtomicJsonStore.open(storePath);
  const core = new HubCore(store, { onlineWindowMs, cancellationGraceMs, clock });
  const server = createServer(createRequestHandler(core, { logger }));
  server.on('clientError', (error, socket) => {
    logger.warn?.(`HTTP client error: ${error.message}`);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return { server, core, store };
}

export async function listenHub(options = {}) {
  const host = options.host ?? '127.0.0.1';
  if (!isPrivateListenHost(host)) {
    throw new TypeError('Refusing a wildcard listen address or public/non-IP host; bind to loopback or a specific private-network IP');
  }
  const port = options.port ?? 7337;
  const hub = await createHubServer(options);
  await new Promise((resolve, reject) => {
    hub.server.once('error', reject);
    hub.server.listen(port, host, () => {
      hub.server.off('error', reject);
      resolve();
    });
  });
  const address = hub.server.address();
  const urlHost = isIP(host) === 6 ? `[${host}]` : host;
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    ...hub,
    host,
    port: actualPort,
    url: `http://${urlHost}:${actualPort}`,
    close: () => new Promise((resolve, reject) => hub.server.close((error) => error ? reject(error) : resolve())),
  };
}

function isPrivateListenHost(value) {
  const host = String(value).trim().toLowerCase();
  if (host === 'localhost') return true;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127
      || a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254);
  }
  if (version === 6) {
    if (host === '::1') return true;
    const first = Number.parseInt(host.split(':', 1)[0], 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}
