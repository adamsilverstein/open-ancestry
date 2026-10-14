import { describe, expect, it } from 'vitest';
import { lazyValidatorFactory, plainSerializerFactory } from './validation';

type Validate = ((data: unknown) => boolean) & { errors?: { message?: string }[] | null };

const schema = {
  type: 'object',
  properties: { n: { type: 'integer', minimum: 1 } },
  required: ['n'],
  additionalProperties: false,
};

function validatorFor() {
  const factory = lazyValidatorFactory() as unknown as (
    e: unknown,
    o: unknown,
  ) => (route: unknown) => Validate;
  const compile = factory({}, { customOptions: { coerceTypes: 'array', removeAdditional: false } });
  return compile({ schema, method: 'GET', url: '/x', httpPart: 'querystring' });
}

describe('lazyValidatorFactory', () => {
  it('validates like Fastify, with options and errors on the returned function', () => {
    const validate = validatorFor();
    const ok = { n: '3' };
    expect(validate(ok)).toBe(true);
    expect(ok.n).toBe(3); // coerced, as Fastify's default does for querystrings
    expect(validate({ n: 0 })).toBe(false);
    expect(validate.errors?.[0]?.message).toMatch(/>= 1/);
    expect(validate({ n: 2, extra: true })).toBe(false);
    expect(validate({ n: 2 })).toBe(true);
    expect(validate.errors).toBeNull();
  });
});

describe('plainSerializerFactory', () => {
  it('JSON-encodes', () => {
    expect(plainSerializerFactory()()({ a: [1, 'b'] })).toBe('{"a":[1,"b"]}');
  });
});

describe('every route schema', () => {
  it('compiles with the server Ajv options (lazy compile must not hide a bad schema)', async () => {
    const { createServer } = await import('./index');
    const AjvCompiler = (await import('@fastify/ajv-compiler')).default;
    const app = createServer({ library: '/nonexistent-oa-library' });
    const routes: { method: string | string[]; url: string; schema?: Record<string, unknown> }[] =
      [];
    app.addHook('onRoute', (route) => void routes.push(route));
    await app.ready();
    const compile = AjvCompiler()(
      {},
      { customOptions: { removeAdditional: false, coerceTypes: 'array' } },
    ) as unknown as (route: Record<string, unknown>) => unknown;
    let compiled = 0;
    for (const route of routes) {
      for (const httpPart of ['params', 'querystring', 'body', 'headers'] as const) {
        const schema = route.schema?.[httpPart];
        if (!schema) continue;
        expect(
          () => compile({ schema, method: route.method, url: route.url, httpPart }),
          `${route.method} ${route.url} ${httpPart}`,
        ).not.toThrow();
        compiled++;
      }
    }
    expect(compiled).toBeGreaterThan(40);
    await app.close();
  });
});
