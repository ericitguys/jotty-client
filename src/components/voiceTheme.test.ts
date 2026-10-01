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

// Task 5 fences keep the RULE shape but run on a COMMENT-STRIPPED copy and use
// a LINE-ANCHORED lookup (ChecklistView.test.tsx 'column-idiomatic' pattern):
// a bare indexOf('.modal') would alias the '.modal-backdrop' block that
// precedes it in styles.css.
describe('ux polish task 5 — static CSS ledger (modal scroll, agenda meta, riders R1/R2/R4/R7)', () => {
  const css5 = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel: string) => {
    const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{`).exec(css5);
    expect(m, `${sel} exists`).not.toBeNull();
    const braces = css5.indexOf('{', m!.index);
    return css5.slice(braces + 1, css5.indexOf('}', braces));
  };

  it('settings modal scrolls internally instead of floating content past the viewport', () => {
    const block = rule('.modal');
    expect(block).toContain('max-height: min(76vh, 640px)');
    expect(block).toContain('overflow');
  });

  it('the scroll region is the modal body: overflow lives there, the h2 stays pinned', () => {
    const block = rule('.modal-body');
    expect(block).toContain('overflow: auto');
    expect(block).toContain('min-height: 0');
  });

  it('agenda meta spans keep layout-only rules — typography rides the shared .meta-line rule (L9)', () => {
    expect(rule('.meta-line')).toContain('font-size: 11.5px');
    const list = rule('.agenda-list');
    expect(list).toContain('margin-left: auto');
    expect(list).not.toContain('font-size'); // a re-pinned 12px would fight the shared rule
  });

  it('R1: sidebar selected rows read as the soft tint; the section toggle keeps full accent', () => {
    const sel = rule('#sidebar li.selected');
    expect(sel).toContain('background: var(--accent-soft)');
    expect(sel).toContain('var(--accent-strong-text)');
    expect(sel).not.toContain('#fff');
    expect(rule('li.selected .count')).toContain('var(--accent-strong-text)');
    expect(rule('#sidebar .sec-toggle.selected')).toContain('background: var(--accent)');
  });

  it('R2: h2 section labels sit at the L2 small-caps size (10.5px + .09em tracking)', () => {
    const h2 = rule('h2');
    expect(h2).toContain('font-size: 10.5px');
    expect(h2).toContain('letter-spacing: 0.09em');
  });

  it('R4: .row-age right-aligns on the meta line', () => {
    const age = rule('.row-age');
    expect(age).toContain('margin-left: auto');
    expect(age).toContain('flex-shrink: 0');
  });

  it("R7: the strike rule is scoped to the item's own row-line (unscoped descendant dies)", () => {
    const sel = '#checklist-view li.completed-item > .row-line .item-text';
    expect(css5).toContain(`${sel} {`);
    const b = css5.indexOf(sel);
    const block = css5.slice(css5.indexOf('{', b) + 1, css5.indexOf('}', b));
    expect(block).toContain('line-through');
    // regression literal: the old UNSCOPED form struck open children of done parents
    expect(css5).not.toContain('#checklist-view li.completed-item .item-text');
  });
});

const cssStripped = () => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('tier B motion tokens (task 1)', () => {
  it('duration + ease tokens exist in :root', () => {
    const root = RULE(':root');
    expect(root).toContain('--motion-fast: 120ms');
    expect(root).toContain('--motion-med: 180ms');
    expect(root).toContain('--ease-out: cubic-bezier(0.2, 0, 0, 1)');
  });
  it('fast-motion surfaces: menus + editor overlays transition on the fast token', () => {
    for (const sel of ['.jotty-dropdown-menu', '.kanban-menu', '.edt-slash-menu', '.edt-bubble', '.edt-tablebar']) {
      const rule = RULE(sel);
      expect(rule).toMatch(/transition:[^;]*var\(--motion-fast\)/);
    }
  });
  it('med-motion surfaces: modal + backdrop + drawer transition on the med token', () => {
    for (const sel of ['.modal', '.modal-backdrop', '.drawer']) {
      const rule = RULE(sel);
      expect(rule).toMatch(/transition:[^;]*var\(--motion-med\)/);
    }
  });
  it('cards + li.selected transition colors only (no transform/movement)', () => {
    const card = RULE('.kanban-card');
    expect(card).toMatch(/transition:[^;]*(background-color|box-shadow)/);
    expect(card).not.toMatch(/transition:[^;]*transform/);
  });
  it('NO layout-property transitions anywhere in the sheet', () => {
    for (const m of cssStripped().matchAll(/transition(?:-property)?\s*:[^;}]*/g)) {
      expect(m[0]).not.toMatch(/\b(width|height|top|left|margin)\b/);
    }
  });
  it('NO @keyframes anywhere', () => {
    expect(cssStripped()).not.toContain('@keyframes');
  });
  it('reduced-motion layers exist (OS + in-app)', () => {
    const s = cssStripped();
    expect(s).toContain('@media (prefers-reduced-motion: reduce)');
    expect(s).toContain('[data-reduce-motion="true"]');
  });
});