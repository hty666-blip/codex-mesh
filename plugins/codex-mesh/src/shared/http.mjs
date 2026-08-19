import { MeshError, badRequest } from './errors.mjs';

const MAX_BODY_BYTES = 1024 * 1024;

export async function readJson(request, { maxBytes = MAX_BODY_BYTES } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new MeshError(413, 'payload_too_large', 'JSON body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const value = JSON.parse(text);
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw badRequest('JSON body must be an object');
    }
    return value;
  } catch (error) {
    if (error instanceof MeshError) throw error;
    throw badRequest('Malformed JSON body');
  }
}

export function sendJson(response, status, body, extraHeaders = {}) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(payload);
}

export function sendError(response, error, logger = console) {
  const known = error instanceof MeshError;
  if (!known) logger.error?.(error);
  const status = known ? error.status : 500;
  const body = {
    error: {
      code: known ? error.code : 'internal_error',
      message: known ? error.message : 'Internal server error',
    },
  };
  if (known && error.details !== undefined) body.error.details = error.details;
  sendJson(response, status, body);
}
