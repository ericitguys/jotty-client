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
      if (cmd === 'check_update') return Promise.resolve({ current: '0.6.1', latest: '0.7.0', available: true, downloadUrl: 'https://x/rpm' });
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
      if (cmd === 'check_update') return Promise.resolve({ current: '0.6.1', latest: '0.6.1', available: false, downloadUrl: null });
      return Promise.resolve(null);
    });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Check for updates'));
    await waitFor(() => expect(screen.getByText(/up to date/i)).toBeInTheDocument());
  });

  it('downloads, installs via dnf, and offers a restart', async () => {
    useStore.setState({ updateInfo: { current: '0.6.1', latest: '0.7.0', available: true, downloadUrl: 'https://x/rpm' } });
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

  it('android: update available opens the apk download url in the browser', async () => {
    // jsdom's default UA is desktop — override to simulate the Android webview
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Linux; Android 16) Chrome/120 Mobile Safari/537.36' });
    useStore.setState({ updateInfo: { current: '0.10.1', latest: 'v0.10.2-android-preview', available: true, downloadUrl: 'https://x/jotty.apk' } });
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_settings') return Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 });
      return Promise.resolve(null);
    });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Open download'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_update_url', { url: 'https://x/jotty.apk' }));
    await waitFor(() => expect(screen.getByText(/tap the apk to install/i)).toBeInTheDocument());
    expect(invoke).not.toHaveBeenCalledWith('download_update', expect.anything());
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'jsdom' }); // restore
  });

  it('restart button invokes restart_app', async () => {
    useStore.setState({ updateInfo: { current: '0.7.0', latest: '0.7.0', available: false, downloadUrl: null } });
    invoke.mockImplementation((cmd: string) => cmd === 'get_settings' ? Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 }) : Promise.resolve(null));
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Restart'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('restart_app'));
  });
});

describe('SettingsModal appearance (theme picker)', () => {
  it('renders the theme dropdown with follow-site, dark, light, and blue options', async () => {
    invoke.mockImplementation((cmd: string) => cmd === 'get_settings' ? Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 }) : Promise.resolve(null));
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Theme' })).toHaveTextContent('Follow site'); // default: follow the site
    fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
    const menu = await screen.findByRole('listbox');
    expect([...menu.querySelectorAll('[role="option"] > span:last-child')].map((o) => o.textContent))
      .toEqual(['Follow site', 'Dark', 'Light', 'Blue (rwMarkable dark)']);
  });

  it('picking a theme applies it immediately (store + localStorage)', () => {
    invoke.mockImplementation((cmd: string) => cmd === 'get_settings' ? Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 }) : Promise.resolve(null));
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
    open();
    fireEvent.click(screen.getByText('Blue (rwMarkable dark)'));
    expect(useStore.getState().themeOverride).toBe('rwmarkable-dark');
    expect(localStorage.getItem('jotty.theme-override')).toBe('rwmarkable-dark');
    open();
    fireEvent.click(screen.getByText('Follow site'));
    expect(useStore.getState().themeOverride).toBe(null);
    expect(localStorage.getItem('jotty.theme-override')).toBe(null);
  });
});

describe('SettingsModal launcher branding (desktop)', () => {
  const branding = { name: 'Acme Notes', iconDataUrl: 'data:image/png;base64,AAA', themeColor: null };
  const mockStatus = (supported: boolean, active = false) => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_settings') return Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 });
      if (cmd === 'branding_desktop_status') return Promise.resolve({ supported, active });
      if (cmd === 'branding_desktop_apply') return Promise.resolve('/home/u/.local/share/applications/jotty-desktop.desktop');
      if (cmd === 'branding_desktop_remove') return Promise.resolve(null);
      return Promise.resolve(null);
    });
  };

  it('shows the toggle when supported and the server has branding; apply passes name + icon', async () => {
    mockStatus(true, false);
    useStore.setState({ branding });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Brand this installation' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('branding_desktop_apply', { name: 'Acme Notes', iconDataUrl: 'data:image/png;base64,AAA' }));
    expect(await screen.findByText(/Menu entry updated/i)).toBeInTheDocument();
  });

  it('active state offers Restore default and calls remove', async () => {
    mockStatus(true, true);
    useStore.setState({ branding });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore default' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('branding_desktop_remove'));
  });

  it('hidden when unsupported (Android) or when the server has no branding', async () => {
    mockStatus(false, false);
    useStore.setState({ branding });
    const r1 = render(<SettingsModal mode="settings" onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Brand this installation' })).toBeNull());
    r1.unmount();
    mockStatus(true, false);
    useStore.setState({ branding: { name: null, iconDataUrl: null, themeColor: null } });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Brand this installation' })).toBeNull());
  });
});

// v0.22.3 — the user's exact report: a typed language hint ("en") could never be
// REMOVED — emptying the field + Save sent null (backend = don't-touch), so the
// stored value reappeared on every reopening. Contract: the three text fields
// (base URL / tidy model / language hint) send their true UI value — '' clears;
// the masked API-key field alone keeps null = don't-touch (its empty UI state
// means "keep the stored key").
describe('SettingsModal AI settings: empty-field clears persist', () => {
  const aiDto = {
    baseUrl: 'https://ai.example.com',
    model: 'gemma3',
    languageHint: 'en',
    apiPathSuffix: 'v1',
    hasKey: true,
  };
  beforeEach(() => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_settings') return Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 });
      if (cmd === 'get_ai_settings') return Promise.resolve(aiDto);
      if (cmd === 'branding_desktop_status') return Promise.resolve({ supported: false, active: false });
      if (cmd === 'set_ai_settings') return Promise.resolve({ ...aiDto, languageHint: '', hasKey: true });
      return Promise.resolve(null);
    });
  });

  it('clearing the language hint sends languageHint: "" (not null) and saves', async () => {
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    const hint = await screen.findByPlaceholderText('Language hint (optional, e.g. en)') as HTMLInputElement;
    await waitFor(() => expect(hint).toHaveValue('en'));
    fireEvent.change(hint, { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('set_ai_settings', expect.objectContaining({ languageHint: '' })),
    );
    await waitFor(() => expect(screen.getByText('AI settings saved.')).toBeInTheDocument());
  });

  it('clearing the tidy model sends model: "" the same way', async () => {
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    await screen.findByPlaceholderText('Language hint (optional, e.g. en)');
    fireEvent.change(screen.getByPlaceholderText('Tidy model'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('set_ai_settings', expect.objectContaining({ model: '' })),
    );
  });

  it('an untouched masked API key still sends null (never deletes the stored key)', async () => {
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    await screen.findByPlaceholderText('Language hint (optional, e.g. en)');
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('set_ai_settings', expect.objectContaining({ apiKey: null })),
    );
  });
});

describe('SettingsModal scroll wrapper (tier A task 5, L9)', () => {
  it('the modal sections live inside the .modal-body scroll wrapper; the h2 stays pinned outside it', () => {
    invoke.mockImplementation((cmd: string) => cmd === 'get_settings' ? Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 }) : Promise.resolve(null));
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    const modal = document.querySelector('.modal') as HTMLElement | null;
    expect(modal).not.toBeNull();
    const body = modal!.querySelector('.modal-body') as HTMLElement | null;
    expect(body).not.toBeNull();
    expect(body!.querySelector('.ai-settings')).not.toBeNull();
    expect(body!.querySelector('h2')).toBeNull(); // section header pinned OUTSIDE the scroll region
    expect(modal!.querySelector('h2')).not.toBeNull();
  });

  it('onboarding mode wraps the same way (wrapper is structural, mode-independent)', () => {
    invoke.mockImplementation((cmd: string) => Promise.resolve(null));
    render(<SettingsModal mode="onboarding" onClose={() => {}} />);
    const modal = document.querySelector('.modal') as HTMLElement | null;
    expect(modal!.querySelector('.modal-body')).not.toBeNull();
    expect(modal!.querySelector('h2')!.textContent).toBe('Connect to jotty');
  });
});

describe('reduce motion setting (tier B task 1)', () => {
  it('checkbox writes the store + localStorage key (on → set, off → removed)', async () => {
    const { useStore } = await import('../stores/store');
    useStore.setState({ reduceMotion: false });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    const box = screen.getByLabelText('Reduce motion');
    fireEvent.click(box);
    expect(useStore.getState().reduceMotion).toBe(true);
    expect(window.localStorage.getItem('jotty.reduce-motion')).toBe('true');
    fireEvent.click(box);
    expect(useStore.getState().reduceMotion).toBe(false);
    expect(window.localStorage.getItem('jotty.reduce-motion')).toBeNull();
  });
});
