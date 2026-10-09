import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TriageMoveModal from './TriageMoveModal';

describe('TriageMoveModal', () => {
  it('renders with the seeded category and rename defaults', () => {
    render(
      <TriageMoveModal
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
        presets={['LIBRARY/Commands', 'LIBRARY/Docs']}
        defaultCategory="LIBRARY/Commands"
        defaultTitle="cap_seed_ab"
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Category' })).toHaveValue('LIBRARY/Commands');
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('cap_seed_ab');
  });

  it('Escape and Cancel close without confirming', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <TriageMoveModal
        isOpen
        onClose={onClose}
        onConfirm={onConfirm}
        presets={['LIBRARY/Docs']}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('confirm passes the exact category and new title; the modal itself stays open (caller closes)', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <TriageMoveModal
        isOpen
        onClose={onClose}
        onConfirm={onConfirm}
        presets={['LIBRARY/Commands']}
        defaultCategory="WORK"
        defaultTitle="cap_typed_ab"
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Category' }), {
      target: { value: 'WORK/Fixes' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'New name' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith('WORK/Fixes', 'New name');
    // Closing stays the caller's (async apply) job — a failed apply must keep
    // the dialog open, so confirm must not self-close.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('empty category disables Confirm and Enter (audit F5); typing re-enables', () => {
    const onConfirm = vi.fn();
    render(
      <TriageMoveModal isOpen onClose={() => {}} onConfirm={onConfirm} presets={['LIBRARY/Docs']} />,
    );
    const cat = screen.getByRole('textbox', { name: 'Category' });
    const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmBtn).toBeDisabled();
    fireEvent.keyDown(cat, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(cat, { target: { value: 'LIBRARY/Docs' } });
    expect(confirmBtn).toBeEnabled();
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledWith('LIBRARY/Docs', '');
  });

  it('clicking a preset chip fills the category input without confirming', () => {
    const onConfirm = vi.fn();
    render(
      <TriageMoveModal
        isOpen
        onClose={() => {}}
        onConfirm={onConfirm}
        presets={['LIBRARY/Commands', 'LIBRARY/Docs']}
        defaultCategory=""
        defaultTitle="t"
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Category' })).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'LIBRARY/Docs' }));
    expect(screen.getByRole('textbox', { name: 'Category' })).toHaveValue('LIBRARY/Docs');
    expect(onConfirm).not.toHaveBeenCalled();
  });
});