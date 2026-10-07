import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TriagePromoteModal from './TriagePromoteModal';

// Board fixture order is deliberately NOT title-asc: the view sorts before
// passing boards in; the modal only pins which board starts selected (first).
const boards = [
  { id: 'b1', title: 'Maintenance' },
  { id: 'b2', title: 'Zeta board' },
];

describe('TriagePromoteModal', () => {
  it('renders with the seeded card text/title defaults and the first board preselected', () => {
    render(
      <TriagePromoteModal
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
        boards={boards}
        defaultText="grab bulbs"
        defaultTitle="Grab bulbs"
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Card text' })).toHaveValue('grab bulbs');
    expect(screen.getByRole('textbox', { name: 'Card title' })).toHaveValue('Grab bulbs');
    expect(screen.getByRole('button', { name: 'Board' })).toHaveTextContent('Maintenance');
  });

  it('Escape and Cancel close without confirming', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <TriagePromoteModal isOpen onClose={onClose} onConfirm={onConfirm} boards={boards} />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('confirm passes the exact board id, card text, and title; also on Enter; the modal itself stays open (caller closes)', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <TriagePromoteModal
        isOpen
        onClose={onClose}
        onConfirm={onConfirm}
        boards={boards}
        defaultText="grab bulbs"
        defaultTitle="Grab bulbs"
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Card text' }), {
      target: { value: 'Fix the fuse box' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Card title' }), {
      target: { value: 'Fuse box' },
    });
    // Pick the OTHER board through the dropdown to prove onChange feeds state.
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    fireEvent.click(screen.getByRole('option', { name: 'Zeta board' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenNthCalledWith(1, 'b2', 'Fix the fuse box', 'Fuse box');
    // Closing stays the caller's (async apply) job — a failed apply must keep
    // the dialog open, so confirm must not self-close.
    expect(onClose).not.toHaveBeenCalled();
    // Enter on an input confirms too (PromptModal behavior law).
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Card title' }), { key: 'Enter' });
    expect(onConfirm).toHaveBeenNthCalledWith(2, 'b2', 'Fix the fuse box', 'Fuse box');
  });

  it('no boards: placeholder line replaces the dropdown and the confirm is disabled', () => {
    const onConfirm = vi.fn();
    render(<TriagePromoteModal isOpen onClose={() => {}} onConfirm={onConfirm} boards={[]} />);
    expect(screen.getByText('No kanban boards yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders the error line inside the dialog when error is set', () => {
    render(
      <TriagePromoteModal
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
        boards={boards}
        error="stale: note no longer exists"
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('stale: note no longer exists')).toHaveClass('triage-error');
  });
});