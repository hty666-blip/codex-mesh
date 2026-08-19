import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AtomicJsonStore, emptyStore } from './store.mjs';
import { hashSecret, randomToken } from '../shared/security.mjs';
import { conflict } from '../shared/errors.mjs';

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function defaultControllerConfigPath() {
  return join(homedir(), '.codex-mesh', 'controller.json');
}

export async function initializeHubData({
  dataDir = 'data',
  controllerConfigPath = defaultControllerConfigPath(),
  force = false,
  replaceControllerConfig = false,
  hubUrl = 'http://127.0.0.1:7337',
} = {}) {
  const directory = resolve(dataDir);
  const storePath = join(directory, 'hub.json');
  const resolvedControllerConfigPath = resolve(controllerConfigPath);
  await mkdir(directory, { recursive: true });
  await mkdir(dirname(resolvedControllerConfigPath), { recursive: true, mode: 0o700 });
  if (!force && await fileExists(storePath)) {
    throw conflict(`Hub data already exists in ${directory}; use --force only if replacement is intentional`);
  }
  if (!replaceControllerConfig && await fileExists(resolvedControllerConfigPath)) {
    throw conflict(`Controller config already exists: ${resolvedControllerConfigPath}; choose another --controller-config path`);
  }
  const controllerToken = randomToken('cmcontroller', 32);
  const config = {
    version: 1,
    hubUrl,
    controllerToken,
    createdAt: new Date().toISOString(),
  };
  const temporaryConfigPath = `${resolvedControllerConfigPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryConfigPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await AtomicJsonStore.create(storePath, emptyStore(hashSecret(controllerToken)), { overwrite: force });
    await rename(temporaryConfigPath, resolvedControllerConfigPath);
    if (process.platform !== 'win32') await chmod(resolvedControllerConfigPath, 0o600);
  } catch (error) {
    await rm(temporaryConfigPath, { force: true }).catch(() => {});
    throw error;
  }
  return { directory, storePath, controllerConfigPath: resolvedControllerConfigPath, controllerToken, hubUrl };
}

export async function rotateControllerToken({ dataDir = 'data', controllerConfigPath = defaultControllerConfigPath() } = {}) {
  const storePath = join(resolve(dataDir), 'hub.json');
  const resolvedControllerConfigPath = resolve(controllerConfigPath);
  let config;
  try {
    config = JSON.parse(await readFile(resolvedControllerConfigPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read controller config ${resolvedControllerConfigPath}: ${error.message}`);
  }
  if (!config || config.version !== 1 || typeof config.hubUrl !== 'string') {
    throw new Error(`Controller config is invalid: ${resolvedControllerConfigPath}`);
  }
  const controllerToken = randomToken('cmcontroller', 32);
  const rotatedAt = new Date().toISOString();
  const nextConfig = { ...config, controllerToken, rotatedAt };
  delete nextConfig.token;
  const temporaryConfigPath = `${resolvedControllerConfigPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });

  const store = await AtomicJsonStore.open(storePath);
  try {
    await store.transaction((data) => {
      data.controllerTokenHash = hashSecret(controllerToken);
      data.controllerTokenRotatedAt = rotatedAt;
    });
  } catch (error) {
    await rm(temporaryConfigPath, { force: true }).catch(() => {});
    throw error;
  }
  try {
    await rename(temporaryConfigPath, resolvedControllerConfigPath);
    if (process.platform !== 'win32') await chmod(resolvedControllerConfigPath, 0o600);
  } catch (error) {
    throw new Error(`Controller token was rotated, but config replacement failed. Recover the new token from ${temporaryConfigPath}: ${error.message}`);
  }
  return { storePath, controllerConfigPath: resolvedControllerConfigPath, controllerToken, hubUrl: nextConfig.hubUrl, rotatedAt };
}
