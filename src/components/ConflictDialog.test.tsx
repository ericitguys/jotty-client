import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import ConflictDialog from './ConflictDialog';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'list_conflicts') return Promise.resolve([{ seq: 7, entity: 'note', entityId: 'n1', opType: 'delete', lastError: '404', label: 'My Note' }]);
    if (cmd === 'resolve_conflict') return Promise.resolve(null);
    return Promise.resolve(null);
  });
});

describe('ConflictDialog', () => {
  it('lists conflicts and resolves keep-mine', async () => {
    render(<ConflictDialog onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('My Note')).toBeInTheDocument());
    fireEvent.click(screen.getByText('keep mine'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('resolve_conflict', { seq: 7, keep: 'mine' }));
  });
});