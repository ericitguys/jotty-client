import { useEffect, useState } from 'react';
import * as api from '../api/client';
import { useStore } from '../stores/store';
import type { UpdateInfo } from '../api/types';

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

  useEffect(() => {
    if (mode !== 'settings') return;
    api.getSettings().then((data) => { if (data) setSettings(data); });
  }, [mode]);

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
    if (!info?.rpmUrl) return;
    setError(null);
    try {
      setPhase({ kind: 'downloading' });
      const path = await api.downloadUpdate(info.rpmUrl);
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
            <div className="updater">
              <span className="updater-version">Version {updateInfo?.current ?? 'unknown'}</span>
              {phase.kind === 'checking' && <span>Checking…</span>}
              {phase.kind === 'upToDate' && <span className="updater-ok">Up to date</span>}
              {phase.kind === 'available' && (
                <>
                  <span className="updater-avail">Update available: {updateInfo?.latest}</span>
                  <button onClick={runUpdate} disabled={!updateInfo?.rpmUrl}>Download &amp; install</button>
                </>
              )}
              {phase.kind === 'downloading' && <span>Downloading…</span>}
              {phase.kind === 'installing' && <span>Installing (confirm in the password dialog)…</span>}
              {phase.kind === 'installed' && <span className="updater-ok">Installed — restart to finish</span>}
              {phase.kind === 'idle' && updateInfo?.available && (
                <button onClick={runUpdate} disabled={!updateInfo.rpmUrl}>Download &amp; install</button>
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