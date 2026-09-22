import '@testing-library/jest-dom/vitest';

// Node 25+/26 removed jsdom's localStorage shim (jsdom can't attach it in the new
// node internals). Tests that touch localStorage (theme override) need a real
// in-memory implementation — jsdom alone no longer provides one.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  const ls: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => { store.delete(k); },
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: ls, configurable: true });
}