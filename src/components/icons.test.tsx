// src/components/icons.test.tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Icon } from './icons';

const NAMES = ['mic', 'plus', 'search', 'settings', 'refresh', 'trash', 'x', 'check', 'note',
  'list', 'columns', 'calendar', 'bell', 'menu', 'back', 'arrow-up', 'clock'] as const;

describe('Icon module', () => {
  it('renders every name as a stroke-based 24-viewBox svg', () => {
    for (const name of NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector('svg');
      expect(svg, name).not.toBeNull();
      expect(svg!.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg!.getAttribute('fill')).toBe('none');
      expect(svg!.getAttribute('stroke')).toBe('currentColor');
      expect(svg!.getAttribute('width')).toBe('15');
      unmount();
    }
  });
  it('size and strokeWidth props flow through', () => {
    const { container } = render(<Icon name="check" size={20} strokeWidth={2.2} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.getAttribute('stroke-width')).toBe('2.2');
  });
  it('className rides the svg', () => {
    const { container } = render(<Icon name="mic" className="mic-badge" />);
    expect(container.querySelector('svg.mic-badge')).not.toBeNull();
  });
  it('no emoji glyphs survive in the icon module source', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'icons.tsx'), 'utf8');
    expect(src).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});