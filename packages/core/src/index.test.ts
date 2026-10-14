import { describe, expect, it } from 'vitest';
import { appName } from './index';

describe('core', () => {
  it('exposes the app name', () => {
    expect(appName()).toBe('open-ancestry');
  });
});
