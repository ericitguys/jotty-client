import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Theme + layout fences (v0.22.0 field reports: the voice review row kept its
// purple fill under the blue theme and overflowed the 412px phone viewport).
// These are STATIC TOKEN CHECKS against styles.css because jsdom does no
// layout — the wrap behavior itself gets verified by the pixel-probe harness
// (references/android-preview-history.md pattern) at ship time.

const here = dirname(fileURLToPath(import.meta.url));

const css = readFileSync(join(here, '..', 'styles.css'), 'utf8');
const RULE = (sel: string) => {
  const idx = css.indexOf(sel);
  expect(idx, `${sel} exists`).toBeGreaterThan(-1);
  const braces = css.indexOf('{', idx);
  const end = css.indexOf('}', braces);
  return css.slice(braces + 1, end);
};

describe('offline-voice field reports (2026-09-30): theme + wrap', () => {
  it('voice action buttons use the THEME accent, never the un-themed purple fallback', () => {
    for (const sel of [
      '.voice-actions .primary',
      '.voice-toggle .selected',
      '.kanban-add-actions .kanban-add-confirm',
    ]) {
      const rule = RULE(sel);
      expect(rule, `${sel} must use --accent (themeable)`).toContain('var(--accent)');
      // regression literal class: any hard-coded fallback purple = bug
      expect(rule, `${sel} must not carry a #9d5ffe fallback`).not.toContain('#9d5ffe');
    }
  });

  it('the review action row wraps instead of pushing buttons out of the modal', () => {
    expect(RULE('.voice-actions')).toContain('flex-wrap');
  });
});

describe('ux polish (tier A) static token fences', () => {
  it('elevation tokens exist and popovers live on the surface layer', () => {
    expect(css).toContain('--shadow-2');
    const rule = RULE('.jotty-dropdown-menu');
    expect(rule).toContain('var(--surface)');
    expect(rule).toContain('var(--shadow-2)');
  });
  it('base button hover no longer re-borders with the accent', () => {
    const block = RULE('button:hover');
    expect(block).not.toContain('border-color: var(--accent)');
  });
  it('selected list rows carry the inset accent bar', () => {
    expect(css).toContain('#notes li.selected::before');
    expect(RULE('#notes li.selected::before, #checklists li.selected::before'))
      .toContain('var(--accent)');
  });
  it('kanban cards separate from the column by elevation', () => {
    expect(RULE('.kanban-card')).toContain('var(--surface)');
  });
});