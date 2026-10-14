import { describe, expect, it } from 'vitest';
import { describeDate } from './datePreview';

describe('describeDate', () => {
  it('shows the normalized date and its qualifier', () => {
    expect(describeDate('abt 1900')).toEqual({ status: 'valid', text: 'abt. 1900 · about' });
    expect(describeDate('bet 1900 and 1905')).toEqual({
      status: 'valid',
      text: 'bet. 1900 and 1905 · between',
    });
    expect(describeDate('12 mar 1880')).toEqual({ status: 'valid', text: '12 Mar 1880' });
    expect(describeDate('bef 1900').text).toBe('bef. 1900 · before');
  });

  it('flags numeric dates that could be read either way', () => {
    const result = describeDate('05/06/1910');
    expect(result.status).toBe('ambiguous');
    expect(result.text).toBe('6 May 1910 · could also be read day first (5 Jun 1910)');
  });

  it('explains text that is not a date', () => {
    expect(describeDate('when the mill burned')).toEqual({
      status: 'invalid',
      text: 'Not a recognized date. It will be kept as text.',
    });
  });

  it('is empty for blank input', () => {
    expect(describeDate('  ')).toEqual({ status: 'empty', text: '' });
  });
});
