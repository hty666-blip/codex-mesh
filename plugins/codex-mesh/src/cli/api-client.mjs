import { HubClient } from '../agent/api-client.mjs';

function queryString(values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

export class ControllerClient extends HubClient {
  createPairing(body) {
    return this.request('POST', '/v1/pairings', { body });
  }

  listNodes(query = {}) {
    return this.request('GET', `/v1/nodes${queryString(query)}`);
  }

  revokeNode(nodeId, body = {}) {
    return this.request('POST', `/v1/nodes/${encodeURIComponent(nodeId)}/revoke`, { body });
  }

  submitTask(body) {
    return this.request('POST', '/v1/tasks', { body });
  }

  listTasks(query = {}) {
    return this.request('GET', `/v1/tasks${queryString(query)}`);
  }

  getTask(taskId) {
    return this.request('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  cancelTask(taskId, body = {}) {
    return this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { body });
  }

  addMemory(body) {
    return this.request('POST', '/v1/memories', { body });
  }

  searchMemories(query = {}) {
    return this.request('GET', `/v1/memories${queryString(query)}`);
  }
}
