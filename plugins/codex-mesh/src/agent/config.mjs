import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeHubUrl } from './api-client.mjs';

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ALLOWED_MODES = new Set(['read-only', 'workspace-write']);

export function defaultAgentConfigPath(env = process.env, platform = process.platform) {
  if (env.CODEX_MESH_AGENT_CONFIG) return path.resolve(env.CODEX_MESH_AGENT_CONFIG);
  if (platform === 'win32') {
    const base = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'codex-mesh', 'agent.json');
  }
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'codex-mesh', 'agent.json');
}

export function parseWorkspaceSpec(spec) {
  if (typeof spec !== 'string') throw new TypeError('Workspace must be written as id=path');
  const separator = spec.indexOf('=');
  if (separator < 1 || separator === spec.length - 1) {
    throw new TypeError(`Invalid workspace "${spec}"; expected id=path`);
  }
  const id = spec.slice(0, separator).trim();
  const workspacePath = spec.slice(separator + 1).trim();
  if (!WORKSPACE_ID_PATTERN.test(id) || id.includes('..')) {
    throw new TypeError(`Invalid workspace id "${id}"`);
  }
  if (!workspacePath) throw new TypeError(`Workspace "${id}" has an empty path`);
  return { id, path: workspacePath };
}

export function parseTags(values = []) {
  const tags = values
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(tags)];
}

export async function prepareWorkspaces(specs, { defaultMode = 'workspace-write' } = {}) {
  if (!ALLOWED_MODES.has(defaultMode)) throw new TypeError(`Unsupported workspace mode: ${defaultMode}`);
  const seen = new Set();
  const prepared = [];
  for (const input of specs) {
    const workspace = typeof input === 'string' ? parseWorkspaceSpec(input) : input;
    if (!workspace || !WORKSPACE_ID_PATTERN.test(workspace.id) || workspace.id.includes('..')) {
      throw new TypeError(`Invalid workspace id "${workspace?.id ?? ''}"`);
    }
    if (seen.has(workspace.id)) throw new TypeError(`Duplicate workspace id "${workspace.id}"`);
    seen.add(workspace.id);

    const requestedPath = path.resolve(workspace.path);
    await access(requestedPath, fsConstants.R_OK);
    const info = await stat(requestedPath);
    if (!info.isDirectory()) throw new TypeError(`Workspace "${workspace.id}" is not a directory`);
    const canonicalPath = await realpath(requestedPath);
    const mode = workspace.mode ?? defaultMode;
    if (!ALLOWED_MODES.has(mode)) throw new TypeError(`Unsupported workspace mode: ${mode}`);
    prepared.push({ id: workspace.id, path: requestedPath, realPath: canonicalPath, mode });
  }
  if (prepared.length === 0) throw new TypeError('At least one --workspace id=path is required');
  return prepared;
}

export async function saveAgentConfig(filePath, config) {
  const absolutePath = path.resolve(filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporaryPath, absolutePath);
  if (process.platform !== 'win32') await chmod(absolutePath, 0o600);
  return absolutePath;
}

export function validateAgentConfig(config) {
  if (!config || config.version !== 1) throw new TypeError('Unsupported or missing agent config version');
  config.hubUrl = normalizeHubUrl(config.hubUrl);
  if (typeof config.nodeId !== 'string' || !config.nodeId) throw new TypeError('Config is missing nodeId');
  if (typeof config.token !== 'string' || !config.token) throw new TypeError('Config is missing token');
  if (config.codexCommand !== undefined && (typeof config.codexCommand !== 'string' || !config.codexCommand)) {
    throw new TypeError('codexCommand must be a non-empty string');
  }
  if (config.tags !== undefined && (!Array.isArray(config.tags) || config.tags.some((tag) => typeof tag !== 'string'))) {
    throw new TypeError('tags must be an array of strings');
  }
  if (config.passEnv === undefined) config.passEnv = [];
  if (
    !Array.isArray(config.passEnv)
    || config.passEnv.length > 64
    || config.passEnv.some((name) => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  ) {
    throw new TypeError('passEnv must be an array of at most 64 environment variable names');
  }
  const normalizedPassEnv = new Set();
  for (const name of config.passEnv) {
    const normalized = name.toUpperCase();
    if (normalized.startsWith('CODEX_MESH_')) {
      throw new TypeError('passEnv can never include CODEX_MESH_* variables');
    }
    normalizedPassEnv.add(name);
  }
  config.passEnv = [...normalizedPassEnv];
  if (!Array.isArray(config.workspaces) || config.workspaces.length === 0) {
    throw new TypeError('Config must contain at least one workspace');
  }
  const ids = new Set();
  for (const workspace of config.workspaces) {
    if (!workspace || !WORKSPACE_ID_PATTERN.test(workspace.id) || workspace.id.includes('..')) {
      throw new TypeError(`Invalid workspace id "${workspace?.id ?? ''}" in config`);
    }
    if (ids.has(workspace.id)) throw new TypeError(`Duplicate workspace id "${workspace.id}" in config`);
    ids.add(workspace.id);
    if (typeof workspace.path !== 'string' || typeof workspace.realPath !== 'string') {
      throw new TypeError(`Workspace "${workspace.id}" must have path and realPath`);
    }
    if (!ALLOWED_MODES.has(workspace.mode ?? 'workspace-write')) {
      throw new TypeError(`Workspace "${workspace.id}" has an unsupported mode`);
    }
  }
  return config;
}

export async function loadAgentConfig(filePath) {
  const absolutePath = path.resolve(filePath);
  const raw = await readFile(absolutePath, 'utf8');
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(`Could not parse agent config ${absolutePath}: ${error.message}`);
  }
  return validateAgentConfig(config);
}

export { ALLOWED_MODES };
