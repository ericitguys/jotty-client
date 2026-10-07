import { describe, expect, it } from 'vitest';
import { isTriageRoute, TRIAGE_ROUTES, TRIAGE_MOVE_PRESET } from './routes';

describe('isTriageRoute', () => {
  it('accepts every member of the closed route set', () => {
    expect(isTriageRoute('TODO')).toBe(true);
    expect(isTriageRoute('COMMANDS')).toBe(true);
    expect(isTriageRoute('DOCS')).toBe(true);
    expect(isTriageRoute('NOISE')).toBe(true);
    for (const route of TRIAGE_ROUTES) expect(isTriageRoute(route)).toBe(true);
  });

  it('rejects an arbitrary string outside the closed set', () => {
    expect(isTriageRoute('ARCHIVE')).toBe(false);
    expect(isTriageRoute('')).toBe(false);
    expect(isTriageRoute('PROCESSED')).toBe(false);
  });

  it('is case-sensitive: lowercase spellings are not routes', () => {
    expect(isTriageRoute('todo')).toBe(false);
    expect(isTriageRoute('Todo')).toBe(false);
    expect(isTriageRoute('commands')).toBe(false);
  });

  it('rejects non-strings without throwing', () => {
    expect(isTriageRoute(null)).toBe(false);
    expect(isTriageRoute(undefined)).toBe(false);
    expect(isTriageRoute(42)).toBe(false);
    expect(isTriageRoute({})).toBe(false);
    expect(isTriageRoute(['TODO'])).toBe(false);
  });

  it('exposes the exact plan move presets', () => {
    expect(TRIAGE_MOVE_PRESET.COMMANDS).toBe('LIBRARY/Commands');
    expect(TRIAGE_MOVE_PRESET.DOCS).toBe('LIBRARY/Docs');
  });
});