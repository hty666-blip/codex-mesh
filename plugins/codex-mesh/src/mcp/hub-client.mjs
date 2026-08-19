const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class HubClientError extends Error {
  constructor(code, { status, retryable = false } = {}) {
    super(publicMessage(code, status));
    this.name = 'HubClientError';
    this.code = sanitizeCode(code);
    this.status = Number.isInteger(status) ? status : undefined;
    this.retryable = Boolean(retryable);
  }
}

export class HubClient {
  constructor({ hubUrl, controllerToken, requestTimeoutMs = 30_000, fetchImpl = globalThis.fetch }) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch-compatible implementation is required');
    this.hubUrl = hubUrl.replace(/\/$/, '');
    this.controllerToken = controllerToken;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetchImpl = fetchImpl;
  }

  listNodes() {
    return this.request('/v1/nodes');
  }

  createPairing(input) {
    return this.request('/v1/pairings', { method: 'POST', body: input });
  }

  startTask(input) {
    return this.request('/v1/tasks', { method: 'POST', body: input });
  }

  getTask(taskId) {
    return this.request(`/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  cancelTask(taskId, input) {
    return this.request(`/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: input });
  }

  searchMemories(input) {
    return this.request('/v1/memories', { query: input });
  }

  addMemory(input) {
    return this.request('/v1/memories', { method: 'POST', body: input });
  }

  async request(path, { method = 'GET', query, body } = {}) {
    const url = new URL(`${this.hubUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();

    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.controllerToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const code = error?.name === 'AbortError' ? 'hub_timeout' : 'hub_unreachable';
      throw new HubClientError(code, { retryable: true });
    } finally {
      clearTimeout(timeout);
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new HubClientError('hub_response_too_large', { status: response.status });
    }

    let text;
    try {
      text = await response.text();
    } catch {
      throw new HubClientError('hub_response_unreadable', { status: response.status, retryable: true });
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new HubClientError('hub_response_too_large', { status: response.status });
    }

    let payload;
    try {
      payload = text === '' ? {} : JSON.parse(text);
    } catch {
      throw new HubClientError('hub_response_invalid', { status: response.status });
    }

    if (!response.ok) {
      const code = sanitizeCode(payload?.error?.code || `hub_http_${response.status}`);
      throw new HubClientError(code, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new HubClientError('hub_response_invalid', { status: response.status });
    }
    return payload;
  }
}

function sanitizeCode(value) {
  const candidate = String(value ?? 'hub_error').toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate) ? candidate : 'hub_error';
}

function publicMessage(code, status) {
  const safeCode = sanitizeCode(code);
  const suffix = Number.isInteger(status) ? ` (HTTP ${status})` : '';
  return `Codex Mesh Hub request failed: ${safeCode}${suffix}`;
}
