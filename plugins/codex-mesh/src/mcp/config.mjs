import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 30_000;

export class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

export function resolveConfigPath({ argv = process.argv.slice(2), env = process.env, home = homedir() } = {}) {
  let cliPath;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--stdio') continue;
    if (argument === '--config') {
      cliPath = argv[index + 1];
      if (!cliPath || cliPath.startsWith('--')) {
        throw new ConfigError('invalid_config_argument', '--config requires a file path');
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('--config=')) {
      cliPath = argument.slice('--config='.length);
      if (!cliPath) throw new ConfigError('invalid_config_argument', '--config requires a file path');
      continue;
    }
    throw new ConfigError('unknown_argument', 'An unsupported command-line argument was provided');
  }

  return cliPath || env.CODEX_MESH_CONFIG || join(home, '.codex-mesh', 'controller.json');
}

export async function loadControllerConfig(options = {}) {
  const path = resolveConfigPath(options);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new ConfigError('config_unreadable', 'Controller configuration could not be read');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('config_invalid_json', 'Controller configuration is not valid JSON');
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigError('config_invalid', 'Controller configuration must be a JSON object');
  }

  const hubUrl = normalizeHubUrl(parsed.hubUrl);
  const controllerToken = parsed.controllerToken;
  if (typeof controllerToken !== 'string' || controllerToken.trim().length < 16) {
    throw new ConfigError('config_invalid_token', 'controllerToken is missing or invalid');
  }

  const requestTimeoutMs = parsed.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 300_000) {
    throw new ConfigError('config_invalid_timeout', 'requestTimeoutMs must be between 1000 and 300000');
  }

  return Object.freeze({ path, hubUrl, controllerToken, requestTimeoutMs });
}

function normalizeHubUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError('config_invalid_hub_url', 'hubUrl is missing or invalid');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('config_invalid_hub_url', 'hubUrl is missing or invalid');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ConfigError('config_invalid_hub_url', 'hubUrl must be an HTTP(S) URL without embedded credentials');
  }

  return url.toString().replace(/\/$/, '');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
