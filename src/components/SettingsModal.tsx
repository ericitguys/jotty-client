import { useState } from 'react';
import * as api from '../api/client';

export default function SettingsModal({ mode, onClose, onConnected }: {
  mode: 'onboarding' | 'settings'; onClose: () => void; onConnected?: () => void;
}) {
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [interval, setIntervalMin] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true); setError(null);
    try {
      await api.connectInstance(url.trim(), key.trim());
      onConnected?.(); onClose();
    } catch (e) {
      setError(String(e).replace(/^.*Error: /, ''));
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{mode === 'onboarding' ? 'Connect to jotty' : 'Settings'}</h2>
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
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}