import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { conflict } from '../shared/errors.mjs';

export const STORE_VERSION = 1;

export function emptyStore(controllerTokenHash) {
  return {
    version: STORE_VERSION,
    controllerTokenHash,
    createdAt: new Date().toISOString(),
    pairings: [],
    nodes: [],
    tasks: [],
    memories: [],
  };
}

async function durableWrite(filePath, value) {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const handle = await open(temporary, 'r');
    try {
      try {
        await handle.sync();
      } catch (error) {
        // Some Windows filesystems and sandboxed volumes reject fsync even for a
        // regular file. The same-directory rename below still prevents readers
        // from observing a partially written JSON document.
        if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
      }
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function validateStore(data) {
  if (!data || typeof data !== 'object' || data.version !== STORE_VERSION) {
    throw new Error(`Unsupported or invalid Codex Mesh store (expected version ${STORE_VERSION})`);
  }
  if (typeof data.controllerTokenHash !== 'string') {
    throw new Error('Codex Mesh store is missing controllerTokenHash');
  }
  for (const key of ['pairings', 'nodes', 'tasks', 'memories']) {
    if (!Array.isArray(data[key])) throw new Error(`Codex Mesh store field ${key} must be an array`);
  }
  return data;
}

export class AtomicJsonStore {
  #state;
  #queue = Promise.resolve();

  constructor(filePath, state) {
    this.filePath = filePath;
    this.#state = validateStore(state);
  }

  static async open(filePath) {
    const contents = await readFile(filePath, 'utf8');
    return new AtomicJsonStore(filePath, JSON.parse(contents));
  }

  static async create(filePath, initialState, { overwrite = false } = {}) {
    if (!overwrite) {
      try {
        await readFile(filePath);
        throw conflict(`Store already exists: ${filePath}`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await durableWrite(filePath, validateStore(structuredClone(initialState)));
    return AtomicJsonStore.open(filePath);
  }

  async read() {
    await this.#queue;
    return structuredClone(this.#state);
  }

  transaction(mutator) {
    const operation = this.#queue.then(async () => {
      const draft = structuredClone(this.#state);
      const result = await mutator(draft);
      validateStore(draft);
      await durableWrite(this.filePath, draft);
      this.#state = draft;
      return structuredClone(result);
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
}
