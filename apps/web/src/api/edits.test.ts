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

  it('finds the field in a nested batch path too', () => {
    const batch = new ApiError(
      400,
      'validation_failed',
      'body/operations/0/name/surname must NOT have more than 200 characters, body/operations/0/name/surname must be null',
    );
    expect(fieldError(batch)).toEqual({
      field: 'surname',
      message: 'Surname can be at most 200 characters.',
    });
    const relative = new ApiError(
      400,
      'validation_failed',
      'body/person/names/0/given must NOT have more than 200 characters',
    );
    expect(fieldError(relative)?.field).toBe('given');
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
