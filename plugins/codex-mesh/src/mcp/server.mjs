#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { loadControllerConfig } from './config.mjs';
import { HubClient } from './hub-client.mjs';
import { TOOLS, callTool } from './tools.mjs';

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export class McpServer {
  constructor({ client, input = process.stdin, output = process.stdout, logger = console } = {}) {
    if (!client) throw new TypeError('client is required');
    this.client = client;
    this.input = input;
    this.output = output;
    this.logger = logger;
    this.initialized = false;
  }

  async run() {
    const lines = createInterface({ input: this.input, crlfDelay: Infinity, terminal: false });
    for await (const line of lines) {
      if (line.trim() === '') continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        this.write(errorResponse(null, -32700, 'Parse error'));
        continue;
      }

      try {
        const response = await this.handle(request);
        if (response !== undefined) this.write(response);
      } catch {
        if (hasRequestId(request)) this.write(errorResponse(request.id, -32603, 'Internal error'));
      }
    }
  }

  async handle(request) {
    if (!isRequestObject(request)) {
      return errorResponse(request?.id ?? null, -32600, 'Invalid Request');
    }

    const notification = !hasRequestId(request);
    switch (request.method) {
      case 'initialize': {
        if (notification) return undefined;
        const requestedVersion = request.params?.protocolVersion;
        const protocolVersion = typeof requestedVersion === 'string' && requestedVersion
          ? requestedVersion
          : DEFAULT_PROTOCOL_VERSION;
        return successResponse(request.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'codex-mesh', title: 'Codex Mesh', version: '0.1.0' },
          instructions: '先列出节点；只读任务可并行，工作区写任务必须明确指定单个节点和 workspace_id。',
        });
      }

      case 'notifications/initialized':
        this.initialized = true;
        return undefined;

      case 'ping':
        return notification ? undefined : successResponse(request.id, {});

      case 'tools/list':
        return notification ? undefined : successResponse(request.id, { tools: TOOLS });

      case 'tools/call': {
        if (notification) return undefined;
        const name = request.params?.name;
        if (typeof name !== 'string' || name === '') {
          return errorResponse(request.id, -32602, 'Invalid params');
        }
        const result = await callTool(this.client, name, request.params?.arguments ?? {});
        return successResponse(request.id, result);
      }

      default:
        return notification ? undefined : errorResponse(request.id, -32601, 'Method not found');
    }
  }

  write(message) {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}

function isRequestObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.jsonrpc === '2.0'
    && typeof value.method === 'string';
}

function hasRequestId(request) {
  return Object.prototype.hasOwnProperty.call(request ?? {}, 'id');
}

function successResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  try {
    const config = await loadControllerConfig({ argv, env });
    const client = new HubClient(config);
    const server = new McpServer({ client });
    await server.run();
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'startup_failed';
    process.stderr.write(`[codex-mesh] MCP server could not start (${safeCode(code)}).\n`);
    process.exitCode = 1;
  }
}

function safeCode(value) {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value) ? value : 'startup_failed';
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryUrl) await main();
