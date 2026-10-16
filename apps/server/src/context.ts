import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Comparer, Importer, JobManager } from './jobs';
import type { Library } from './library';
import type { ThumbnailQueue } from './thumbnails';
import type { ReimportFolders } from './reimport-folders';
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
  /** Re-import compare (see ServerOptions.comparer). */
  comparer: Comparer;
  /** Largest accepted GEDCOM (.ged, .gedcom) upload, in bytes. */
  uploadLimit: number;
  /** Largest accepted GEDZIP (.zip, .gdz) upload, in bytes. */
  archiveUploadLimit: number;
  /** Largest media (gallery) upload, in bytes. */
  mediaUploadLimit: number;
  /** Photo attaches streaming at once; more get 429 before their body is read. */
  maxConcurrentAttaches: number;
  /** Background WebP thumbnails for media. */
  thumbnails: ThumbnailQueue;
  /** Re-imports waiting for review. */
  reimports: ReimportSessions;
  /** This server's re-import working folders (see reimport-folders.ts). */
  reimportFolders: ReimportFolders;
}
