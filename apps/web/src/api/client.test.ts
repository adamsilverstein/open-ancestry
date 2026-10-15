import { describe, expect, it } from 'vitest';
import { ApiError, isMissingPerson, isValidId } from './client';

describe('person ids', () => {
  it('accepts the server id shape only', () => {
    expect(isValidId('01M4XSWXNZ3FYRZWCBMDRAJAQQ')).toBe(true);
    expect(isValidId('I1')).toBe(true);
    expect(isValidId("x'y")).toBe(false);
    expect(isValidId('')).toBe(false);
    expect(isValidId('a'.repeat(65))).toBe(false);
  });

  it('treats a 404, or a 400 for an impossible id, as a missing person', () => {
    const invalid = new ApiError(400, 'validation_failed', 'params/id must match pattern');
    expect(isMissingPerson(new ApiError(404, 'not_found', 'gone'), 'I1')).toBe(true);
    expect(isMissingPerson(invalid, "x'y")).toBe(true);
    // A 400 for a well-formed id is a real error, not a missing person.
    expect(isMissingPerson(invalid, 'I1')).toBe(false);
    expect(isMissingPerson(new Error('offline'), "x'y")).toBe(false);
  });
});
