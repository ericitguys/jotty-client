import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import SyncBadge from './SyncBadge';
import { useStore } from '../stores/store';

beforeEach(() => {
  invoke.mockReset();
  useStore.setState({
    connection: null,
    syncStatus: { pending: 0, lastSyncAt: '2026-01-01T00:00:00.000Z', lastError: null, lastPullError: null, syncing: false },
    updateInfo: null,
    stalePieces: { categories: false, prefs: false, branding: false },
  });
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'list_conflicts') return Promise.resolve([]);
    return Promise.resolve(null);
  });
});

describe('SyncBadge error display', () => {
  it('prefers lastPullError over lastError in the error chip and title', () => {
    useStore.setState({ syncStatus: { pending: 0, lastSyncAt: '2026-01-01T00:00:00.000Z', lastError: 'push err', lastPullError: 'pull err', syncing: false } });
    render(<SyncBadge onOpenConflicts={() => {}} onOpenSettings={() => {}} />);
    const footer = document.querySelector('#sync-badge') as HTMLElement;
    expect(footer).toHaveAttribute('title', 'pull err');
    expect(screen.getByText(/pull err/)).toBeInTheDocument();
    expect(screen.queryByText(/push err/)).not.toBeInTheDocument();
  });

  it('falls back to lastError when lastPullError is null', () => {
    useStore.setState({ syncStatus: { pending: 0, lastSyncAt: '2026-01-01T00:00:00.000Z', lastError: 'push err', lastPullError: null, syncing: false } });
    render(<SyncBadge onOpenConflicts={() => {}} onOpenSettings={() => {}} />);
    expect(screen.getByText(/push err/)).toBeInTheDocument();
  });
});

describe('SyncBadge stale chip', () => {
  it('renders the stale chip when any stalePiece is true while online', () => {
    useStore.setState({ connection: { instanceUrl: 'http://srv', version: '1' }, stalePieces: { categories: true, prefs: false, branding: false } });
    render(<SyncBadge onOpenConflicts={() => {}} onOpenSettings={() => {}} />);
    expect(screen.getByText('· stale data')).toBeInTheDocument();
  });

  it('does not render the stale chip when no stalePiece is true', () => {
    useStore.setState({ connection: { instanceUrl: 'http://srv', version: '1' }, stalePieces: { categories: false, prefs: false, branding: false } });
    render(<SyncBadge onOpenConflicts={() => {}} onOpenSettings={() => {}} />);
    expect(screen.queryByText('· stale data')).not.toBeInTheDocument();
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
    const chip = await screen.findByText('0.7.0');
    fireEvent.click(chip);
    expect(openSettings).toHaveBeenCalled();
  });

  it('hides the chip when the release is not newer', () => {
    useStore.setState({ updateInfo: { current: '0.6.1', latest: '0.6.1', available: false, downloadUrl: null } });
    render(<SyncBadge onOpenConflicts={() => {}} onOpenSettings={() => {}} />);
    expect(document.querySelector('.update-chip')).not.toBeInTheDocument();
  });
});