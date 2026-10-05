import { useEffect } from 'react';
import { sweepRecurrence } from '../api/client';

// Mirrors the upstream 60s reminder-scanner cadence and the VoicePendingBadge
// interval shape: immediate sweep on mount + interval, cleared on unmount.
export default function RecurrenceSweepTimer() {
  useEffect(() => {
    // Promise.resolve passthrough (identity for native Promises) keeps the
    // chain safe when the mocked invoke returns undefined in tests.
    void Promise.resolve(sweepRecurrence()).catch(() => {});
    const t = setInterval(() => { void Promise.resolve(sweepRecurrence()).catch(() => {}); }, 60_000);
    return () => { clearInterval(t); };
  }, []);
  return null;
}