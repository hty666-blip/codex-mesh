import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { normalizeHubUrl } from '../agent/api-client.mjs';

export function defaultControllerConfigPath(env = process.env) {
  if (env.CODEX_MESH_CONTROLLER_CONFIG) return path.resolve(env.CODEX_MESH_CONTROLLER_CONFIG);
  return path.join(os.homedir(), '.codex-mesh', 'controller.json');
}

export async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function saveControllerConfig(filePath, config) {
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

export function validateControllerConfig(config) {
  if (!config || config.version !== 1) throw new TypeError('Unsupported or missing controller config version');
  config.hubUrl = normalizeHubUrl(config.hubUrl);
  const token = config.controllerToken ?? config.token;
  if (typeof token !== 'string' || !token) throw new TypeError('Controller config is missing controllerToken');
  return { ...config, controllerToken: token, token };
}

export async function loadControllerConfig(filePath, env = process.env) {
  const absolutePath = path.resolve(filePath);
  const raw = await readFile(absolutePath, 'utf8');
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(`Could not parse controller config ${absolutePath}: ${error.message}`);
  }
  if (env.CODEX_MESH_HUB_URL) config.hubUrl = env.CODEX_MESH_HUB_URL;
  if (env.CODEX_MESH_CONTROLLER_TOKEN || env.CODEX_MESH_TOKEN) {
    config.controllerToken = env.CODEX_MESH_CONTROLLER_TOKEN || env.CODEX_MESH_TOKEN;
  }
  return validateControllerConfig(config);
}
