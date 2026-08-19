#!/usr/bin/env node

import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HubClient } from './api-client.mjs';
import {
  defaultAgentConfigPath,
  loadAgentConfig,
  parseTags,
  prepareWorkspaces,
  saveAgentConfig,
} from './config.mjs';
import { AgentRunner } from './runner.mjs';
import { acquireAgentLock } from './process-lock.mjs';

const HELP = `mesh-agent

Usage:
  mesh-agent enroll --hub URL --pairing-code CODE --name NAME \\
    --workspace ID=PATH [--workspace ID=PATH ...] [--tags TAGS]
  mesh-agent run [--config PATH]

Enroll options:
  --hub URL                 Hub base URL (required)
  --pairing-code CODE       One-time pairing code (required)
  --name NAME               Node display name (default: hostname)
  --tags TAG[,TAG]          Repeatable node tags
  --workspace ID=PATH       Repeatable local workspace mapping (required)
  --workspace-mode MODE     read-only or workspace-write (default)
  --codex PATH              Local Codex executable (default: codex)
  --pass-env NAME           Explicitly pass one environment variable to Codex
  --config PATH             Agent config destination
  --force                   Replace an existing config

The node token is written only to the local config. Local workspace paths are
never sent to the hub.
`;

export function parseAgentArguments(argv) {
  const positionals = [];
  const options = new Map();
  const booleanOptions = new Set(['help', 'force']);
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
    } else if (booleanOptions.has(name)) {
      value = true;
    } else {
      index += 1;
      value = argv[index];
      if (value === undefined || value.startsWith('--')) throw new TypeError(`--${name} requires a value`);
    }
    options.set(name, [...(options.get(name) ?? []), value]);
  }
  return {
    command: positionals[0],
    positionals: positionals.slice(1),
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

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function enroll(parsed, env) {
  const hubUrl = parsed.one('hub', env.CODEX_MESH_HUB_URL);
  const pairingCode = parsed.one('pairing-code', env.CODEX_MESH_PAIRING_CODE);
  const name = parsed.one('name', os.hostname());
  const workspaceSpecs = parsed.many('workspace');
  const workspaceMode = parsed.one('workspace-mode', 'workspace-write');
  const configPath = path.resolve(parsed.one('config', defaultAgentConfigPath(env)));

  if (!hubUrl) throw new TypeError('--hub is required');
  if (!pairingCode) throw new TypeError('--pairing-code is required');
  if (await pathExists(configPath) && !parsed.has('force')) {
    throw new Error(`Config already exists at ${configPath}; use --force to replace it`);
  }

  const workspaces = await prepareWorkspaces(workspaceSpecs, { defaultMode: workspaceMode });
  const tags = parseTags(parsed.many('tags'));
  const passEnv = [...new Set(parsed.many('pass-env'))];
  for (const name of passEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`Invalid --pass-env name "${name}"`);
    if (name.toUpperCase().startsWith('CODEX_MESH_')) {
      throw new TypeError('CODEX_MESH_* variables can never be passed to Codex');
    }
  }
  const client = new HubClient({ hubUrl });
  const response = await client.enroll({
    pairingCode,
    name,
    os: process.platform,
    tags,
    capabilities: ['codex-exec'],
    workspaces: workspaces.map(({ id, mode }) => ({ id, mode })),
    maxConcurrent: 1,
  });
  const nodeId = response.node?.id ?? response.nodeId;
  if (!nodeId || typeof response.token !== 'string' || !response.token) {
    throw new Error('Hub enrollment response did not contain node.id and token');
  }

  const config = {
    version: 1,
    hubUrl,
    nodeId,
    token: response.token,
    name,
    os: process.platform,
    tags,
    capabilities: ['codex-exec'],
    maxConcurrent: 1,
    codexCommand: parsed.one('codex', 'codex'),
    passEnv,
    pollIntervalMs: 2_000,
    heartbeatIntervalMs: 30_000,
    workspaces,
  };
  await saveAgentConfig(configPath, config);
  process.stdout.write(`${JSON.stringify({ enrolled: true, nodeId, configPath }, null, 2)}\n`);
}

async function runAgent(parsed, env) {
  const configPath = path.resolve(parsed.one('config', defaultAgentConfigPath(env)));
  const config = await loadAgentConfig(configPath);
  const lock = await acquireAgentLock(configPath);
  try {
    const client = new HubClient({ hubUrl: config.hubUrl, token: config.token });
    const runner = new AgentRunner({ config, client });
    const controller = new AbortController();
    const stop = () => {
      runner.requestStop();
      controller.abort();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdout.write(`[codex-mesh] node ${config.nodeId} is polling ${config.hubUrl}\n`);
    try {
      await runner.run({ signal: controller.signal });
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } finally {
    await lock.release();
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseAgentArguments(argv);
  if (parsed.has('help') || !parsed.command) {
    process.stdout.write(HELP);
    return;
  }
  if (parsed.positionals.length) throw new TypeError(`Unexpected argument: ${parsed.positionals[0]}`);
  if (parsed.command === 'enroll') return enroll(parsed, env);
  if (parsed.command === 'run') return runAgent(parsed, env);
  throw new TypeError(`Unknown command "${parsed.command}"`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`mesh-agent: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
