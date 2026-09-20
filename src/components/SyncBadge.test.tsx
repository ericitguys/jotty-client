import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import SyncBadge from './SyncBadge';
import { useStore } from '../stores/store';

beforeEach(() => {
  invoke.mockReset();
  useStore.setState({ syncStatus: { pending: 0, lastSyncAt: '2026-01-01T00:00:00.000Z', lastError: null, syncing: false }, updateInfo: null });
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'list_conflicts') return Promise.resolve([]);
    return Promise.resolve(null);
  });
});

describe('SyncBadge update chip', () => {
  it('renders nothing about updates when no update info', () => {
    render(<SyncBadge onOpenConflicts={() => {}} onOpenSettings={() => {}} />);
    expect(screen.queryByText(/update/i)).not.toBeInTheDocument();
  });

  it('shows an update chip for the new version and opens settings on click', async () => {
    useStore.setState({ updateInfo: { current: '0.6.1', latest: '0.7.0', available: true, downloadUrl: 'https://x.rpm' } });
    const openSettings = vi.fn();
    render(<SyncBadge onOpenConflicts={() => {}} onOpenSettings={openSettings} />);
    const chip = await screen.findByText('⬆ 0.7.0');
    fireEvent.click(chip);
    expect(openSettings).toHaveBeenCalled();
  });

  it('hides the chip when the release is not newer', () => {
    useStore.setState({ updateInfo: { current: '0.6.1', latest: '0.6.1', available: false, downloadUrl: null } });
    render(<SyncBadge onOpenConflicts={() => {}} onOpenSettings={() => {}} />);
    expect(screen.queryByText(/⬆/)).not.toBeInTheDocument();
  });
});