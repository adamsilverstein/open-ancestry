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
