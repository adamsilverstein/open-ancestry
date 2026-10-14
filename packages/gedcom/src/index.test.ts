import { describe, expect, it } from 'vitest';
import { stripBom } from './index';

describe('stripBom', () => {
  it('removes a leading UTF-8 byte order mark', () => {
    expect(stripBom('﻿0 HEAD')).toBe('0 HEAD');
  });

  it('leaves text without a BOM unchanged', () => {
    expect(stripBom('0 HEAD')).toBe('0 HEAD');
  });
});
