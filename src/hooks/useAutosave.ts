import { useEffect, useRef, useState } from 'react';

export function useAutosave<T>(save: (v: T) => Promise<void>, delayMs = 800) {
  const [value, setValue] = useState<T | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<T | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    latest.current = value;
  }, [value]);

  useEffect(() => {
    return () => {
      // flush on unmount
      if (timer.current) clearTimeout(timer.current);
      if (latest.current) void saveRef.current(latest.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (v: T) => {
    setValue(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setSaving(true);
      try { await saveRef.current(v); } finally { setSaving(false); }
    }, delayMs);
  };

  const reset = (v: T) => {
    if (timer.current) {
      // pending edit belongs to the note saveRef still points at — flush it first
      if (latest.current) void saveRef.current(latest.current);
      clearTimeout(timer.current);
    }
    timer.current = null;
    setValue(v);
    latest.current = v;
  };

  // commit an armed edit immediately (explicit Save); debounced save is cancelled
  const flush = async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (latest.current) await saveRef.current(latest.current);
  };

  return { value, setValue: set, reset, flush, saving };
}
