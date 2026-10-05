import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import RecurrenceSweepTimer from './RecurrenceSweepTimer';

describe('RecurrenceSweepTimer', () => {
  afterEach(() => { vi.useRealTimers(); invoke.mockClear(); });

  it('sweeps on mount and every 60s, stops after unmount', () => {
    vi.useFakeTimers();
    const view = render(<RecurrenceSweepTimer />);
    expect(invoke).toHaveBeenCalledWith('sweep_recurrence');
    invoke.mockClear();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(invoke).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(59_000); });
    expect(invoke).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(invoke).toHaveBeenCalledTimes(2);
    view.unmount();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('recurrence-sweep-timer')).toBeNull();
  });
});