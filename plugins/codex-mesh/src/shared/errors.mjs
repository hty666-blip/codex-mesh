export class MeshError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'MeshError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message, details) {
  return new MeshError(400, 'bad_request', message, details);
}

export function unauthorized(message = 'Authentication required') {
  return new MeshError(401, 'unauthorized', message);
}

export function forbidden(message = 'Not allowed') {
  return new MeshError(403, 'forbidden', message);
}

export function notFound(message = 'Resource not found') {
  return new MeshError(404, 'not_found', message);
}

export function conflict(message, details) {
  return new MeshError(409, 'conflict', message, details);
}
