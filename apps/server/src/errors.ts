import { NotFoundError, TransactionInProgressError, UndoConflictError } from '@open-ancestry/db';
import { GedcomSerializeError } from '@open-ancestry/gedcom';
import type { FastifyError, FastifyInstance } from 'fastify';

/** Machine-readable error codes; every API error is `{ error: { code, message } }`. */
export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'forbidden'
  | 'forbidden_host'
  | 'not_found'
  | 'conflict'
  /** Undo with `expect`: that batch is no longer the newest. */
  | 'not_newest'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'range_not_satisfiable'
  | 'too_many_jobs'
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
export const notNewest = (message: string) => new ApiError(409, 'not_newest', message);

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

/** Maps Fastify, database and API errors onto the typed JSON envelope. */
export function toApiError(error: FastifyError | Error): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof NotFoundError) return notFound(error.message);
  if (error instanceof UndoConflictError) return conflict(error.message);
  // Backstop for a write that reached a tree inside another writer's transaction.
  if (error instanceof TransactionInProgressError) {
    return conflict('The tree is busy (an import is running); try again when it finishes');
  }
  // Stored data that cannot be written as valid GEDCOM (export); say what, rather than a bare 500.
  if (error instanceof GedcomSerializeError) {
    return conflict(`The tree cannot be exported as GEDCOM: ${error.message}`);
  }
  const fastify = error as FastifyError;
  // Unique, foreign key and CHECK failures: the request contradicts stored data.
  if (fastify.code?.startsWith('SQLITE_CONSTRAINT')) return conflict(fastify.message);
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
