import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { hasDirtyForms, useDirtyForm } from './dirty';

describe('useDirtyForm', () => {
  it('counts forms whose value differs from what they opened with', () => {
    expect(hasDirtyForms()).toBe(false);
    const a = renderHook(({ value }) => useDirtyForm(value), { initialProps: { value: 'Rowan' } });
    const b = renderHook(({ value }) => useDirtyForm(value), { initialProps: { value: { x: 1 } } });
    expect(hasDirtyForms()).toBe(false);
    act(() => a.rerender({ value: 'Ghost' }));
    expect(hasDirtyForms()).toBe(true);
    act(() => b.rerender({ value: { x: 2 } }));
    act(() => a.rerender({ value: 'Rowan' }));
    expect(hasDirtyForms()).toBe(true);
    b.unmount();
    expect(hasDirtyForms()).toBe(false);
    act(() => a.rerender({ value: 'Ghost' }));
    a.unmount();
    expect(hasDirtyForms()).toBe(false);
  });
});
