import { NotFoundError, TransactionInProgressError, UndoConflictError } from '@open-ancestry/db';
import { GedcomSerializeError } from '@open-ancestry/gedcom';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ShuttingDownError } from './jobs';

/** Machine-readable error codes; every API error is `{ error: { code, message } }`. */
export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'forbidden'
  | 'forbidden_host'
  | 'not_found'
  | 'conflict'
  | 'stale'
  /** Another import, or another process (`open-ancestry import`, an upgrade), holds the tree. */
  | 'busy'
  /** Undo with `expect`: that batch is no longer the newest. */
  | 'not_newest'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'range_not_satisfiable'
  | 'too_many_jobs'
  | 'service_unavailable'
  | 'not_implemented'
  | 'internal_error';

export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;

  constructor(statusCode: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const notFound = (message: string) => new ApiError(404, 'not_found', message);
export const badRequest = (message: string) => new ApiError(400, 'bad_request', message);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);
/** The client edited from data that has changed since it loaded it (another tab, undo). */
export const stale = (message: string) => new ApiError(409, 'stale', message);
/** The tree is busy with an import or another process's write; the same request works later. */
export const busy = (message: string) => new ApiError(409, 'busy', message);
export const notNewest = (message: string) => new ApiError(409, 'not_newest', message);

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

/** A plain sentence for a constraint failure, e.g. `UNIQUE constraint failed: tag.name`. */
function constraintMessage(error: { code?: string; message: string }): string {
  if (/UNIQUE constraint failed: tag\./.test(error.message)) {
    return 'A tag with that name already exists';
  }
  if (/UNIQUE constraint failed: family_child\.family_id/.test(error.message)) {
    return 'That child is already in this family';
  }
  if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return 'That is already in the tree';
  }
  if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return 'Something this change refers to is no longer in the tree';
  }
  return 'That change does not fit the data already in the tree';
}

/** Maps Fastify, database and API errors onto the typed JSON envelope. */
export function toApiError(error: FastifyError | Error): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof NotFoundError) return notFound(error.message);
  if (error instanceof UndoConflictError) return conflict(error.message);
  if (error instanceof ShuttingDownError) {
    return new ApiError(503, 'service_unavailable', error.message);
  }
  // Backstop for a write that reached a tree inside another writer's transaction.
  if (error instanceof TransactionInProgressError) {
    return busy('The tree is busy (an import is running); try again when it finishes');
  }
  // Stored data that cannot be written as valid GEDCOM (export); say what, rather than a bare 500.
  if (error instanceof GedcomSerializeError) {
    return conflict(`The tree cannot be exported as GEDCOM: ${error.message}`);
  }
  const fastify = error as FastifyError;
  // Another connection (an import worker) holds the write lock.
  if (fastify.code?.startsWith('SQLITE_BUSY')) {
    return busy('The tree is busy (an import is running); try again when it finishes');
  }
  // Unique, foreign key and CHECK failures: the request contradicts stored data.
  // The SQLite text names tables and columns; say what it means instead.
  if (fastify.code?.startsWith('SQLITE_CONSTRAINT')) return conflict(constraintMessage(fastify));
  if (fastify.validation) return new ApiError(400, 'validation_failed', fastify.message);
  switch (fastify.statusCode) {
    case 413:
      return new ApiError(413, 'payload_too_large', 'Request body is too large');
    case 415:
      return new ApiError(415, 'unsupported_media_type', fastify.message);
    case 400:
      return badRequest(fastify.message);
    case 403:
      return new ApiError(403, 'forbidden', fastify.message);
    case 404:
      return notFound(fastify.message);
  }
  return new ApiError(500, 'internal_error', 'Internal server error');
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const api = toApiError(error as FastifyError);
    if (api.statusCode >= 500) request.log.error(error);
    return reply.code(api.statusCode).send(errorBody(api.code, api.message));
  });
}
