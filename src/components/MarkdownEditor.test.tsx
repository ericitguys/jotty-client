import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderMermaidToSvg } from './diagrams/diagramUtils';
import MarkdownEditor from './MarkdownEditor';

vi.mock('./diagrams/diagramUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./diagrams/diagramUtils')>()),
  renderMermaidToSvg: vi.fn(async (code: string) => `<svg>walk-${code}</svg>`),
}));

describe('MarkdownEditor', () => {
  it('renders a textarea with the markdown value and reports changes', () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value={'# hi'} onChange={onChange} editor={null} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '# hello' } });
    expect(onChange).toHaveBeenCalledWith('# hello');
  });
  it('preview toggle renders converted HTML instead of the textarea', () => {
    const { rerender } = render(<MarkdownEditor value={'# hi'} onChange={() => {}} editor={null} preview />);
    expect(document.querySelector('.md-preview')?.innerHTML).toContain('h1');
    expect(screen.queryByRole('textbox')).toBeNull();
    rerender(<MarkdownEditor value={'# hi'} onChange={() => {}} editor={null} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
  it('highlight overlay tokens exist (markdown grammar via highlight.js)', () => {
    render(<MarkdownEditor value={'# hi\n\n- a'} onChange={() => {}} editor={null} />);
    expect(document.querySelector('.md-editor .hljs-markdown, .md-editor code.language-markdown')).toBeTruthy();
  });

  // --- R19: preview post-process walk (P3 task 3) ---

  const mermaidMd = 'pre\n\n```mermaid\ngraph TD; A-->B;\n```\n';
  const drawioMd = (svg64: string) =>
    `pre\n\n<!-- drawio-diagram\ndata: ${btoa('<mxfile v1/>')}\nsvg: ${svg64}\ntheme: dark -->\n`;
  const excalidrawMd = (svg64: string) =>
    `pre\n\n<!-- excalidraw-diagram\ndata: ${btoa('{"elements":[]}')}\nsvg: ${svg64}\ntheme: light -->\n`;

  it('the preview walk renders [data-mermaid] blocks via mermaid', async () => {
    render(<MarkdownEditor value={'```mermaid\ngraph TD; A-->B;\n```'} onChange={() => {}} editor={null} preview />);
    const injected = await screen.findByText('walk-graph TD; A-->B;');
    expect(injected.closest('.diagram-svg-wrap')).toBeTruthy();
    expect(renderMermaidToSvg).toHaveBeenCalledWith('graph TD; A-->B;');
  });

  it('the preview walk injects draw.io svg payloads with the dark invert filter', async () => {
    render(<MarkdownEditor value={drawioMd(btoa('<svg>drawio-preview</svg>'))} onChange={() => {}} editor={null} preview />);
    await waitFor(() => {
      const wrap = document.querySelector('.md-preview .diagram-svg-wrap') as HTMLElement | null;
      expect(wrap?.innerHTML).toContain('<svg>drawio-preview</svg>');
    });
    const wrap = document.querySelector('.md-preview .diagram-svg-wrap') as HTMLElement;
    expect(wrap.getAttribute('style')).toContain('invert(0.92)');
  });

  it('the preview walk injects excalidraw svg payloads (light: no filter)', async () => {
    render(<MarkdownEditor value={excalidrawMd(btoa('<svg>excali-preview</svg>'))} onChange={() => {}} editor={null} preview />);
    await waitFor(() => {
      const wrap = document.querySelector('.md-preview .diagram-svg-wrap') as HTMLElement | null;
      expect(wrap?.innerHTML).toContain('<svg>excali-preview</svg>');
    });
    const wrap = document.querySelector('.md-preview .diagram-svg-wrap') as HTMLElement;
    expect(wrap.getAttribute('style')).toBe('filter: none;');
  });

  it('the walk is re-run-safe: switching previews never double-injects', async () => {
    const md = drawioMd(btoa('<svg>once</svg>'));
    const { rerender } = render(<MarkdownEditor value={md} onChange={() => {}} editor={null} preview />);
    await waitFor(() => expect(document.querySelectorAll('.md-preview .diagram-svg-wrap')).toHaveLength(1));
    rerender(<MarkdownEditor value={md} onChange={() => {}} editor={null} preview />);
    await waitFor(() => expect(document.querySelectorAll('.md-preview .diagram-svg-wrap')).toHaveLength(1));
  });

  it('plain markdown preview stays untouched by the walk', () => {
    render(<MarkdownEditor value={'# just text'} onChange={() => {}} editor={null} preview />);
    expect(document.querySelectorAll('.md-preview .diagram-svg-wrap')).toHaveLength(0);
    expect(document.querySelectorAll('.md-preview .diagram-placeholder')).toHaveLength(0);
  });
});