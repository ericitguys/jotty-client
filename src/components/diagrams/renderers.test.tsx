import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderMermaidToSvg } from './diagramUtils';
import { DrawioRenderer } from './DrawioRenderer';
import { ExcalidrawRenderer } from './ExcalidrawRenderer';
import { MermaidRenderer } from './MermaidRenderer';

vi.mock('./diagramUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./diagramUtils')>()),
  renderMermaidToSvg: vi.fn(async (code: string) => `<svg>mermaid-${code}</svg>`),
}));

describe('MermaidRenderer (portal MermaidRenderer.tsx parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('renders the code through the (guarded) mermaid pipeline', async () => {
    render(<MermaidRenderer code="graph TD; A-->B;" />);
    await waitFor(() => expect(screen.getByText('mermaid-graph TD; A-->B;')).toBeTruthy());
    expect(document.querySelector('.diagram-error-box')).toBeNull();
    expect(renderMermaidToSvg).toHaveBeenCalledWith('graph TD; A-->B;');
  });

  it('shows the error box when rendering rejects', async () => {
    vi.mocked(renderMermaidToSvg).mockRejectedValueOnce(new Error('Parse error'));
    render(<MermaidRenderer code="bad" />);
    const box = (await screen.findByText('Parse error')).closest('.diagram-error-box');
    expect(box).toBeTruthy();
    expect(screen.queryByText('mermaid-bad')).toBeNull();
  });

  it('shows the unavailable fallback when the loader yields nothing (jsdom guard)', async () => {
    vi.mocked(renderMermaidToSvg).mockResolvedValueOnce('');
    render(<MermaidRenderer code="graph TD; A-->B;" />);
    await waitFor(() => expect(screen.getByText('Mermaid renderer unavailable')).toBeTruthy());
  });

  it('blank code stays placeholder-only', () => {
    render(<MermaidRenderer code="" />);
    expect(screen.getByText('Mermaid diagram')).toBeTruthy();
    expect(renderMermaidToSvg).not.toHaveBeenCalled();
  });
});

describe('DrawioRenderer (portal DrawioRenderer.tsx parity)', () => {
  it('injects the svg payload', () => {
    render(<DrawioRenderer svgData="<svg>d</svg>" />);
    expect(document.querySelector('.diagram-svg-wrap')?.innerHTML).toContain('<svg>d</svg>');
  });

  it('applies the invert filter in dark mode and toggles back', () => {
    render(<DrawioRenderer svgData="<svg>d</svg>" themeMode="dark" />);
    const wrap = document.querySelector('.diagram-svg-wrap') as HTMLElement;
    expect(wrap.getAttribute('style')).toContain('invert(0.92)');
    fireEvent.click(screen.getByTitle('Switch to light mode'));
    expect((document.querySelector('.diagram-svg-wrap') as HTMLElement).getAttribute('style')).toBe('filter: none;');
  });

  it('placeholder for empty payloads', () => {
    render(<DrawioRenderer svgData="" />);
    expect(screen.getByText('Draw.io diagram (no SVG preview stored)')).toBeTruthy();
  });
});

describe('ExcalidrawRenderer (portal ExcalidrawRenderer.tsx parity)', () => {
  it('injects the svg payload without a filter in light mode', () => {
    render(<ExcalidrawRenderer svgData="<svg>e</svg>" themeMode="light" />);
    const wrap = document.querySelector('.diagram-svg-wrap') as HTMLElement;
    expect(wrap.innerHTML).toContain('<svg>e</svg>');
    expect(wrap.getAttribute('style')).toBe('filter: none;');
  });

  it('returns null for empty payloads', () => {
    const { container } = render(<ExcalidrawRenderer svgData="" />);
    expect(container.children).toHaveLength(0);
  });
});