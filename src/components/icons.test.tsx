// src/components/icons.test.tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Icon } from './icons';

const NAMES = ['mic', 'plus', 'search', 'settings', 'refresh', 'trash', 'x', 'check', 'note',
  'list', 'columns', 'calendar', 'bell', 'menu', 'back', 'arrow-up', 'clock', 'sun', 'more'] as const;

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
  it('sun + more ride copied-verbatim lucide path data (tier B task 1)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'icons.tsx'), 'utf8');
    // lucide 'sun': hub circle + 8 rays — each ray copied verbatim from lucide.dev
    expect(src).toContain('cx={12} cy={12} r={4}');
    expect(src).toContain('d="M12 2v2"');
    expect(src).toContain('d="M12 20v2"');
    expect(src).toContain('d="m4.93 4.93 1.41 1.41"');
    expect(src).toContain('d="m17.66 17.66 1.41 1.41"');
    expect(src).toContain('d="M2 12h2"');
    expect(src).toContain('d="M20 12h2"');
    expect(src).toContain('d="m6.34 17.66-1.41 1.41"');
    expect(src).toContain('d="m19.07 4.93-1.41 1.41"');
    // lucide 'more' (ellipsis): three r=1 stroke circles at cx 5/12/19, cy 12
    expect(src).toContain('<circle cx={12} cy={12} r={1} />');
    expect(src).toContain('<circle cx={19} cy={12} r={1} />');
    expect(src).toContain('<circle cx={5} cy={12} r={1} />');
    // provenance comment (rider d) names the copy event + license
    expect(src).toContain('COPIED VERBATIM');
    expect(src).toContain('ISC license');
  });
});