import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireAgentLock } from '../src/agent/process-lock.mjs';

test('only one agent process can use a config and the lock is released cleanly', async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-mesh-agent-lock-'));
  context.after(async () => {
    assert.equal(path.dirname(temporaryRoot), os.tmpdir());
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const configPath = path.join(temporaryRoot, 'agent.json');
  const first = await acquireAgentLock(configPath);
  await assert.rejects(acquireAgentLock(configPath), /already using this config/);
  await first.release();
  const second = await acquireAgentLock(configPath);
  await second.release();
});
