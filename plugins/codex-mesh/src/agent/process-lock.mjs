import { open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readLock(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

export async function acquireAgentLock(configPath, { pid = process.pid } = {}) {
  const lockPath = `${configPath}.lock`;
  const nonce = randomUUID();
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readLock(lockPath);
    if (!existing) {
      throw new Error(`Agent lock ${lockPath} exists but is unreadable; verify no agent is running before removing it`);
    }
    if (existing && processIsAlive(existing.pid)) {
      throw new Error(`Another mesh-agent process is already using this config (PID ${existing.pid})`);
    }
    await unlink(lockPath).catch((unlinkError) => {
      if (unlinkError?.code !== 'ENOENT') throw unlinkError;
    });
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (retryError) {
      if (retryError?.code === 'EEXIST') {
        throw new Error('Another mesh-agent process acquired the config lock');
      }
      throw retryError;
    }
  }

  try {
    await handle.writeFile(`${JSON.stringify({ pid, nonce, startedAt: new Date().toISOString() })}\n`, 'utf8');
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
    throw error;
  }
  let released = false;
  return {
    lockPath,
    async release() {
      if (released) return;
      released = true;
      await handle.close();
      const current = await readLock(lockPath);
      if (current?.nonce === nonce) {
        await unlink(lockPath).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      }
    },
  };
}
