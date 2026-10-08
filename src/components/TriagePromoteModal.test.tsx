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

  // Task-4 review F1 (FIX-NOW): refreshAll re-sets `checklists` on every
  // sync-updated event and every 60s scheduler tick, so an open dialog can see
  // a boards-identity change at any moment — in-progress drafts must survive.
  it('a boards-identity change mid-dialog does NOT reset the drafts', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const props = { isOpen: true, onClose, onConfirm };
    const { rerender } = render(
      <TriagePromoteModal {...props} boards={boards} defaultText="grab bulbs" defaultTitle="Grab bulbs" />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Card text' }), {
      target: { value: 'Fix the fuse box' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Card title' }), {
      target: { value: 'Fuse box' },
    });
    // a background pull lands: fresh checklists array → fresh boards identity,
    // dialog stays open (isOpen unchanged)
    rerender(
      <TriagePromoteModal
        {...props}
        boards={[...boards, { id: 'b3', title: 'New board' }]}
        defaultText="grab bulbs"
        defaultTitle="Grab bulbs"
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Card text' })).toHaveValue('Fix the fuse box');
    expect(screen.getByRole('textbox', { name: 'Card title' })).toHaveValue('Fuse box');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // the OTHER half of the F1 edge contract: close → reopen still re-seeds the
  // drafts from the defaults (guard against an over-broad never-re-seed fix)
  it('closing and reopening re-seeds the drafts from the defaults', () => {
    const { rerender } = render(
      <TriagePromoteModal
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
        boards={boards}
        defaultText="grab bulbs"
        defaultTitle="Grab bulbs"
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Card text' }), {
      target: { value: 'user typed this' },
    });
    rerender(<TriagePromoteModal isOpen={false} onClose={() => {}} onConfirm={() => {}} boards={boards} />);
    rerender(
      <TriagePromoteModal isOpen onClose={() => {}} onConfirm={() => {}} boards={boards} defaultText="grab bulbs" defaultTitle="Grab bulbs" />,
    );
    expect(screen.getByRole('textbox', { name: 'Card text' })).toHaveValue('grab bulbs');
    expect(screen.getByRole('textbox', { name: 'Card title' })).toHaveValue('Grab bulbs');
  });
});
// ---- P3 Task 3: the additive defaultBoardId prefill (confident suggestions) ----
describe('TriagePromoteModal defaultBoardId prefill (P3 Task 3)', () => {
  it('default_board_id_prefills_board_choice: defaultBoardId=B selects B, not the first board', () => {
    render(
      <TriagePromoteModal
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
        boards={boards}
        defaultBoardId="b2"
      />,
    );
    expect(screen.getByRole('button', { name: 'Board' })).toHaveTextContent('Zeta board');
  });

  it('default_board_id_absent_falls_back_to_first_board: P2 byte-stable behavior (unresolved suggestion → boards[0])', () => {
    render(
      <TriagePromoteModal
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
        boards={boards}
        defaultBoardId={undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Board' })).toHaveTextContent('Maintenance');
    // and an id NOT among the boards also falls back to the first (defensive)
    render(
      <TriagePromoteModal
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
        boards={boards}
        defaultBoardId="no-such-id"
      />,
    );
    expect(screen.getAllByRole('button', { name: 'Board' })[1]).toHaveTextContent('Maintenance');
  });
});
