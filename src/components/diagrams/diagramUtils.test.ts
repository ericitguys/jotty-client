import { describe, expect, it } from 'vitest';

import {
  createDrawioProtocolHandler,
  decodeSvgPayload,
  enhanceDiagramFragment,
  getCSSVariable,
  getMermaidThemeVariables,
  isDocumentDark,
} from './diagramUtils';

describe('getCSSVariable (portal _getCSSVariable parity)', () => {
  it('wraps space-separated r g b triplets into rgb()', () => {
    expect(getCSSVariable('--accent', () => '157 95 254')).toBe('rgb(157, 95, 254)');
  });
  it('passes through hex/other values untouched', () => {
    expect(getCSSVariable('--bg', () => '#0e1840')).toBe('#0e1840');
  });
  it('returns empty for missing vars', () => {
    expect(getCSSVariable('--nope', () => '')).toBe('');
  });
});

describe('getMermaidThemeVariables', () => {
  it('falls back to desktop token colors when resolver returns empty', () => {
    const vars = getMermaidThemeVariables(() => '');
    expect(vars.primaryColor).toBe('rgb(157, 95, 254)');
    expect(vars.background).toBe('rgb(14, 24, 64)');
    expect(vars.textColor).toBe('rgb(249, 249, 249)');
  });
  it('uses resolved CSS vars when present (hex passthrough)', () => {
    const vars = getMermaidThemeVariables((name) => (name === '--fg' ? '#1c1533' : ''));
    expect(vars.textColor).toBe('#1c1533');
    expect(vars.nodeBorder).toBe('#1c1533');
  });
});

describe('decodeSvgPayload (idempotent base64/raw tolerance)', () => {
  it('passes raw SVG markup through untouched', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    expect(decodeSvgPayload(svg)).toBe(svg);
  });
  it('decodes bare base64 payloads', () => {
    const encoded = btoa('<svg>b64</svg>');
    expect(decodeSvgPayload(encoded)).toBe('<svg>b64</svg>');
  });
  it('decodes data:image/svg+xml;base64, URIs', () => {
    const uri = `data:image/svg+xml;base64,${btoa('<svg>uri</svg>')}`;
    expect(decodeSvgPayload(uri)).toBe('<svg>uri</svg>');
  });
  it('returns empty string for malformed base64', () => {
    expect(decodeSvgPayload('not@@base64!!')).toBe('');
    expect(decodeSvgPayload('')).toBe('');
  });
});

describe('isDocumentDark (#app[data-theme] detection)', () => {
  it('returns false when the app root declares light', () => {
    document.body.innerHTML = '<div id="app" data-theme="light"></div>';
    expect(isDocumentDark()).toBe(false);
  });
  it('returns true for rwmarkable-dark, default root, or missing app root', () => {
    document.body.innerHTML = '<div id="app" data-theme="rwmarkable-dark"></div>';
    expect(isDocumentDark()).toBe(true);
    document.body.innerHTML = '<div id="app"></div>';
    expect(isDocumentDark()).toBe(true);
    document.body.innerHTML = '';
    expect(isDocumentDark()).toBe(true);
  });
});

describe('enhanceDiagramFragment (R19 preview post-process walk)', () => {
  const mermaidHtml =
    '<div class="md-preview"><div data-mermaid="" data-mermaid-content="graph TD; A--&gt;B;"></div></div>';
  const drawioHtml = (extra: string) =>
    `<div class="md-preview"><div data-drawio="" data-drawio-data="xml" data-drawio-svg="${extra}" data-drawio-theme="dark">[Draw.io Diagram]</div></div>`;
  const excalidrawHtml =
    '<div class="md-preview"><div data-excalidraw="" data-excalidraw-data="{}" data-excalidraw-svg="&lt;svg&gt;ex&lt;/svg&gt;" data-excalidraw-theme="light">[Excalidraw Diagram]</div></div>';

  it('renders [data-mermaid] via the injected mermaid renderer', async () => {
    document.body.innerHTML = mermaidHtml;
    const container = document.querySelector('.md-preview') as HTMLElement;
    const svg = '<svg>mermaid-svg</svg>';
    const calls: string[] = [];
    await enhanceDiagramFragment(container, {
      renderMermaid: async (code) => {
        calls.push(code);
        return svg;
      },
    });
    expect(calls).toEqual(['graph TD; A-->B;']);
    const block = container.querySelector('[data-mermaid]') as HTMLElement;
    expect(block.innerHTML).toContain('mermaid-svg');
    expect(block.querySelectorAll('.diagram-error-box')).toHaveLength(0);
  });

  it('shows the error box when mermaid.render rejects', async () => {
    document.body.innerHTML = mermaidHtml;
    const container = document.querySelector('.md-preview') as HTMLElement;
    await enhanceDiagramFragment(container, {
      renderMermaid: async () => {
        throw new Error('Parse error');
      },
    });
    const block = container.querySelector('[data-mermaid]') as HTMLElement;
    expect(block.querySelector('.diagram-error-box')?.textContent).toContain('Parse error');
  });

  it('injects raw drawio svg with the dark invert filter', async () => {
    document.body.innerHTML = drawioHtml('&lt;svg&gt;raw&lt;/svg&gt;');
    const container = document.querySelector('.md-preview') as HTMLElement;
    await enhanceDiagramFragment(container, {});
    const block = container.querySelector('[data-drawio]') as HTMLElement;
    const injected = block.querySelector('.diagram-svg-wrap') as HTMLElement;
    expect(injected.innerHTML).toBe('<svg>raw</svg>');
    expect(injected.getAttribute('style')).toContain('invert(0.92) contrast(0.85)');
  });

  it('injects excalidraw svg without filter in light mode', async () => {
    document.body.innerHTML = excalidrawHtml;
    const container = document.querySelector('.md-preview') as HTMLElement;
    await enhanceDiagramFragment(container, {});
    const block = container.querySelector('[data-excalidraw]') as HTMLElement;
    const injected = block.querySelector('.diagram-svg-wrap') as HTMLElement;
    expect(injected.innerHTML).toContain('<svg>ex</svg>');
    expect(injected.style.filter).toBe('none');
  });

  it('is idempotent — a second walk does not double-render', async () => {
    document.body.innerHTML = drawioHtml('<svg>one</svg>');
    const container = document.querySelector('.md-preview') as HTMLElement;
    await enhanceDiagramFragment(container, {});
    const block = container.querySelector('[data-drawio]') as HTMLElement;
    expect(block.querySelectorAll('.diagram-svg-wrap')).toHaveLength(1);
    await enhanceDiagramFragment(container, {});
    expect(block.querySelectorAll('.diagram-svg-wrap')).toHaveLength(1);
  });

  it('is idempotent for mermaid (skips already-rendered content)', async () => {
    document.body.innerHTML = mermaidHtml;
    const container = document.querySelector('.md-preview') as HTMLElement;
    let calls = 0;
    const io = {
      renderMermaid: async () => {
        calls += 1;
        return '<svg>x</svg>';
      },
    };
    await enhanceDiagramFragment(container, io);
    await enhanceDiagramFragment(container, io);
    expect(calls).toBe(1);
  });

  it('leaves a placeholder when only diagram data (no svg) is present', async () => {
    document.body.innerHTML =
      '<div class="md-preview"><div data-drawio="" data-drawio-data="xml-only">[Draw.io Diagram]</div></div>';
    const container = document.querySelector('.md-preview') as HTMLElement;
    await enhanceDiagramFragment(container, {});
    const block = container.querySelector('[data-drawio]') as HTMLElement;
    expect(block.querySelector('.diagram-placeholder')).toBeTruthy();
    expect(block.querySelector('.diagram-svg-wrap')).toBeNull();
  });

  it('decodes base64 svg payloads in the walk', async () => {
    document.body.innerHTML = drawioHtml(btoa('<svg>decoded</svg>'));
    const container = document.querySelector('.md-preview') as HTMLElement;
    await enhanceDiagramFragment(container, {});
    const injected = container.querySelector('.diagram-svg-wrap') as HTMLElement;
    expect(injected.innerHTML).toBe('<svg>decoded</svg>');
  });
});

describe('createDrawioProtocolHandler (R22 postMessage protocol, pure parts)', () => {
  it('init produces a load action with the stored xml (or the empty model)', () => {
    const withData = createDrawioProtocolHandler({ diagramData: '<mxfile/>', svgData: null, themeMode: 'light' });
    expect(withData.onInit()).toEqual({ action: 'load', xml: '<mxfile/>' });
    const empty = createDrawioProtocolHandler({ diagramData: null, svgData: null, themeMode: 'light' });
    expect(empty.onInit().action).toBe('load');
    expect((empty.onInit() as { xml: string }).xml).toContain('<mxGraphModel>');
  });

  it('save stores the xml and requests an svg export', () => {
    const handler = createDrawioProtocolHandler({ diagramData: null, svgData: null, themeMode: 'light' });
    const result = handler.onSave('<mxfile v2/>');
    expect(result.attrs.diagramData).toBe('<mxfile v2/>');
    expect(result.outbound).toEqual({ action: 'export', format: 'svg' });
  });

  it('export stores the (data-URI-decoded) svg and closes the editor', () => {
    const handler = createDrawioProtocolHandler({ diagramData: '<x/>', svgData: null, themeMode: 'light' });
    const raw = handler.onExport('<svg>raw</svg>');
    expect(raw.attrs.svgData).toBe('<svg>raw</svg>');
    expect(raw.close).toBe(true);
    const encoded = handler.onExport(`data:image/svg+xml;base64,${btoa('<svg>enc</svg>')}`);
    expect(encoded.attrs.svgData).toBe('<svg>enc</svg>');
    expect(encoded.close).toBe(true);
  });

  it('exit closes without touching attrs', () => {
    const handler = createDrawioProtocolHandler({ diagramData: null, svgData: null, themeMode: 'light' });
    expect(handler.onExit()).toEqual({ attrs: {}, close: true });
  });

  it('accepts diagrams.net origins (and same-origin), rejects others', () => {
    const handler = createDrawioProtocolHandler({ diagramData: null, svgData: null, themeMode: 'light' });
    expect(handler.isOriginAllowed('https://embed.diagrams.net')).toBe(true);
    expect(handler.isOriginAllowed('https://app.diagrams.net')).toBe(true);
    expect(handler.isOriginAllowed(window.location.origin)).toBe(true);
    expect(handler.isOriginAllowed('https://evil.example.com')).toBe(false);
  });
});