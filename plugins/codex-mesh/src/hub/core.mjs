import { randomUUID } from 'node:crypto';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../shared/errors.mjs';
import { hashSecret, randomToken, verifySecret } from '../shared/security.mjs';

const TASK_MODES = new Set(['read-only', 'workspace-write']);
const EXECUTIONS = new Set(['single', 'parallel', 'first_available']);
const ASSIGNMENT_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'skipped']);
const COMPLETE_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

function iso(now = Date.now()) {
  return new Date(now).toISOString();
}

function requiredText(value, field, maxLength = 100_000) {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`${field} is required`);
  if (value.length > maxLength) throw badRequest(`${field} is too long`);
  return value.trim();
}

function optionalText(value, field, maxLength = 500) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  if (value.length > maxLength) throw badRequest(`${field} is too long`);
  return value.trim();
}

function stringArray(value, field, { max = 100 } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw badRequest(`${field} must be an array of at most ${max} strings`);
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) throw badRequest(`${field} must contain non-empty strings`);
    const normalized = item.trim();
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function positiveInteger(value, field, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function normalizeWorkspaces(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500) throw badRequest('workspaces must be an array');
  const byId = new Map();
  for (const item of value) {
    const workspace = typeof item === 'string' ? { id: item } : item;
    if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
      throw badRequest('Each workspace must be a string or object');
    }
    const id = requiredText(workspace.id, 'workspace.id', 200);
    const mode = workspace.mode ?? 'workspace-write';
    if (!TASK_MODES.has(mode)) throw badRequest('workspace.mode must be read-only or workspace-write');
    byId.set(id, { id, mode });
  }
  return [...byId.values()];
}

function normalizeNodeInput(body, current = {}) {
  const result = { ...current };
  if (body.name !== undefined || !current.name) result.name = requiredText(body.name, 'name', 100);
  if (body.os !== undefined || !current.os) result.os = requiredText(body.os, 'os', 100).toLowerCase();
  if (body.tags !== undefined) result.tags = stringArray(body.tags, 'tags', { max: 100 });
  else if (!result.tags) result.tags = [];
  if (body.capabilities !== undefined) result.capabilities = stringArray(body.capabilities, 'capabilities', { max: 100 });
  else if (!result.capabilities) result.capabilities = [];
  if (body.workspaces !== undefined) result.workspaces = normalizeWorkspaces(body.workspaces);
  else if (!result.workspaces) result.workspaces = [];
  if (body.maxConcurrent !== undefined || !current.maxConcurrent) {
    result.maxConcurrent = positiveInteger(body.maxConcurrent, 'maxConcurrent', 1, { min: 1, max: 64 });
  }
  return result;
}

function publicNode(node, now, onlineWindowMs, activeCounts = new Map()) {
  const { tokenHash: _tokenHash, ...safe } = node;
  return {
    ...safe,
    online: node.status !== 'revoked' && now - Date.parse(node.lastSeenAt) <= onlineWindowMs,
    activeTaskCount: activeCounts.get(node.id) ?? 0,
  };
}

function activeCounts(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    for (const assignment of task.assignments) {
      if (['assigned', 'running', 'cancel_requested'].includes(assignment.status)) {
        counts.set(assignment.nodeId, (counts.get(assignment.nodeId) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function publicPairing(pairing) {
  const { codeHash: _codeHash, ...safe } = pairing;
  return safe;
}

function workspaceAllowed(node, workspaceId, mode) {
  if (!workspaceId) return false;
  const workspace = node.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return false;
  return mode === 'read-only' || workspace.mode === 'workspace-write';
}

function selectNodes(nodes, targets, mode, workspaceId, now, onlineWindowMs) {
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) throw badRequest('targets is required');
  const hasIds = targets.nodeIds !== undefined;
  const hasSelector = targets.selector !== undefined;
  if (hasIds === hasSelector) throw badRequest('targets must contain exactly one of nodeIds or selector');

  let selected;
  if (hasIds) {
    const ids = stringArray(targets.nodeIds, 'targets.nodeIds', { max: 500 });
    if (ids.length === 0) throw badRequest('targets.nodeIds must not be empty');
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw badRequest('Unknown target node IDs', { nodeIds: missing });
    const unavailable = ids.filter((id) => byId.get(id).status === 'revoked');
    if (unavailable.length) throw conflict('One or more target nodes are revoked', { nodeIds: unavailable });
    selected = ids.map((id) => byId.get(id));
    const denied = selected.filter((node) => !workspaceAllowed(node, workspaceId, mode)).map((node) => node.id);
    if (denied.length) {
      throw conflict('One or more target nodes do not allow the requested workspace mode', {
        nodeIds: denied,
        workspaceId,
        mode,
      });
    }
  } else {
    const selector = targets.selector;
    if (!selector || typeof selector !== 'object' || Array.isArray(selector)) throw badRequest('targets.selector must be an object');
    const tags = stringArray(selector.tags, 'targets.selector.tags', { max: 100 });
    const osValues = selector.os === undefined
      ? []
      : (Array.isArray(selector.os) ? stringArray(selector.os, 'targets.selector.os') : [requiredText(selector.os, 'targets.selector.os', 100)]);
    const requireOnline = selector.online !== false;
    selected = nodes.filter((node) => {
      if (node.status === 'revoked') return false;
      if (tags.some((tag) => !node.tags.includes(tag))) return false;
      if (osValues.length && !osValues.some((value) => value.toLowerCase() === node.os.toLowerCase())) return false;
      if (requireOnline && now - Date.parse(node.lastSeenAt) > onlineWindowMs) return false;
      return true;
    });
    const limit = positiveInteger(selector.limit, 'targets.selector.limit', selected.length || 1, { min: 1, max: 500 });
    selected = selected.slice(0, limit);
  }
  selected = selected.filter((node) => workspaceAllowed(node, workspaceId, mode));
  if (selected.length === 0) {
    throw conflict('No nodes match the target and workspace requirements', { workspaceId, mode });
  }
  return selected;
}

function recomputeTask(task, now = Date.now()) {
  const statuses = task.assignments.map((assignment) => assignment.status);
  if (task.cancelRequestedAt && statuses.some((status) => !ASSIGNMENT_TERMINAL.has(status))) {
    task.status = 'cancel_requested';
  } else if (statuses.includes('running')) {
    task.status = 'running';
  } else if (statuses.includes('assigned')) {
    task.status = 'assigned';
  } else if (statuses.includes('queued')) {
    task.status = 'queued';
  } else if (statuses.includes('cancel_requested')) {
    task.status = 'cancel_requested';
  } else if (statuses.includes('failed')) {
    task.status = 'failed';
  } else if (statuses.includes('cancelled')) {
    task.status = 'cancelled';
  } else if (statuses.includes('expired')) {
    task.status = 'expired';
  } else {
    task.status = 'succeeded';
  }
  if (['succeeded', 'failed', 'cancelled', 'expired'].includes(task.status) && !task.completedAt) {
    task.completedAt = iso(now);
  }
  task.updatedAt = iso(now);
  return task;
}

function expireTasks(tasks, now, cancellationGraceMs) {
  for (const task of tasks) {
    if (ASSIGNMENT_TERMINAL.has(task.status)) continue;
    let changed = false;
    for (const assignment of task.assignments) {
      if (assignment.status === 'cancel_requested'
        && assignment.cancelDeadlineAt
        && Date.parse(assignment.cancelDeadlineAt) <= now) {
        assignment.status = assignment.cancelTerminalStatus ?? 'expired';
        assignment.completedAt = iso(now);
        changed = true;
      }
    }
    if (Date.parse(task.expiresAt) > now) {
      if (changed) recomputeTask(task, now);
      continue;
    }
    task.cancelRequestedAt ??= iso(now);
    task.cancelReason ??= 'Task TTL expired';
    for (const assignment of task.assignments) {
      if (assignment.status === 'queued') {
        assignment.status = 'expired';
        assignment.completedAt = iso(now);
        changed = true;
      } else if (['assigned', 'running'].includes(assignment.status)) {
        assignment.status = 'cancel_requested';
        assignment.cancelReason = 'Task TTL expired';
        assignment.cancelTerminalStatus = 'expired';
        assignment.cancelRequestedAt = iso(now);
        assignment.cancelDeadlineAt = iso(now + cancellationGraceMs);
        changed = true;
      } else if (assignment.status === 'cancel_requested' && !assignment.cancelDeadlineAt) {
        assignment.cancelDeadlineAt = iso(now + cancellationGraceMs);
        changed = true;
      }
    }
    if (changed) recomputeTask(task, now);
  }
}

function deliveryTask(task, assignment) {
  return {
    id: task.id,
    prompt: task.prompt,
    workspaceId: task.workspaceId,
    mode: task.mode,
    execution: task.execution,
    metadata: task.metadata,
    createdAt: task.createdAt,
    expiresAt: task.expiresAt,
    assignment: structuredClone(assignment),
  };
}

export class HubCore {
  constructor(store, { onlineWindowMs = 90_000, cancellationGraceMs = 60_000, clock = () => Date.now() } = {}) {
    this.store = store;
    this.onlineWindowMs = onlineWindowMs;
    this.cancellationGraceMs = cancellationGraceMs;
    this.clock = clock;
  }

  async authenticateController(token) {
    const data = await this.store.read();
    if (!verifySecret(token, data.controllerTokenHash)) throw unauthorized('Invalid controller token');
  }

  async authenticateAgent(token) {
    if (!token) throw unauthorized('Agent token required');
    const data = await this.store.read();
    const node = data.nodes.find((candidate) => verifySecret(token, candidate.tokenHash));
    if (!node) throw unauthorized('Invalid agent token');
    if (node.status === 'revoked') throw forbidden('Agent has been revoked');
    return node;
  }

  async health() {
    const data = await this.store.read();
    const now = this.clock();
    return {
      ok: true,
      service: 'codex-mesh-hub',
      version: data.version,
      serverTime: iso(now),
      nodeCount: data.nodes.length,
      onlineNodeCount: data.nodes.filter((node) => node.status !== 'revoked' && now - Date.parse(node.lastSeenAt) <= this.onlineWindowMs).length,
    };
  }

  createPairing(body) {
    const now = this.clock();
    const expiresInSeconds = positiveInteger(body.expiresInSeconds, 'expiresInSeconds', 600, { min: 30, max: 86_400 });
    const pairingCode = randomToken('cmpair', 18);
    return this.store.transaction((data) => {
      data.pairings = data.pairings.filter((pairing) => !pairing.usedAt && Date.parse(pairing.expiresAt) > now);
      const pairing = {
        id: randomUUID(),
        name: optionalText(body.name, 'name', 100),
        codeHash: hashSecret(pairingCode),
        createdAt: iso(now),
        expiresAt: iso(now + expiresInSeconds * 1000),
        usedAt: null,
      };
      data.pairings.push(pairing);
      return { pairingCode, pairing: publicPairing(pairing) };
    });
  }

  enrollAgent(body) {
    const pairingCode = requiredText(body.pairingCode, 'pairingCode', 200);
    const details = normalizeNodeInput(body);
    const token = randomToken('cmagent', 32);
    const now = this.clock();
    return this.store.transaction((data) => {
      const pairing = data.pairings.find((candidate) => verifySecret(pairingCode, candidate.codeHash));
      if (!pairing || pairing.usedAt || Date.parse(pairing.expiresAt) <= now) {
        throw unauthorized('Pairing code is invalid, expired, or already used');
      }
      if (data.nodes.some((node) => node.name.toLowerCase() === details.name.toLowerCase() && node.status !== 'revoked')) {
        throw conflict(`A node named ${details.name} is already enrolled`);
      }
      pairing.usedAt = iso(now);
      const node = {
        id: randomUUID(),
        ...details,
        tokenHash: hashSecret(token),
        status: 'active',
        enrolledAt: iso(now),
        lastSeenAt: iso(now),
      };
      data.nodes.push(node);
      return { token, node: publicNode(node, now, this.onlineWindowMs) };
    });
  }

  async listNodes() {
    const data = await this.store.read();
    const now = this.clock();
    const counts = activeCounts(data.tasks);
    return { nodes: data.nodes.map((node) => publicNode(node, now, this.onlineWindowMs, counts)) };
  }

  revokeNode(nodeId, body = {}) {
    const reason = optionalText(body.reason, 'reason', 1000) || 'Revoked by controller';
    const now = this.clock();
    return this.store.transaction((data) => {
      const node = data.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) throw notFound('Node not found');
      if (node.status === 'revoked') {
        return {
          node: publicNode(node, now, this.onlineWindowMs, activeCounts(data.tasks)),
          affectedTaskIds: [],
          revoked: false,
        };
      }
      node.status = 'revoked';
      node.revokedAt = iso(now);
      node.revokeReason = reason;
      const affectedTaskIds = [];
      for (const task of data.tasks) {
        const assignment = task.assignments.find((candidate) => candidate.nodeId === nodeId);
        if (!assignment || ASSIGNMENT_TERMINAL.has(assignment.status)) continue;
        assignment.status = 'cancelled';
        assignment.cancelReason = reason;
        assignment.completedAt = iso(now);
        affectedTaskIds.push(task.id);
        recomputeTask(task, now);
      }
      return {
        node: publicNode(node, now, this.onlineWindowMs, activeCounts(data.tasks)),
        affectedTaskIds,
        revoked: true,
      };
    });
  }

  heartbeatAgent(agentId, body) {
    const now = this.clock();
    return this.store.transaction((data) => {
      expireTasks(data.tasks, now, this.cancellationGraceMs);
      const node = data.nodes.find((candidate) => candidate.id === agentId);
      if (!node || node.status === 'revoked') throw unauthorized('Agent is not active');
      if (body.status !== undefined) {
        if (!['idle', 'busy'].includes(body.status)) throw badRequest('status must be idle or busy');
        node.agentState = body.status;
      }
      node.lastSeenAt = iso(now);
      return {
        node: publicNode(node, now, this.onlineWindowMs, activeCounts(data.tasks)),
        serverTime: iso(now),
      };
    });
  }

  createTask(body) {
    const prompt = requiredText(body.prompt, 'prompt', 200_000);
    const workspaceId = requiredText(body.workspaceId, 'workspaceId', 200);
    const mode = body.mode ?? 'read-only';
    if (!TASK_MODES.has(mode)) throw badRequest('mode must be read-only or workspace-write');
    const execution = body.execution ?? 'single';
    if (!EXECUTIONS.has(execution)) throw badRequest('execution must be single, parallel, or first_available');
    const idempotencyKey = optionalText(body.idempotencyKey, 'idempotencyKey', 200);
    const ttlSeconds = positiveInteger(body.ttlSeconds, 'ttlSeconds', 3600, { min: 5, max: 604_800 });
    if (body.metadata !== undefined && (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata))) {
      throw badRequest('metadata must be an object');
    }
    const metadata = structuredClone(body.metadata ?? {});
    const now = this.clock();
    return this.store.transaction((data) => {
      expireTasks(data.tasks, now, this.cancellationGraceMs);
      if (idempotencyKey) {
        const existing = data.tasks.find((task) => task.idempotencyKey === idempotencyKey);
        if (existing) return { task: existing, created: false };
      }
      let nodes = selectNodes(data.nodes, body.targets, mode, workspaceId, now, this.onlineWindowMs);
      if (execution === 'single') nodes = nodes.slice(0, 1);
      const task = {
        id: randomUUID(),
        prompt,
        workspaceId,
        mode,
        execution,
        targets: structuredClone(body.targets),
        targetNodeIds: nodes.map((node) => node.id),
        status: 'queued',
        idempotencyKey,
        metadata,
        createdAt: iso(now),
        updatedAt: iso(now),
        expiresAt: iso(now + ttlSeconds * 1000),
        completedAt: null,
        cancelRequestedAt: null,
        winnerNodeId: null,
        assignments: nodes.map((node) => ({
          nodeId: node.id,
          status: 'queued',
          createdAt: iso(now),
          claimedAt: null,
          startedAt: null,
          completedAt: null,
        })),
        events: [],
      };
      data.tasks.push(task);
      return { task, created: true };
    });
  }

  async getTask(taskId) {
    const now = this.clock();
    return this.store.transaction((data) => {
      expireTasks(data.tasks, now, this.cancellationGraceMs);
      const task = data.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw notFound('Task not found');
      return { task };
    });
  }

  async listTasks({ status, limit } = {}) {
    const now = this.clock();
    const wantedLimit = limit === undefined ? 100 : Number(limit);
    if (!Number.isInteger(wantedLimit) || wantedLimit < 1 || wantedLimit > 500) {
      throw badRequest('limit must be an integer between 1 and 500');
    }
    return this.store.transaction((data) => {
      expireTasks(data.tasks, now, this.cancellationGraceMs);
      const tasks = data.tasks
        .filter((task) => !status || task.status === status)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .slice(0, wantedLimit);
      return { tasks };
    });
  }

  cancelTask(taskId, body = {}) {
    const reason = optionalText(body.reason, 'reason', 1000) || 'Cancelled by controller';
    const now = this.clock();
    return this.store.transaction((data) => {
      expireTasks(data.tasks, now, this.cancellationGraceMs);
      const task = data.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw notFound('Task not found');
      if (['succeeded', 'failed', 'cancelled', 'expired'].includes(task.status)) return { task };
      task.cancelRequestedAt = iso(now);
      task.cancelReason = reason;
      for (const assignment of task.assignments) {
        if (assignment.status === 'queued') {
          assignment.status = 'cancelled';
          assignment.cancelReason = reason;
          assignment.completedAt = iso(now);
        } else if (['assigned', 'running'].includes(assignment.status)) {
          assignment.status = 'cancel_requested';
          assignment.cancelReason = reason;
          assignment.cancelRequestedAt = iso(now);
          assignment.cancelDeadlineAt = iso(now + this.cancellationGraceMs);
          assignment.cancelTerminalStatus = 'cancelled';
        }
      }
      recomputeTask(task, now);
      return { task };
    });
  }

  pollAgent(agentId, body = {}) {
    const requestedLimit = body.limit === 0 ? 0 : positiveInteger(body.limit, 'limit', 1, { min: 1, max: 10 });
    const now = this.clock();
    return this.store.transaction((data) => {
      expireTasks(data.tasks, now, this.cancellationGraceMs);
      const node = data.nodes.find((candidate) => candidate.id === agentId);
      if (!node || node.status === 'revoked') throw unauthorized('Agent is not active');
      node.lastSeenAt = iso(now);
      const cancellations = [];
      for (const task of data.tasks) {
        const assignment = task.assignments.find((candidate) => candidate.nodeId === agentId);
        if (assignment?.status === 'cancel_requested') {
          cancellations.push({ taskId: task.id, reason: assignment.cancelReason ?? task.cancelReason ?? 'Cancellation requested' });
        }
      }
      if (requestedLimit === 0) return { tasks: [], cancellations, serverTime: iso(now) };

      const deliveries = [];
      const assignedForRedelivery = data.tasks
        .map((task) => ({ task, assignment: task.assignments.find((candidate) => candidate.nodeId === agentId) }))
        .filter(({ assignment }) => assignment?.status === 'assigned')
        .sort((left, right) => Date.parse(left.assignment.lastDeliveredAt ?? left.assignment.claimedAt)
          - Date.parse(right.assignment.lastDeliveredAt ?? right.assignment.claimedAt));
      for (const { task, assignment } of assignedForRedelivery) {
        if (deliveries.length >= requestedLimit) break;
        assignment.lastDeliveredAt = iso(now);
        deliveries.push(deliveryTask(task, assignment));
      }

      const current = activeCounts(data.tasks).get(agentId) ?? 0;
      const available = Math.max(0, node.maxConcurrent - current);
      const limit = deliveries.length + Math.min(requestedLimit - deliveries.length, available);
      for (const task of data.tasks) {
        if (deliveries.length >= limit) break;
        const assignment = task.assignments.find((candidate) => candidate.nodeId === agentId);
        if (!assignment || assignment.status !== 'queued') continue;
        if (task.execution === 'first_available') {
          if (task.winnerNodeId && task.winnerNodeId !== agentId) {
            assignment.status = 'skipped';
            assignment.completedAt = iso(now);
            recomputeTask(task, now);
            continue;
          }
          task.winnerNodeId = agentId;
          for (const other of task.assignments) {
            if (other.nodeId !== agentId && other.status === 'queued') {
              other.status = 'skipped';
              other.completedAt = iso(now);
            }
          }
        }
        assignment.status = 'assigned';
        assignment.claimedAt = iso(now);
        assignment.lastDeliveredAt = iso(now);
        recomputeTask(task, now);
        deliveries.push(deliveryTask(task, assignment));
      }
      return { tasks: deliveries, cancellations, serverTime: iso(now) };
    });
  }

  startAgentTask(agentId, taskId) {
    const now = this.clock();
    return this.store.transaction((data) => {
      expireTasks(data.tasks, now, this.cancellationGraceMs);
      const task = data.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw notFound('Task not found');
      const assignment = task.assignments.find((candidate) => candidate.nodeId === agentId);
      if (!assignment) throw forbidden('Task is not assigned to this agent');
      if (assignment.status === 'running') return { task };
      if (assignment.status !== 'assigned') throw conflict(`Task cannot start from assignment state ${assignment.status}`);
      assignment.status = 'running';
      assignment.startedAt = iso(now);
      recomputeTask(task, now);
      return { task };
    });
  }

  addAgentEvent(agentId, taskId, body) {
    const now = this.clock();
    const type = optionalText(body.type, 'type', 100) || 'message';
    const message = optionalText(body.message, 'message', 20_000);
    if (message === undefined && body.data === undefined) throw badRequest('event requires message or data');
    return this.store.transaction((data) => {
      const task = data.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw notFound('Task not found');
      const assignment = task.assignments.find((candidate) => candidate.nodeId === agentId);
      if (!assignment) throw forbidden('Task is not assigned to this agent');
      if (!['assigned', 'running', 'cancel_requested'].includes(assignment.status)) {
        throw conflict(`Cannot append an event in assignment state ${assignment.status}`);
      }
      const event = {
        id: randomUUID(),
        nodeId: agentId,
        type,
        message,
        data: body.data === undefined ? undefined : structuredClone(body.data),
        createdAt: iso(now),
      };
      task.events.push(event);
      if (task.events.length > 2000) task.events.splice(0, task.events.length - 2000);
      task.updatedAt = iso(now);
      return { event };
    });
  }

  completeAgentTask(agentId, taskId, body) {
    const status = body.status;
    if (!COMPLETE_STATUSES.has(status)) throw badRequest('status must be succeeded, failed, or cancelled');
    const now = this.clock();
    return this.store.transaction((data) => {
      expireTasks(data.tasks, now, this.cancellationGraceMs);
      const task = data.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw notFound('Task not found');
      const assignment = task.assignments.find((candidate) => candidate.nodeId === agentId);
      if (!assignment) throw forbidden('Task is not assigned to this agent');
      if (ASSIGNMENT_TERMINAL.has(assignment.status)) {
        if (assignment.status === status || assignment.cancelTerminalStatus === assignment.status) return { task };
        throw conflict(`Task assignment is already ${assignment.status}`);
      }
      if (!['assigned', 'running', 'cancel_requested'].includes(assignment.status)) {
        throw conflict(`Task cannot complete from assignment state ${assignment.status}`);
      }
      assignment.status = assignment.status === 'cancel_requested'
        ? (assignment.cancelTerminalStatus ?? 'cancelled')
        : status;
      assignment.result = body.result === undefined ? undefined : structuredClone(body.result);
      assignment.error = body.error === undefined ? undefined : structuredClone(body.error);
      assignment.artifacts = body.artifacts === undefined ? [] : structuredClone(body.artifacts);
      assignment.completedAt = iso(now);
      recomputeTask(task, now);
      return { task };
    });
  }

  addMemory(body) {
    const scope = requiredText(body.scope, 'scope', 200);
    const key = optionalText(body.key, 'key', 200);
    const content = requiredText(body.content, 'content', 100_000);
    const tags = stringArray(body.tags, 'tags', { max: 100 });
    if (body.metadata !== undefined && (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata))) {
      throw badRequest('metadata must be an object');
    }
    const sensitivity = body.sensitivity ?? 'internal';
    if (!['public', 'internal', 'sensitive'].includes(sensitivity)) {
      throw badRequest('sensitivity must be public, internal, or sensitive');
    }
    let expiresAt = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (Number.isNaN(Date.parse(body.expiresAt))) throw badRequest('expiresAt must be an ISO date');
      expiresAt = new Date(body.expiresAt).toISOString();
    }
    const now = this.clock();
    return this.store.transaction((data) => {
      let memory = key ? data.memories.find((candidate) => candidate.scope === scope && candidate.key === key) : null;
      if (memory) {
        Object.assign(memory, { content, tags, metadata: structuredClone(body.metadata ?? {}), sensitivity, expiresAt, updatedAt: iso(now) });
      } else {
        memory = {
          id: randomUUID(),
          scope,
          key,
          content,
          tags,
          metadata: structuredClone(body.metadata ?? {}),
          sensitivity,
          expiresAt,
          createdAt: iso(now),
          updatedAt: iso(now),
        };
        data.memories.push(memory);
      }
      return { memory };
    });
  }

  async searchMemories({ q, scope, limit } = {}) {
    const data = await this.store.read();
    const now = this.clock();
    const query = (q ?? '').trim().toLowerCase();
    const wantedScope = (scope ?? '').trim();
    const wantedLimit = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(wantedLimit) || wantedLimit < 1 || wantedLimit > 500) {
      throw badRequest('limit must be an integer between 1 and 500');
    }
    const memories = data.memories
      .filter((memory) => !memory.expiresAt || Date.parse(memory.expiresAt) > now)
      .filter((memory) => !wantedScope || memory.scope === wantedScope || memory.scope.startsWith(`${wantedScope}/`))
      .filter((memory) => {
        if (!query) return true;
        return [memory.key, memory.content, ...memory.tags].filter(Boolean).some((value) => value.toLowerCase().includes(query));
      })
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, wantedLimit);
    return { memories };
  }
}
