import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuickCapture } from './QuickCapture';

describe('QuickCapture', () => {
  it('renders an input and does not submit empty text', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<QuickCapture focusSignal={0} onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/capture/i);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits trimmed text on Enter and clears the field', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<QuickCapture focusSignal={0} onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/capture/i);
    fireEvent.change(input, { target: { value: '  renew vpn cert  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('renew vpn cert');
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('shows a persistent error line if submit rejects', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('offline queue full'));
    render(<QuickCapture focusSignal={0} onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/capture/i);
    fireEvent.change(input, { target: { value: 'save me' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(/offline queue full/i)).toBeTruthy());
  });

  it('focuses the input when focusSignal increments', () => {
    const { rerender } = render(<QuickCapture focusSignal={0} onSubmit={vi.fn()} />);
    const input = screen.getByPlaceholderText(/capture/i);
    rerender(<QuickCapture focusSignal={1} onSubmit={vi.fn()} />);
    expect(document.activeElement).toBe(input);
  });
});