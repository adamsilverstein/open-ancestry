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
import type { ThumbnailQueue } from './thumbnails';

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
  /** Largest media (gallery) upload, in bytes. */
  mediaUploadLimit: number;
  /** Background WebP thumbnails for media. */
  thumbnails: ThumbnailQueue;
}
