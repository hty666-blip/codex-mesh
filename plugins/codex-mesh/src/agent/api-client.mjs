const DEFAULT_TIMEOUT_MS = 15_000;

export class HubRequestError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'HubRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function normalizeHubUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new TypeError('Hub URL is required');
  }

  const url = new URL(input.trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError('Hub URL must use http:// or https://');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('Hub URL must not contain credentials, a query, or a fragment');
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function combineSignals(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  return signal;
}

export class HubClient {
  constructor({ hubUrl, token, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.hubUrl = normalizeHubUrl(hubUrl);
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(method, pathname, { body, auth = true, signal } = {}) {
    if (auth && (!this.token || typeof this.token !== 'string')) {
      throw new HubRequestError('A node token is required for this request');
    }

    let response;
    try {
      response = await this.fetchImpl(new URL(pathname, `${this.hubUrl}/`), {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(auth ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combineSignals(signal, this.timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new HubRequestError(`Hub request timed out after ${this.timeoutMs} ms`, {
          code: 'request_timeout',
        });
      }
      throw new HubRequestError(`Could not reach the hub: ${error?.message ?? String(error)}`, {
        code: 'network_error',
      });
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text.slice(0, 2_000) };
      }
    }

    if (!response.ok) {
      throw new HubRequestError(
        payload?.error?.message ?? payload?.message ?? `Hub request failed with HTTP ${response.status}`,
        {
          status: response.status,
          code: payload?.error?.code,
          details: payload?.error?.details,
        },
      );
    }
    return payload ?? {};
  }

  enroll(body, options) {
    return this.request('POST', '/v1/agents/enroll', { body, auth: false, ...options });
  }

  heartbeat(body, options) {
    return this.request('POST', '/v1/agents/heartbeat', { body, ...options });
  }

  poll(body = { limit: 1 }, options) {
    return this.request('POST', '/v1/agents/poll', { body, ...options });
  }

  startTask(taskId, options) {
    return this.request('POST', `/v1/agents/tasks/${encodeURIComponent(taskId)}/start`, {
      body: {},
      ...options,
    });
  }

  taskEvent(taskId, body, options) {
    return this.request('POST', `/v1/agents/tasks/${encodeURIComponent(taskId)}/event`, {
      body,
      ...options,
    });
  }

  completeTask(taskId, body, options) {
    return this.request('POST', `/v1/agents/tasks/${encodeURIComponent(taskId)}/complete`, {
      body,
      ...options,
    });
  }
}
