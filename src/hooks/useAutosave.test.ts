import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutosave } from './useAutosave';

describe('useAutosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces rapid edits into one save', async () => {
    const save = vi.fn(async () => {});
    const { result } = renderHook(() => useAutosave(save, 800));
    act(() => result.current.setValue({ title: 'a', content: '1' }));
    act(() => result.current.setValue({ title: 'a', content: '12' }));
    act(() => result.current.setValue({ title: 'a', content: '123' }));
    act(() => vi.advanceTimersByTime(799));
    expect(save).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    await act(async () => {});
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ title: 'a', content: '123' });
  });

  it('flush commits an armed edit immediately and cancels the debounce', async () => {
    const save = vi.fn(async () => {});
    const { result } = renderHook(() => useAutosave(save, 800));
    act(() => result.current.setValue({ title: 't', content: 'x' }));
    act(() => vi.advanceTimersByTime(100));
    await act(async () => { await result.current.flush(); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ title: 't', content: 'x' });
    // the armed debounce must NOT fire again after the flush
    act(() => vi.advanceTimersByTime(2000));
    await act(async () => {});
    expect(save).toHaveBeenCalledTimes(1);
  });
});
