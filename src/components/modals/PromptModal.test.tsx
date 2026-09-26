import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PromptModal from './PromptModal';

describe('PromptModal', () => {
  it('renders with defaultValue and confirms the typed value', () => {
    const onConfirm = vi.fn(); const onClose = vi.fn();
    render(<PromptModal isOpen onClose={onClose} onConfirm={onConfirm} title="Link" defaultValue="https://x" />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('https://x');
    fireEvent.change(input, { target: { value: 'https://y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith('https://y');
    expect(onClose).toHaveBeenCalled();
  });
  it('Escape and Cancel close without confirming', () => {
    const onConfirm = vi.fn(); const onClose = vi.fn();
    render(<PromptModal isOpen onClose={onClose} onConfirm={onConfirm} title="Link" />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('renders nothing when closed', () => {
    render(<PromptModal isOpen={false} onClose={() => {}} onConfirm={() => {}} title="Link" />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});