import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Importer, JobManager } from './jobs';
import type { Library } from './library';

export type Api = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

/** What route modules need from the server. */
export interface Deps {
  library: Library;
  jobs: JobManager;
  importer: Importer | undefined;
  /** Largest accepted import upload, in bytes. */
  uploadLimit: number;
}
