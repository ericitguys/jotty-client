import { useEffect, useRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ConfirmModal from './ConfirmModal';

describe('ConfirmModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ConfirmModal isOpen={false} onClose={() => {}} onConfirm={() => {}} title="Delete" message="Sure?" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows title and message when open; Confirm fires onConfirm and closes; Cancel closes without confirming', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmModal isOpen onClose={onClose} onConfirm={onConfirm} title="Delete" message='Are you sure you want to delete "Groceries"?' confirmText="Delete" />
    );
    expect(screen.getByRole('dialog', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByText('Are you sure you want to delete "Groceries"?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Escape closes without confirming; destructive variant marks the confirm button', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmModal isOpen onClose={onClose} onConfirm={onConfirm} title="Delete" message="Sure?" destructive />
    );
    const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmBtn.className).toContain('danger');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('backdrop mousedown closes without confirming (ref on the card blocks card clicks)', () => {
    const onClose = vi.fn();
    const { container } = render(
      <ConfirmModal isOpen onClose={onClose} onConfirm={() => {}} title="Delete" message="Sure?" />
    );
    const backdrop = container.querySelector('.modal-backdrop') as HTMLElement;
    const card = container.querySelector('.modal-card') as HTMLElement;
    fireEvent.mouseDown(backdrop, { target: backdrop });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(card, { target: card });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('confirm button ref exists for focus (mount focus target)', () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(
      <ConfirmModal isOpen onClose={() => {}} onConfirm={() => {}} title="Delete" message="Sure?" confirmRef={ref} />
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});