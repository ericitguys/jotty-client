import { useEffect, useState } from 'react';
import * as api from '../api/client';
import { useStore } from '../stores/store';
import type { UpdateInfo, ThemeOverride } from '../api/types';

type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate' }
  | { kind: 'available' }
  | { kind: 'downloading' }
  | { kind: 'installing' }
  | { kind: 'installed' };

export default function SettingsModal({ mode, onClose, onConnected }: {
  mode: 'onboarding' | 'settings'; onClose: () => void; onConnected?: () => void;
}) {
  const { themeOverride, setThemeOverride } = useStore();
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [interval, setIntervalMin] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<{ instanceUrl: string | null; syncIntervalMinutes: number } | null>(null);
  const updateInfo = useStore((s) => s.updateInfo);
  const refreshUpdate = useStore((s) => s.refreshUpdate);
  const [phase, setPhase] = useState<UpdatePhase>({ kind: 'idle' });
  const [rpmPath, setRpmPath] = useState<string | null>(null);
  const [updateHint, setUpdateHint] = useState<string | null>(null);
  // Android: no pkexec/dnf — the guided flow hands the APK URL to the system
  // browser/Download Manager and the user installs via the system prompt.
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
  const [aiBase, setAiBase] = useState('');
  const [aiKey, setAiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiLang, setAiLang] = useState('');
  const [aiHas, setAiHas] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    if (mode !== 'settings') return;
    api.getSettings().then((data) => { if (data) setSettings(data); });
    api.getAiSettings().then((s) => {
      setAiBase(s.baseUrl); setAiModel(s.model); setAiLang(s.languageHint); setAiHas(s.hasKey);
      if (s.baseUrl && s.hasKey) {
        api.aiGetModels().then((m) => { if (Array.isArray(m)) setModels(m); }).catch(() => {});
      }
    }).catch(() => {});
  }, [mode]);

  const fmtErr = (e: unknown) => String(e).replace(/^.*Error: /, '');

  const persistAi = async () => {
    const s = await api.setAiSettings(aiBase.trim() || null, aiModel.trim() || null, aiLang.trim() || null, aiKey.trim() || null);
    setAiHas(s.hasKey); setAiKey('');
    return s;
  };

  const saveAi = async () => {
    setAiBusy(true); setError(null); setAiMsg(null);
    try { await persistAi(); setAiMsg('AI settings saved.'); }
    catch (e) { setError(fmtErr(e)); }
    finally { setAiBusy(false); }
  };

  const testAi = async () => {
    setAiBusy(true); setError(null); setAiMsg(null);
    try {
      await persistAi(); // the probe reads stored settings
      const m = await api.aiGetModels();
      setModels(Array.isArray(m) ? m : []);
      setAiMsg(`Connected — ${m.length} model(s) available.`);
    } catch (e) { setError(fmtErr(e)); }
    finally { setAiBusy(false); }
  };

  const connect = async () => {
    setBusy(true); setError(null);
    try {
      await api.connectInstance(url.trim(), key.trim());
      onConnected?.(); onClose();
    } catch (e) {
      setError(String(e).replace(/^.*Error: /, ''));
    } finally { setBusy(false); }
  };

  const check = async () => {
    setError(null); setPhase({ kind: 'checking' });
    try {
      const info: UpdateInfo = await api.checkUpdate();
      useStore.setState({ updateInfo: info });
      setPhase(info.available ? { kind: 'available' } : { kind: 'upToDate' });
    } catch (e) {
      setPhase({ kind: 'idle' });
      setError(String(e).replace(/^.*Error: /, ''));
    }
  };

  const runUpdate = async () => {
    const info = updateInfo;
    if (!info?.downloadUrl) return;
    setError(null);
    try {
      setPhase({ kind: 'downloading' });
      const path = await api.downloadUpdate(info.downloadUrl);
      setRpmPath(path);
      setPhase({ kind: 'installing' });
      await api.installUpdate(path);
      setPhase({ kind: 'installed' });
      // the installed release is now newer than what's running; refresh the
      // badge info so the chip doesn't claim an update is still pending
      useStore.setState({ updateInfo: { ...info, available: false } });
    } catch (e) {
      setPhase({ kind: 'available' });
      setError(String(e).replace(/^.*Error: /, ''));
    }
  };

  const openAndroidUpdate = async () => {
    const info = updateInfo;
    if (!info?.downloadUrl) return;
    setError(null);
    try {
      await api.openUpdateUrl(info.downloadUrl);
      setUpdateHint('Download started — when it finishes, tap the APK to install.');
    } catch (e) {
      setError(fmtErr(e));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{mode === 'onboarding' ? 'Connect to jotty' : 'Settings'}</h2>
        {mode === 'settings' && <p className="instance-url">{settings?.instanceUrl ?? 'not connected'}</p>}
        {mode === 'onboarding' && (
          <>
            <p>Generate an API key in your jotty web UI: Profile → Settings → API Key → Generate.</p>
            <input placeholder="https://jotty.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
            <input placeholder="ck_..." value={key} onChange={(e) => setKey(e.target.value)} type="password" />
            <button disabled={busy || !url || !key} onClick={connect}>{busy ? 'Connecting…' : 'Connect'}</button>
          </>
        )}
        {mode === 'settings' && (
          <>
            <label>Sync every <input type="number" min={1} value={interval} onChange={(e) => setIntervalMin(Number(e.target.value))} /> minutes</label>
            <button onClick={async () => { await api.setSyncInterval(interval); }}>Save interval</button>
            <button onClick={async () => { await api.disconnectInstance(); onClose(); }}>Disconnect</button>
            <div className="appearance-settings">
              <h3>Appearance</h3>
              <label htmlFor="theme-select">Theme</label>
              <select
                id="theme-select"
                value={themeOverride ?? 'auto'}
                onChange={(e) => {
                  const v = e.target.value as ThemeOverride;
                  setThemeOverride(v === 'auto' ? null : v);
                }}
              >
                <option value="auto">Follow site</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="rwmarkable-dark">Blue (rwMarkable dark)</option>
              </select>
              <p className="voice-hint">Follow site mirrors your jotty instance's theme.</p>
            </div>
            <div className="ai-settings">
              <h3>AI server (OpenWebUI)</h3>
              <input placeholder="https://ai.example.com" value={aiBase} onChange={(e) => setAiBase(e.target.value)} />
              <input placeholder={aiHas ? 'API key stored' : 'sk-...'} value={aiKey} onChange={(e) => setAiKey(e.target.value)} type="password" />
              <input list="ai-model-list" placeholder="Tidy model" value={aiModel} onChange={(e) => setAiModel(e.target.value)} />
              <datalist id="ai-model-list">{models.map((m) => <option key={m} value={m} />)}</datalist>
              <input placeholder="Language hint (optional, e.g. en)" value={aiLang} onChange={(e) => setAiLang(e.target.value)} />
              <div className="voice-actions">
                <button onClick={saveAi} disabled={aiBusy}>{aiBusy ? 'Working…' : 'Save'}</button>
                <button onClick={testAi} disabled={aiBusy}>Test connection</button>
              </div>
              {aiMsg && <p className="voice-hint">{aiMsg}</p>}
            </div>
            <div className="updater">
              <span className="updater-version">Version {updateInfo?.current ?? 'unknown'}</span>
              {phase.kind === 'checking' && <span>Checking…</span>}
              {phase.kind === 'upToDate' && <span className="updater-ok">Up to date</span>}
              {phase.kind === 'available' && (
                <>
                  <span className="updater-avail">Update available: {updateInfo?.latest}</span>
                  {isAndroid
                    ? <button onClick={openAndroidUpdate} disabled={!updateInfo?.downloadUrl}>Open download</button>
                    : <button onClick={runUpdate} disabled={!updateInfo?.downloadUrl}>Download &amp; install</button>}
                </>
              )}
              {updateHint && <span className="updater-ok">{updateHint}</span>}
              {phase.kind === 'downloading' && <span>Downloading…</span>}
              {phase.kind === 'installing' && <span>Installing (confirm in the password dialog)…</span>}
              {phase.kind === 'installed' && <span className="updater-ok">Installed — restart to finish</span>}
              {phase.kind === 'idle' && updateInfo?.available && (
                isAndroid
                  ? <button onClick={openAndroidUpdate} disabled={!updateInfo.downloadUrl}>Open download</button>
                  : <button onClick={runUpdate} disabled={!updateInfo.downloadUrl}>Download &amp; install</button>
              )}
              <button onClick={check}>Check for updates</button>
              <button onClick={() => api.restartApp()}>Restart</button>
            </div>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}