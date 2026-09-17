import { useEffect, useRef, useState } from 'react';

export function useAutosave<T>(save: (v: T) => Promise<void>, delayMs = 800) {
  const [value, setValue] = useState<T | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<T | null>(null);

  useEffect(() => {
    latest.current = value;
  }, [value]);

  useEffect(() => {
    return () => {
      // flush on unmount
      if (timer.current) clearTimeout(timer.current);
      if (latest.current) void save(latest.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (v: T) => {
    setValue(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setSaving(true);
      try { await save(v); } finally { setSaving(false); }
    }, delayMs);
  };

  return { value, setValue: set, saving };
}
