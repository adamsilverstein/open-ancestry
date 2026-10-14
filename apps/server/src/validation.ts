import { createRequire } from 'node:module';
import type { BuildCompilerFromPool } from '@fastify/ajv-compiler';

type Validate = ((...args: unknown[]) => unknown) & { errors?: unknown };
type Compile = (route: unknown) => Validate;

/**
 * Fastify's own Ajv compiler, but each route's validator is compiled on its
 * first request instead of all ~45 at startup, and Ajv itself is only loaded
 * then (together about 75ms of cold start, issue #54). Ajv options, formats
 * and error output are unchanged.
 */
export function lazyValidatorFactory(): BuildCompilerFromPool {
  type BuildFromPool = (externalSchemas: unknown, options: unknown) => Compile;
  let buildFromPool: BuildFromPool | undefined;
  const factory = (externalSchemas: unknown, options: unknown): Compile => {
    let compile: Compile | undefined;
    return (route) => {
      let validate: Validate | undefined;
      const lazy: Validate = (...args) => {
        if (!validate) {
          buildFromPool ??= (
            createRequire(import.meta.url)('@fastify/ajv-compiler') as () => BuildFromPool
          )();
          compile ??= buildFromPool(externalSchemas, options);
          validate = compile(route);
        }
        const result = validate(...args);
        // Fastify reads validation errors from the function it was given.
        lazy.errors = validate.errors;
        return result;
      };
      return lazy;
    };
  };
  return factory as unknown as BuildCompilerFromPool;
}

/**
 * Serializer compiler for routes with a response schema. None declare one, so
 * this stands in for fast-json-stringify (one less module tree to load at
 * startup) and simply JSON-encodes.
 */
export const plainSerializerFactory = () => () => (data: unknown) => JSON.stringify(data);
