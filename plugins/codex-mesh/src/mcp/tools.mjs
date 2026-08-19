import { HubClientError } from './hub-client.mjs';

const TARGET_SELECTOR_SCHEMA = {
  type: 'object',
  properties: {
    tags: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
    os: {
      oneOf: [
        { type: 'string', minLength: 1 },
        { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, uniqueItems: true },
      ],
    },
    online: { type: 'boolean', default: true },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
  minProperties: 1,
};

const TARGETS_SCHEMA = {
  type: 'object',
  properties: {
    node_ids: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
    },
    selector: TARGET_SELECTOR_SCHEMA,
  },
  additionalProperties: false,
  oneOf: [{ required: ['node_ids'] }, { required: ['selector'] }],
};

const TASK_COMMON_PROPERTIES = {
  prompt: { type: 'string', minLength: 1, maxLength: 100_000 },
  workspace_id: { type: 'string', minLength: 1, maxLength: 256 },
  idempotency_key: { type: 'string', minLength: 1, maxLength: 256 },
  ttl_seconds: { type: 'integer', minimum: 60, maximum: 604_800 },
  metadata: { type: 'object', additionalProperties: true },
};

const OBJECT_OUTPUT_SCHEMA = { type: 'object', additionalProperties: true };

export const TOOLS = Object.freeze([
  {
    name: 'mesh_list_nodes',
    title: '列出 Codex Mesh 节点',
    description: '列出 Hub 已知的电脑节点、在线状态、标签、能力和允许的工作区。分派任务前先调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'mesh_create_pairing',
    title: '创建节点配对码',
    description: '创建一个短期、一次性的节点配对码。配对码应仅交给将要加入的受信任电脑。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 128 },
        expires_in_seconds: { type: 'integer', minimum: 30, maximum: 86_400, default: 600 },
      },
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'mesh_start_readonly_task',
    title: '启动远端只读任务',
    description: '在一个或多个节点上创建只读 Codex 任务；可按节点 ID 或标签选择并支持并行或抢占执行。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TASK_COMMON_PROPERTIES,
        targets: TARGETS_SCHEMA,
        execution: { type: 'string', enum: ['single', 'parallel', 'first_available'], default: 'parallel' },
      },
      required: ['prompt', 'workspace_id', 'targets'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'mesh_start_workspace_task',
    title: '启动远端工作区写任务',
    description: '在一台明确指定的节点上创建可修改工作区的 Codex 任务。远端节点的本地策略和审批始终优先。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TASK_COMMON_PROPERTIES,
        node_id: { type: 'string', minLength: 1, maxLength: 256 },
      },
      required: ['prompt', 'workspace_id', 'node_id'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'mesh_get_task',
    title: '查看远端任务',
    description: '读取一个任务的状态、节点执行进度、结果和等待处理的事项。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', minLength: 1, maxLength: 256 } },
      required: ['task_id'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'mesh_cancel_task',
    title: '取消远端任务',
    description: '请求取消一个排队中或运行中的任务；已完成的外部副作用不会自动回滚。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 256 },
        reason: { type: 'string', minLength: 1, maxLength: 1_000 },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'mesh_search_memory',
    title: '搜索共享记忆',
    description: '按关键词和作用域搜索 Hub 中已审核的共享记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2_000 },
        scope: { type: 'string', minLength: 1, maxLength: 256 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'mesh_add_memory',
    title: '添加共享记忆',
    description: '在用户明确同意后添加稳定、可复用且不含凭据的共享记忆；同一 scope 和 key 已存在时会覆盖原内容。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', minLength: 1, maxLength: 256 },
        key: { type: 'string', minLength: 1, maxLength: 256 },
        content: { type: 'string', minLength: 1, maxLength: 100_000 },
        tags: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 50, uniqueItems: true },
        metadata: { type: 'object', additionalProperties: true },
        sensitivity: { type: 'string', enum: ['public', 'internal', 'sensitive'], default: 'internal' },
        expires_at: { type: 'string', format: 'date-time' },
      },
      required: ['scope', 'content'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
]);

export async function callTool(client, name, rawArguments) {
  try {
    const args = expectObject(rawArguments ?? {}, 'arguments');
    switch (name) {
      case 'mesh_list_nodes':
        rejectUnknown(args, []);
        return success(await client.listNodes());

      case 'mesh_create_pairing': {
        rejectUnknown(args, ['name', 'expires_in_seconds']);
        const nameValue = optionalString(args.name, 'name', 128);
        const expiresInSeconds = optionalInteger(args.expires_in_seconds, 'expires_in_seconds', 30, 86_400);
        return success(await client.createPairing(compact({ name: nameValue, expiresInSeconds })));
      }

      case 'mesh_start_readonly_task': {
        rejectUnknown(args, ['prompt', 'workspace_id', 'targets', 'execution', 'idempotency_key', 'ttl_seconds', 'metadata']);
        const prompt = requiredString(args.prompt, 'prompt', 100_000);
        const workspaceId = requiredString(args.workspace_id, 'workspace_id', 256);
        const targets = normalizeTargets(args.targets);
        const execution = optionalEnum(args.execution, 'execution', ['single', 'parallel', 'first_available']) ?? 'parallel';
        const input = normalizeTaskCommon(args, { prompt, workspaceId, targets, execution, mode: 'read-only' });
        return success(await client.startTask(input));
      }

      case 'mesh_start_workspace_task': {
        rejectUnknown(args, ['prompt', 'workspace_id', 'node_id', 'idempotency_key', 'ttl_seconds', 'metadata']);
        const prompt = requiredString(args.prompt, 'prompt', 100_000);
        const workspaceId = requiredString(args.workspace_id, 'workspace_id', 256);
        const nodeId = requiredString(args.node_id, 'node_id', 256);
        const input = normalizeTaskCommon(args, {
          prompt,
          workspaceId,
          targets: { nodeIds: [nodeId] },
          execution: 'single',
          mode: 'workspace-write',
        });
        return success(await client.startTask(input));
      }

      case 'mesh_get_task':
        rejectUnknown(args, ['task_id']);
        return success(await client.getTask(requiredString(args.task_id, 'task_id', 256)));

      case 'mesh_cancel_task': {
        rejectUnknown(args, ['task_id', 'reason']);
        const taskId = requiredString(args.task_id, 'task_id', 256);
        const reason = optionalString(args.reason, 'reason', 1_000);
        return success(await client.cancelTask(taskId, compact({ reason })));
      }

      case 'mesh_search_memory': {
        rejectUnknown(args, ['query', 'scope', 'limit']);
        const q = requiredString(args.query, 'query', 2_000);
        const scope = optionalString(args.scope, 'scope', 256);
        const limit = optionalInteger(args.limit, 'limit', 1, 100) ?? 20;
        return success(await client.searchMemories(compact({ q, scope, limit })));
      }

      case 'mesh_add_memory': {
        rejectUnknown(args, ['scope', 'key', 'content', 'tags', 'metadata', 'sensitivity', 'expires_at']);
        const scope = requiredString(args.scope, 'scope', 256);
        const key = optionalString(args.key, 'key', 256);
        const content = requiredString(args.content, 'content', 100_000);
        const tags = optionalStringArray(args.tags, 'tags', 50);
        const metadata = optionalObject(args.metadata, 'metadata');
        const sensitivity = optionalEnum(args.sensitivity, 'sensitivity', ['public', 'internal', 'sensitive']);
        const expiresAt = optionalDateTime(args.expires_at, 'expires_at');
        return success(await client.addMemory(compact({ scope, key, content, tags, metadata, sensitivity, expiresAt })));
      }

      default:
        throw new ToolInputError('unknown_tool', 'Unknown Codex Mesh tool');
    }
  } catch (error) {
    if (error instanceof ToolInputError || error instanceof HubClientError) return failure(error);
    return failure(new ToolExecutionError('tool_failed', 'Codex Mesh tool execution failed'));
  }
}

class ToolInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolInputError';
    this.code = code;
  }
}

class ToolExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolExecutionError';
    this.code = code;
  }
}

function success(value) {
  return {
    structuredContent: value,
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function failure(error) {
  const structuredContent = {
    error: {
      code: safeCode(error.code),
      message: safeMessage(error),
      ...(Number.isInteger(error.status) ? { status: error.status } : {}),
      ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
    },
  };
  return {
    isError: true,
    structuredContent,
    content: [{ type: 'text', text: structuredContent.error.message }],
  };
}

function safeCode(value) {
  const candidate = String(value ?? 'tool_failed').toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate) ? candidate : 'tool_failed';
}

function safeMessage(error) {
  if (error instanceof ToolInputError || error instanceof ToolExecutionError || error instanceof HubClientError) {
    return error.message;
  }
  return 'Codex Mesh tool execution failed';
}

function normalizeTaskCommon(args, base) {
  const idempotencyKey = optionalString(args.idempotency_key, 'idempotency_key', 256);
  const ttlSeconds = optionalInteger(args.ttl_seconds, 'ttl_seconds', 60, 604_800);
  const metadata = optionalObject(args.metadata, 'metadata');
  return compact({ ...base, idempotencyKey, ttlSeconds, metadata });
}

function normalizeTargets(value) {
  const targets = expectObject(value, 'targets');
  rejectUnknown(targets, ['node_ids', 'selector']);
  const nodeIds = optionalStringArray(targets.node_ids, 'targets.node_ids', 100);
  let selector;
  if (targets.selector !== undefined) {
    const raw = expectObject(targets.selector, 'targets.selector');
    rejectUnknown(raw, ['tags', 'os', 'online', 'limit']);
    const tags = optionalStringArray(raw.tags, 'targets.selector.tags', 100);
    const os = normalizeOs(raw.os);
    const online = optionalBoolean(raw.online, 'targets.selector.online');
    const limit = optionalInteger(raw.limit, 'targets.selector.limit', 1, 100);
    selector = compact({ tags, os, online, limit });
    if (Object.keys(selector).length === 0) invalid('targets.selector', 'must not be empty');
  }
  if (Boolean(nodeIds) === Boolean(selector)) invalid('targets', 'must include exactly one of node_ids or selector');
  return compact({ nodeIds, selector });
}

function normalizeOs(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return requiredString(value, 'targets.selector.os', 128);
  return optionalStringArray(value, 'targets.selector.os', 20);
}

function expectObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field, 'must be an object');
  return value;
}

function optionalObject(value, field) {
  return value === undefined ? undefined : expectObject(value, field);
}

function requiredString(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    invalid(field, `must be a non-empty string no longer than ${maxLength} characters`);
  }
  return value;
}

function optionalString(value, field, maxLength) {
  return value === undefined ? undefined : requiredString(value, field, maxLength);
}

function optionalStringArray(value, field, maxItems) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    invalid(field, `must contain between 1 and ${maxItems} strings`);
  }
  const normalized = value.map((item, index) => requiredString(item, `${field}[${index}]`, 256));
  if (new Set(normalized).size !== normalized.length) invalid(field, 'must not contain duplicates');
  return normalized;
}

function optionalInteger(value, field, minimum, maximum) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    invalid(field, `must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalBoolean(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') invalid(field, 'must be a boolean');
  return value;
}

function optionalEnum(value, field, choices) {
  if (value === undefined) return undefined;
  if (!choices.includes(value)) invalid(field, `must be one of: ${choices.join(', ')}`);
  return value;
}

function optionalDateTime(value, field) {
  if (value === undefined) return undefined;
  requiredString(value, field, 64);
  if (Number.isNaN(Date.parse(value))) invalid(field, 'must be an ISO 8601 date-time');
  return value;
}

function rejectUnknown(value, allowed) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) invalid('arguments', 'contains an unsupported property');
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function invalid(field, requirement) {
  throw new ToolInputError('invalid_arguments', `${field} ${requirement}`);
}
