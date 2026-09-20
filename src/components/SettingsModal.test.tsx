import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import SettingsModal from './SettingsModal';
import { useStore } from '../stores/store';

beforeEach(() => {
  invoke.mockReset();
  useStore.setState({ updateInfo: null });
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

describe('SettingsModal updates', () => {
  it('shows the running version and checks for updates on demand', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_settings') return Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 });
      if (cmd === 'check_update') return Promise.resolve({ current: '0.6.1', latest: '0.7.0', available: true, rpmUrl: 'https://x/rpm' });
      return Promise.resolve(null);
    });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Check for updates'));
    await waitFor(() => expect(screen.getByText(/update available: 0\.7\.0/i)).toBeInTheDocument());
 expect(invoke).toHaveBeenCalledWith('check_update');
  });

  it('AI section loads stored settings and saves trimmed values', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_settings') return Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 });
      if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: 'https://ai.example.com', model: 'llama3', languageHint: 'en', apiPathSuffix: 'v1', hasKey: true });
      if (cmd === 'set_ai_settings') return Promise.resolve({ baseUrl: 'https://ai.example.com', model: 'llama3', languageHint: 'en', apiPathSuffix: 'v1', hasKey: true });
      return Promise.resolve(null);
    });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByPlaceholderText('https://ai.example.com')).toHaveValue('https://ai.example.com'));
    expect(screen.getByPlaceholderText('API key stored')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_ai_settings', {
      baseUrl: 'https://ai.example.com', model: 'llama3', languageHint: 'en', apiKey: null,
    }));
    await waitFor(() => expect(screen.getByText('AI settings saved.')).toBeInTheDocument());
  });

  it('AI test connection reports model count and populates the model dropdown', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_settings') return Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 });
      if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: 'https://ai.example.com', model: '', languageHint: '', apiPathSuffix: 'v1', hasKey: false });
      if (cmd === 'set_ai_settings') return Promise.resolve({ baseUrl: 'https://ai.example.com', model: '', languageHint: '', apiPathSuffix: 'v1', hasKey: true });
      if (cmd === 'ai_get_models') return Promise.resolve(['llama3', 'qwen2.5:7b']);
      return Promise.resolve(null);
    });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Test connection')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Test connection'));
    await waitFor(() => expect(screen.getByText('Connected — 2 model(s) available.')).toBeInTheDocument());
    expect(document.querySelector('#ai-model-list option[value="llama3"]')).not.toBeNull();
  });

  it('AI test connection failure surfaces the error', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_settings') return Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 });
      if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: '', model: '', languageHint: '', apiPathSuffix: 'v1', hasKey: false });
      if (cmd === 'set_ai_settings') return Promise.resolve({ baseUrl: '', model: '', languageHint: '', apiPathSuffix: 'v1', hasKey: false });
      if (cmd === 'ai_get_models') return Promise.reject(new Error('AI server not configured'));
      return Promise.resolve(null);
    });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Test connection')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Test connection'));
    await waitFor(() => expect(screen.getByText(/AI server not configured/)).toBeInTheDocument());
  });

  it('reports up to date when the release matches', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_settings') return Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 });
      if (cmd === 'check_update') return Promise.resolve({ current: '0.6.1', latest: '0.6.1', available: false, rpmUrl: null });
      return Promise.resolve(null);
    });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Check for updates'));
    await waitFor(() => expect(screen.getByText(/up to date/i)).toBeInTheDocument());
  });

  it('downloads, installs via dnf, and offers a restart', async () => {
    useStore.setState({ updateInfo: { current: '0.6.1', latest: '0.7.0', available: true, rpmUrl: 'https://x/rpm' } });
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_settings') return Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 });
      if (cmd === 'download_update') return Promise.resolve('/cache/updates/jotty-0.7.0.rpm');
      if (cmd === 'install_update') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    fireEvent.click(screen.getByText(/download & install/i));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('download_update', { url: 'https://x/rpm' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('install_update', { path: '/cache/updates/jotty-0.7.0.rpm' }));
    expect(await screen.findByText('Installed — restart to finish')).toBeInTheDocument();
  });

  it('surfaces update errors', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_settings') return Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 });
      if (cmd === 'check_update') return Promise.reject(new Error('release check failed: HTTP 403'));
      return Promise.resolve(null);
    });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Check for updates'));
    await waitFor(() => expect(screen.getByText(/release check failed/i)).toBeInTheDocument());
  });

  it('restart button invokes restart_app', async () => {
    useStore.setState({ updateInfo: { current: '0.7.0', latest: '0.7.0', available: false, rpmUrl: null } });
    invoke.mockImplementation((cmd: string) => cmd === 'get_settings' ? Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 }) : Promise.resolve(null));
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Restart'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('restart_app'));
  });
});