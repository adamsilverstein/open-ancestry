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
import type { ReimportSessions } from './reimports';

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
  /** Largest accepted GEDCOM (.ged, .gedcom) upload, in bytes. */
  uploadLimit: number;
  /** Largest accepted GEDZIP (.zip, .gdz) upload, in bytes. */
  archiveUploadLimit: number;
  /** Largest media (gallery) upload, in bytes. */
  mediaUploadLimit: number;
  /** Background WebP thumbnails for media. */
  thumbnails: ThumbnailQueue;
  /** Re-imports waiting for review. */
  reimports: ReimportSessions;
}
