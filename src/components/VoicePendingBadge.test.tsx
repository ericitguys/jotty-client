import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

// listen: typed loosely so tests can pull the registered handler per call —
// the mock's parameter type stays unknown-based (TS2556 class from the tight
// `vi.fn(async () => ...)` zero-arg signature).
const listen = vi.fn(async (..._a: readonly unknown[]) => async () => {});
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...a) }));

import VoicePendingBadge from './VoicePendingBadge';

beforeEach(() => {
  invoke.mockReset();
  listen.mockClear();
});

const handlers = () => listen.mock.calls.map((c) => c[1]) as Array<() => void>;

describe('VoicePendingBadge', () => {
  it('hidden while the count is 0', async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === 'voice_get_pending_transcriptions' ? Promise.resolve(0) : Promise.resolve(null),
    );
    render(<VoicePendingBadge />);
    expect(invoke).toHaveBeenCalledWith('voice_get_pending_transcriptions');
    await waitFor(() => expect(screen.queryByTestId('voice-pending-chip')).not.toBeInTheDocument());
  });

  it('hides entirely while the count is unknown (command failed)', async () => {
    invoke.mockImplementation(() => Promise.reject(new Error('down')));
    render(<VoicePendingBadge />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_get_pending_transcriptions'));
    expect(screen.queryByTestId('voice-pending-chip')).not.toBeInTheDocument();
  });

  it('shows the count with a plain-language tooltip', async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === 'voice_get_pending_transcriptions' ? Promise.resolve(2) : Promise.resolve(null),
    );
    render(<VoicePendingBadge />);
    const chip = await screen.findByTestId('voice-pending-chip');
    expect(chip).toHaveTextContent('2 waiting to transcribe');
    expect(chip).toHaveAttribute('title', expect.stringContaining('retry automatically'));
  });

  it('refreshes on the voice-updated event (retry pass ran)', async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === 'voice_get_pending_transcriptions' ? Promise.resolve(2) : Promise.resolve(null),
    );
    render(<VoicePendingBadge />);
    await screen.findByTestId('voice-pending-chip');
    invoke.mockImplementation((cmd: string) =>
      cmd === 'voice_get_pending_transcriptions' ? Promise.resolve(3) : Promise.resolve(null),
    );
    const hs = handlers();
    expect(hs).toHaveLength(2); // voice-updated + sync-updated
    hs[0]();
    await waitFor(() => expect(screen.getByTestId('voice-pending-chip')).toHaveTextContent('3 waiting'));
  });

  it('drops back to hidden once everything transcribed (count returns to 0)', async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === 'voice_get_pending_transcriptions' ? Promise.resolve(1) : Promise.resolve(null),
    );
    render(<VoicePendingBadge />);
    await screen.findByTestId('voice-pending-chip');
    invoke.mockImplementation((cmd: string) =>
      cmd === 'voice_get_pending_transcriptions' ? Promise.resolve(0) : Promise.resolve(null),
    );
    const hs = handlers();
    fireEvent(window, new Event('voice-updated')); // real event path too
    hs[1](); // sync-updated registration
    await waitFor(() => expect(screen.queryByTestId('voice-pending-chip')).not.toBeInTheDocument());
  });
});