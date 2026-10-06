import { useEffect, useRef, useState } from 'react';

export function QuickCapture({ focusSignal, onSubmit }: { focusSignal: number; onSubmit: (text: string) => Promise<unknown> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  const submit = async () => {
    const text = value.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text);
      setValue('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="quick-capture">
      <input
        ref={inputRef}
        placeholder={`Capture (Ctrl+Shift+J)...`}
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {error && <div className="quick-capture-error">{error}</div>}
    </div>
  );
}