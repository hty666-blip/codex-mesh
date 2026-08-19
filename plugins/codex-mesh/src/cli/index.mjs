#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ControllerClient } from './api-client.mjs';
import {
  defaultControllerConfigPath,
  fileExists,
  loadControllerConfig,
  saveControllerConfig,
  validateControllerConfig,
} from './config.mjs';

const HELP = `meshctl - control a Codex Mesh hub

Usage:
  meshctl config init --hub URL --token TOKEN [--config PATH]
  meshctl pair [--name NAME] [--expires-in SECONDS]
  meshctl nodes
  meshctl node revoke NODE_ID [--reason TEXT]
  meshctl submit --workspace ID --mode MODE [--node ID ... | --tag TAG ...] \\
    [--execution single|parallel|first_available] --prompt TEXT
  meshctl task [TASK_ID]
  meshctl cancel TASK_ID [--reason TEXT]
  meshctl memory add --scope SCOPE --content TEXT [--key KEY] [--tag TAG ...]
  meshctl memory search [QUERY] [--scope SCOPE] [--limit N]

Global options:
  --config PATH     Controller config path
  --json            Emit JSON (all command output is JSON in v0.1)
  --help            Show this help
`;

const BOOLEAN_OPTIONS = new Set(['help', 'force', 'json', 'online']);

export function parseCliArguments(argv) {
  const positionals = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === '-h' || token === '--help') {
      options.set('help', [true]);
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const equalsAt = token.indexOf('=');
    const name = token.slice(2, equalsAt < 0 ? undefined : equalsAt);
    if (!name) throw new TypeError(`Invalid option "${token}"`);
    let value;
    if (equalsAt >= 0) {
      value = token.slice(equalsAt + 1);
    } else if (BOOLEAN_OPTIONS.has(name)) {
      value = true;
    } else {
      index += 1;
      value = argv[index];
      if (value === undefined || value.startsWith('--')) throw new TypeError(`--${name} requires a value`);
    }
    options.set(name, [...(options.get(name) ?? []), value]);
  }
  return {
    positionals,
    options,
    one(name, fallback) {
      const values = options.get(name);
      return values?.[values.length - 1] ?? fallback;
    },
    many(name) {
      return options.get(name) ?? [];
    },
    has(name) {
      return options.has(name);
    },
  };
}

function parsePositiveInteger(value, name, { optional = true } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return undefined;
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new TypeError(`--${name} must be a positive integer`);
  }
  return Number(value);
}

function parseJsonObject(value, name) {
  if (value === undefined) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new TypeError(`--${name} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`--${name} must be a JSON object`);
  }
  return parsed;
}

function valuesAsTags(values) {
  return [...new Set(values.flatMap((value) => String(value).split(',')).map((tag) => tag.trim()).filter(Boolean))];
}

function output(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function initConfig(parsed, env) {
  const configPath = path.resolve(parsed.one('config', defaultControllerConfigPath(env)));
  const hubUrl = parsed.one('hub', env.CODEX_MESH_HUB_URL);
  const token = parsed.one('token', env.CODEX_MESH_CONTROLLER_TOKEN || env.CODEX_MESH_TOKEN);
  if (!hubUrl) throw new TypeError('--hub is required');
  if (!token) throw new TypeError('--token is required (or set CODEX_MESH_CONTROLLER_TOKEN)');
  if (await fileExists(configPath) && !parsed.has('force')) {
    throw new Error(`Config already exists at ${configPath}; use --force to replace it`);
  }
  const config = validateControllerConfig({ version: 1, hubUrl, controllerToken: token });
  await saveControllerConfig(configPath, {
    version: 1,
    hubUrl: config.hubUrl,
    controllerToken: config.controllerToken,
  });
  output({ initialized: true, configPath, hubUrl: config.hubUrl });
}

function taskTarget(parsed) {
  const nodeIds = parsed.many('node');
  const tags = valuesAsTags([...parsed.many('tag'), ...parsed.many('tags')]);
  const selectorUsed = tags.length || parsed.has('os') || parsed.has('online') || parsed.has('limit');
  if (nodeIds.length && selectorUsed) {
    throw new TypeError('Use either --node or selector options (--tag/--os/--online/--limit), not both');
  }
  if (nodeIds.length) return { nodeIds: [...new Set(nodeIds)] };
  if (selectorUsed) {
    return {
      selector: {
        ...(tags.length ? { tags } : {}),
        ...(parsed.has('os') ? { os: parsed.one('os') } : {}),
        ...(parsed.has('online') ? { online: true } : {}),
        ...(parsed.has('limit') ? { limit: parsePositiveInteger(parsed.one('limit'), 'limit') } : {}),
      },
    };
  }
  return undefined;
}

async function dispatch(parsed, client) {
  const [command, subcommand, ...rest] = parsed.positionals;
  if (command === 'pair') {
    return client.createPairing({
      ...(parsed.has('name') ? { name: parsed.one('name') } : {}),
      ...(parsed.has('expires-in')
        ? { expiresInSeconds: parsePositiveInteger(parsed.one('expires-in'), 'expires-in') }
        : {}),
    });
  }
  if (command === 'nodes') {
    return client.listNodes();
  }
  if (command === 'node' && subcommand === 'revoke') {
    const [nodeId, ...extra] = rest;
    if (!nodeId) throw new TypeError('node revoke requires NODE_ID');
    if (extra.length) throw new TypeError(`Unexpected argument: ${extra[0]}`);
    return client.revokeNode(nodeId, parsed.has('reason') ? { reason: parsed.one('reason') } : {});
  }
  if (command === 'submit') {
    const prompt = parsed.one('prompt', [subcommand, ...rest].filter(Boolean).join(' '));
    if (!prompt) throw new TypeError('--prompt is required (or provide the prompt after submit)');
    const workspaceId = parsed.one('workspace');
    if (!workspaceId) throw new TypeError('--workspace is required for every task');
    const mode = parsed.one('mode', 'read-only');
    if (!['read-only', 'workspace-write'].includes(mode)) throw new TypeError('Invalid --mode');
    const execution = parsed.one('execution', 'single');
    if (!['single', 'parallel', 'first_available'].includes(execution)) throw new TypeError('Invalid --execution');
    const targets = taskTarget(parsed);
    if (!targets) throw new TypeError('Choose at least one target with --node, --tag, --os, or --online');
    return client.submitTask({
      prompt,
      workspaceId,
      mode,
      execution,
      targets,
      ...(parsed.has('idempotency-key') ? { idempotencyKey: parsed.one('idempotency-key') } : {}),
      ...(parsed.has('ttl') ? { ttlSeconds: parsePositiveInteger(parsed.one('ttl'), 'ttl') } : {}),
      ...(parsed.has('metadata') ? { metadata: parseJsonObject(parsed.one('metadata'), 'metadata') } : {}),
    });
  }
  if (command === 'task') {
    if (subcommand) {
      if (rest.length) throw new TypeError(`Unexpected argument: ${rest[0]}`);
      return client.getTask(subcommand);
    }
    return client.listTasks({
      status: parsed.one('status'),
      limit: parsed.has('limit') ? parsePositiveInteger(parsed.one('limit'), 'limit') : undefined,
    });
  }
  if (command === 'cancel') {
    if (!subcommand) throw new TypeError('cancel requires TASK_ID');
    if (rest.length) throw new TypeError(`Unexpected argument: ${rest[0]}`);
    return client.cancelTask(subcommand, parsed.has('reason') ? { reason: parsed.one('reason') } : {});
  }
  if (command === 'memory' && subcommand === 'add') {
    const content = parsed.one('content', rest.join(' '));
    const scope = parsed.one('scope');
    if (!scope) throw new TypeError('--scope is required');
    if (!content) throw new TypeError('--content is required (or provide content after "memory add")');
    const tags = valuesAsTags([...parsed.many('tag'), ...parsed.many('tags')]);
    return client.addMemory({
      scope,
      content,
      ...(parsed.has('key') ? { key: parsed.one('key') } : {}),
      ...(tags.length ? { tags } : {}),
      ...(parsed.has('metadata') ? { metadata: parseJsonObject(parsed.one('metadata'), 'metadata') } : {}),
      ...(parsed.has('sensitivity') ? { sensitivity: parsed.one('sensitivity') } : {}),
      ...(parsed.has('expires-at') ? { expiresAt: parsed.one('expires-at') } : {}),
    });
  }
  if (command === 'memory' && subcommand === 'search') {
    return client.searchMemories({
      q: parsed.one('query', rest.join(' ')),
      scope: parsed.one('scope'),
      limit: parsed.has('limit') ? parsePositiveInteger(parsed.one('limit'), 'limit') : undefined,
    });
  }
  throw new TypeError(`Unknown command${command ? ` "${[command, subcommand].filter(Boolean).join(' ')}"` : ''}`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseCliArguments(argv);
  if (parsed.has('help') || parsed.positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }
  if (parsed.positionals[0] === 'config' && parsed.positionals[1] === 'init') {
    if (parsed.positionals.length > 2) throw new TypeError(`Unexpected argument: ${parsed.positionals[2]}`);
    return initConfig(parsed, env);
  }
  const configPath = path.resolve(parsed.one('config', defaultControllerConfigPath(env)));
  const config = await loadControllerConfig(configPath, env);
  const client = new ControllerClient({ hubUrl: config.hubUrl, token: config.token });
  output(await dispatch(parsed, client));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`meshctl: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
