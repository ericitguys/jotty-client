import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DateDropdown from './DateDropdown';
import { ymd } from './calendarGrid';

// The WebKitGTK eradication contract (2026-09-29 probe): the native date input's
// calendar popup commits a day-pick but NEVER closes + keeps grabbing input.
// These fences pin the exact behaviors the native popup could NOT do:
// picking closes, outside-click closes, Escape closes — plus the save-path
// value format ('YYYY-MM-DD') and the disabled-EditorToolbar parity shape.

const pickAndAssert = (value: string) => {
  const onChange = vi.fn();
  const { container } = render(
    <DateDropdown value="" onChange={onChange} placeholder="Pick a date" ariaLabel="Date" />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Date' }));
  // the popup grid is open
  const grid = container.querySelector('.jotty-date-grid') as HTMLElement;
  expect(grid).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: value }));
  expect(onChange).toHaveBeenCalledWith(value);
  // popup closed after the pick — THE native popup failure mode
  expect(container.querySelector('.jotty-date-grid')).toBeNull();
};

describe('DateDropdown closed state', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the placeholder when no value is set', () => {
    render(<DateDropdown value="" onChange={() => {}} placeholder="Pick a date" ariaLabel="Date" />);
    expect(screen.getByRole('button', { name: 'Date' }).textContent).toContain('Pick a date');
  });

  it('renders a human label for a set value (short date, locale-mirrored)', () => {
    const value = '2026-09-15';
    render(<DateDropdown value={value} onChange={() => {}} ariaLabel="Date" />);
    const expected = new Date(2026, 8, 15).toLocaleDateString([], {
      year: 'numeric', month: 'short', day: 'numeric',
    });
    expect(screen.getByRole('button', { name: 'Date' }).textContent).toContain(expected);
  });
});

describe('DateDropdown picking', () => {
  afterEach(() => document.removeEventListener('mousedown', () => {}));

  it('day-pick commits the YYYY-MM-DD value AND closes the popup', () => {
    // pick the 15th of whatever month the grid opens in (the current month)
    const now = new Date();
    pickAndAssert(ymd(new Date(now.getFullYear(), now.getMonth(), 15)));
  });

  it('opens the grid with the current month header + weekday row', () => {
    const { container } = render(
      <DateDropdown value="" onChange={() => {}} ariaLabel="Date" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Date' }));
    const header = container.querySelector('.jotty-date-header') as HTMLElement;
    expect(header).not.toBeNull();
    // localized long-month + year label (mirrored computation, locale-robust)
    const ref = new Date().toLocaleString([], { month: 'long', year: 'numeric' });
    expect(header.textContent).toContain(ref);
    // 7 weekday cells + >=28 day cells (4+ grid rows; 5-week months have 35)
    expect(container.querySelectorAll('.jotty-date-wd')).toHaveLength(7);
    const grid = container.querySelector('.jotty-date-grid') as HTMLElement;
    expect(grid.querySelectorAll('button.jotty-date-day').length).toBeGreaterThanOrEqual(28);
    // today is highlighted
    const today = ymd(new Date());
    expect(screen.getByRole('button', { name: today }).className).toContain(' jotty-date-today');
  });

  it('‹ › navigation switches months and back restores the view', () => {
    const { container } = render(
      <DateDropdown value="" onChange={() => {}} ariaLabel="Date" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Date' }));
    const header = container.querySelector('.jotty-date-header') as HTMLElement;
    const start = header.textContent!;
    const prev = screen.getByRole('button', { name: /previous month/i }) as HTMLElement;
    const next = screen.getByRole('button', { name: /next month/i }) as HTMLElement;
    fireEvent.click(prev);
    expect(container.querySelector('.jotty-date-header')!.textContent).not.toBe(start);
    fireEvent.click(next);
    expect(container.querySelector('.jotty-date-header')!.textContent).toBe(start); // back to the open month
  });

  it('Today picks today and closes', () => {
    const onChange = vi.fn();
    const { container } = render(<DateDropdown value="" onChange={onChange} ariaLabel="Date" />);
    fireEvent.click(screen.getByRole('button', { name: 'Date' }));
    fireEvent.click(screen.getByText('Today'));
    expect(onChange).toHaveBeenCalledWith(ymd(new Date()));
    expect(container.querySelector('.jotty-date-grid')).toBeNull();
  });

  it('Clear emits the empty string and closes (Set-date clearing path)', () => {
    const onChange = vi.fn();
    const { container } = render(
      <DateDropdown value="2026-09-15" onChange={onChange} ariaLabel="Date" showClear />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Date' }));
    fireEvent.click(screen.getByText('Clear'));
    expect(onChange).toHaveBeenCalledWith('');
    expect(container.querySelector('.jotty-date-grid')).toBeNull();
  });

  it('hides the Clear row by default (reminder editor: only the menu clears)', () => {
    const { container } = render(<DateDropdown value="" onChange={() => {}} ariaLabel="Date" />);
    fireEvent.click(screen.getByRole('button', { name: 'Date' }));
    expect(screen.queryByText('Clear')).toBeNull();
    expect(container.querySelector('.jotty-date-grid')).not.toBeNull();
  });

  it('outside mousedown closes the popup', () => {
    const { container } = render(
      <DateDropdown value="" onChange={() => {}} ariaLabel="Date" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Date' }));
    expect(container.querySelector('.jotty-date-grid')).not.toBeNull();
    fireEvent(
      document,
      new MouseEvent('mousedown', { bubbles: true }),
    );
    expect(container.querySelector('.jotty-date-grid')).toBeNull();
  });

  it('Escape closes the popup (the unstick key the native popup never took)', () => {
    const { container } = render(
      <DateDropdown value="" onChange={() => {}} ariaLabel="Date" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Date' }));
    expect(container.querySelector('.jotty-date-grid')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('.jotty-date-grid')).toBeNull();
  });

  it('aria-expanded flips on the trigger', () => {
    render(<DateDropdown value="" onChange={() => {}} ariaLabel="Date" />);
    const btn = screen.getByRole('button', { name: 'Date' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });
});