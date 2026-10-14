import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import { fieldError, friendlyMessage } from './edits';

const tooLong = new ApiError(
  400,
  'validation_failed',
  'body/names/0/surname must NOT have more than 200 characters, body/names/0/surname must be null',
);

describe('friendly edit errors', () => {
  it('names the field a length error is about', () => {
    expect(fieldError(tooLong)).toEqual({
      field: 'surname',
      message: 'Surname can be at most 200 characters.',
    });
    expect(friendlyMessage(tooLong)).toBe('Surname can be at most 200 characters.');
  });

  it('never shows a raw schema message', () => {
    const other = new ApiError(400, 'validation_failed', 'body/sex must be equal to one of');
    expect(fieldError(other)).toBeNull();
    expect(friendlyMessage(other)).toBe('Some of the values are not valid.');
  });

  it('keeps other errors as they are', () => {
    expect(friendlyMessage(new ApiError(500, 'internal', 'Disk full'))).toBe('Disk full');
    expect(friendlyMessage('offline')).toBe('offline');
  });
});
