import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import SettingsModal from './SettingsModal';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'connect_instance') return Promise.resolve({ instanceUrl: 'http://localhost:1122', version: '1.22.0' });
    if (cmd === 'get_settings') return Promise.resolve({ instanceUrl: 'http://localhost:1122', syncIntervalMinutes: 5 });
    return Promise.resolve(null);
  });
});

describe('SettingsModal onboarding', () => {
  it('calls connect_instance with url and key', async () => {
    render(<SettingsModal mode="onboarding" onClose={() => {}} onConnected={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('https://jotty.example.com'), { target: { value: 'http://localhost:1122' } });
    fireEvent.change(screen.getByPlaceholderText('ck_...'), { target: { value: 'ck_secret' } });
    fireEvent.click(screen.getByText('Connect'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('connect_instance', { url: 'http://localhost:1122', apiKey: 'ck_secret' }));
  });

  it('shows error when connection fails', async () => {
    invoke.mockImplementation((cmd: string) => cmd === 'connect_instance' ? Promise.reject(new Error('health check failed')) : Promise.resolve(null));
    render(<SettingsModal mode="onboarding" onClose={() => {}} onConnected={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('https://jotty.example.com'), { target: { value: 'http://localhost:1122' } });
    fireEvent.change(screen.getByPlaceholderText('ck_...'), { target: { value: 'ck_x' } });
    fireEvent.click(screen.getByText('Connect'));
    await waitFor(() => expect(screen.getByText(/health check failed/i)).toBeInTheDocument());
  });
});