import { describe, expect, it } from 'vitest';
import { sqliteVersion } from './index';

describe('db', () => {
  it('loads the native SQLite binding', () => {
    expect(sqliteVersion()).toMatch(/^3\.\d+\.\d+$/);
  });
});
