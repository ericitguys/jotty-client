import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import ChecklistList from './ChecklistList';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'create_checklist') {
      return Promise.resolve({ id: 'l9', title: 'New checklist', category: 'Uncategorized', createdAt: null, updatedAt: null, deletedAt: null, dirty: true, items: [] });
    }
    return Promise.resolve(null);
  });
});

describe('ChecklistList creation', () => {
  it('new checklist button calls create_checklist with default title and category', async () => {
    render(<ChecklistList checklists={[]} />);
    fireEvent.click(screen.getByText('+ New checklist'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_checklist', { title: 'New checklist', category: 'Uncategorized' }));
  });
});