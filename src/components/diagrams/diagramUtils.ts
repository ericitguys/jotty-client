// P3 diagram helpers (portal parity: Mermaid/Drawio/Excalidraw renderers +
// markdown-utils post-process walk + DrawioExtension postMessage protocol).
// Everything canvas/iframe-heavy is kept OUT of here — these are the pure,
// jsdom-testable parts (R21: visual internals are ship-time QA).

export type CssVarResolver = (variable: string) => string;

/** Portal `_getCSSVariable` parity: "R G B" triplets → rgb(...), else raw. */
export const getCSSVariable = (variable: string, resolve: CssVarResolver): string => {
  const value = resolve(variable);
  if (value && /^\d+\s+\d+\s+\d+$/.test(value)) {
    return `rgb(${value.replace(/\s+/g, ', ')})`;
  }
  return value;
};

// Desktop :root token fallbacks (src/styles.css dark theme) — used when the
// CSS var cannot be resolved (e.g. pre-hydration, headless jsdom).
const FALLBACK = {
  accent: 'rgb(157, 95, 254)', // --accent #9d5ffe
  fg: 'rgb(249, 249, 249)', // --fg #f9f9f9
  bg: 'rgb(14, 24, 64)', // --bg #0e1840
  muted: 'rgb(163, 156, 175)', // --muted #a39caf
};

const varOr = (resolve: CssVarResolver, name: string, fallback: string): string =>
  resolve(name) || fallback;

/** Mermaid `themeVariables` from the live CSS custom properties (portal parity). */
export const getMermaidThemeVariables = (resolve: CssVarResolver): Record<string, string> => ({
  primaryColor: varOr(resolve, '--accent', FALLBACK.accent),
  primaryTextColor: varOr(resolve, '--fg', FALLBACK.fg),
  primaryBorderColor: varOr(resolve, '--fg', FALLBACK.fg),
  lineColor: varOr(resolve, '--accent', FALLBACK.accent),
  secondaryColor: varOr(resolve, '--muted', FALLBACK.muted),
  tertiaryColor: varOr(resolve, '--muted', FALLBACK.muted),
  background: varOr(resolve, '--bg', FALLBACK.bg),
  mainBkg: varOr(resolve, '--bg', FALLBACK.bg),
  secondBkg: varOr(resolve, '--muted', FALLBACK.muted),
  tertiaryBkg: varOr(resolve, '--accent', FALLBACK.accent),
  textColor: varOr(resolve, '--fg', FALLBACK.fg),
  border1: varOr(resolve, '--border', FALLBACK.fg),
  border2: varOr(resolve, '--border', FALLBACK.fg),
  nodeBorder: varOr(resolve, '--fg', FALLBACK.fg),
  clusterBkg: varOr(resolve, '--panel', FALLBACK.muted),
  clusterBorder: varOr(resolve, '--fg', FALLBACK.fg),
  defaultLinkColor: varOr(resolve, '--accent', FALLBACK.accent),
  titleColor: varOr(resolve, '--fg', FALLBACK.fg),
  edgeLabelBackground: varOr(resolve, '--bg', FALLBACK.bg),
  nodeTextColor: varOr(resolve, '--fg', FALLBACK.fg),
});

/** Live-document resolver for getMermaidThemeVariables. */
export const documentCssVarResolver = (): CssVarResolver => (variable) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return '';
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  } catch {
    return '';
  }
};

/**
 * Idempotent payload decoder (R19): preview DOM attrs carry the RAW svg/xml
 * (T1's remark parse-back already base64-decodes the HTML comment payloads),
 * but raw HTML sources may still carry base64. Accepts raw markup, bare
 * base64, and `data:image/svg+xml;base64,` URIs; malformed → ''.
 */
export const decodeSvgPayload = (raw: string): string => {
  if (!raw) return '';
  const value = raw.trim();
  let payload = value;
  if (/^data:image\/svg\+xml;base64,/i.test(payload)) {
    payload = payload.slice('data:image/svg+xml;base64,'.length);
  }
  if (payload.startsWith('<')) return payload;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(payload) && payload.length % 4 === 0 && payload.length > 0) {
    try {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch {
      return '';
    }
  }
  return '';
};

/** Theme detection: `#app[data-theme]` drives desktop themes (App.tsx:173). */
export const isDocumentDark = (): boolean => {
  if (typeof document === 'undefined') return true;
  const app = document.getElementById('app');
  const theme = app?.getAttribute('data-theme');
  return theme !== 'light';
};

/** Portal-parity dark-mode invert filter (Drawio/Excalidraw renderers). */
export const DIAGRAM_DARK_FILTER = 'invert(0.92) contrast(0.85) brightness(1.1) saturate(1.2)';

export const diagramFilterFor = (themeMode: string | null | undefined): string =>
  (themeMode || 'light') === 'dark' ? DIAGRAM_DARK_FILTER : 'none';

// --- guarded lazy loaders (R21: jsdom never loads canvas-heavy libs unless a
// test explicitly opts in via window.__DIAGRAMS_FORCE_HEAVY__) ---

const jsdomTestEnv = (): boolean =>
  typeof navigator !== 'undefined' && navigator.userAgent.includes('jsdom');

const forceHeavyVisuals = (): boolean => {
  if (typeof window === 'undefined') return false;
  return (window as { __DIAGRAMS_FORCE_HEAVY__?: boolean }).__DIAGRAMS_FORCE_HEAVY__ === true;
};

interface MermaidModule {
  initialize: (config: unknown) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidModule | null> | null = null;

/** Mermaid loader: module-level memo + jsdom guard (portal dynamic/ssr:false). */
export const loadMermaid = (): Promise<MermaidModule | null> => {
  if (!mermaidPromise) {
    mermaidPromise = (async () => {
      if (jsdomTestEnv() && !forceHeavyVisuals()) return null;
      if (typeof window === 'undefined') return null;
      return (await import('mermaid')).default as MermaidModule;
    })();
  }
  return mermaidPromise;
};

interface ExcalidrawModule {
  Excalidraw: unknown;
  exportToSvg: (opts: unknown) => Promise<SVGSVGElement>;
}

let excalidrawPromise: Promise<ExcalidrawModule | null> | null = null;

/** Excalidraw loader: same guard pattern, resolved on first open only. */
export const loadExcalidraw = (): Promise<ExcalidrawModule | null> => {
  if (!excalidrawPromise) {
    excalidrawPromise = (async () => {
      if (jsdomTestEnv() && !forceHeavyVisuals()) return null;
      if (typeof window === 'undefined') return null;
      return (await import('@excalidraw/excalidraw')) as ExcalidrawModule;
    })();
  }
  return excalidrawPromise;
};

/** Normalize sankey → sankey-beta before render (portal parity). */
export const normalizeDiagramType = (code: string): string =>
  code.replace(/^(\s*)sankey(\s)/m, '$1sankey-beta$2');

/** Run mermaid.render with the live-theme init, normalizing the sankey alias. */
export const renderMermaidToSvg = async (code: string): Promise<string> => {
  const mermaid = await loadMermaid();
  if (!mermaid) return '';
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    securityLevel: 'loose',
    themeVariables: getMermaidThemeVariables(documentCssVarResolver()),
  });
  const id = `mermaid-${Math.random().toString(36).substring(2, 11)}`;
  const { svg } = await mermaid.render(id, normalizeDiagramType(code));
  return svg;
};

// --- R19: preview-pane post-process walk (portal UnifiedMarkdownRenderer parity) ---

export interface EnhanceDiagramIo {
  /** Async mermaid renderer (injected so jsdom tests never load mermaid). */
  renderMermaid?: (code: string) => Promise<string>;
}

const escapeHtml = (message: string): string =>
  message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const errorBox = (message: string): string =>
  `<div class="diagram-error-box"><div class="diagram-error-title">Diagram error</div><div class="diagram-error-detail">${escapeHtml(message)}</div></div>`;

const injectSvg = (block: HTMLElement, svg: string, themeMode: string | null): void => {
  const wrapper = document.createElement('div');
  wrapper.className = 'diagram-svg-wrap';
  wrapper.style.filter = diagramFilterFor(themeMode);
  wrapper.innerHTML = svg;
  block.appendChild(wrapper);
};

const injectPlaceholder = (block: HTMLElement, label: string): void => {
  const placeholder = document.createElement('div');
  placeholder.className = 'diagram-placeholder';
  placeholder.textContent = label;
  block.appendChild(placeholder);
};

const enhanceSvgBlock = (block: HTMLElement, attrName: string, label: string): void => {
  if (block.dataset.diagramDone) return;
  block.dataset.diagramDone = '1';
  const svg = decodeSvgPayload(block.getAttribute(attrName) ?? '');
  const themeMode = block.getAttribute(`${attrName.replace('-svg', '-theme')}`);
  if (svg) {
    injectSvg(block, svg, themeMode);
  } else {
    injectPlaceholder(block, label);
  }
};

/**
 * Walk a rendered preview fragment and enrich diagram blocks in place.
 * Idempotent: blocks carry a `data-diagram-done` flag once processed, so
 * re-running the walk (or double-mounting) never double-renders. Mermaid
 * blocks are rendered through the injected `renderMermaid` (async) with an
 * error-box fallback; drawio/excalidraw svg payloads are injected inline
 * with the dark-mode invert filter when the block's theme is dark.
 */
export const enhanceDiagramFragment = async (
  container: HTMLElement,
  io: EnhanceDiagramIo = {},
): Promise<void> => {
  if (!container) return;

  for (const block of Array.from(container.querySelectorAll<HTMLElement>('[data-drawio]'))) {
    enhanceSvgBlock(block, 'data-drawio-svg', 'Draw.io diagram (no SVG preview stored)');
  }
  for (const block of Array.from(container.querySelectorAll<HTMLElement>('[data-excalidraw]'))) {
    enhanceSvgBlock(block, 'data-excalidraw-svg', 'Excalidraw diagram (no SVG preview stored)');
  }

  const mermaidBlocks = Array.from(container.querySelectorAll<HTMLElement>('[data-mermaid]'));
  await Promise.all(
    mermaidBlocks.map(async (block) => {
      const code = block.getAttribute('data-mermaid-content') ?? '';
      if (!code) return;
      if (block.dataset.diagramMermaid === code) return;
      block.dataset.diagramMermaid = code;
      block.querySelectorAll('.diagram-error-box, .diagram-svg-wrap, .mermaid-svg-wrap').forEach((n) => n.remove());
      if (!io.renderMermaid) {
        injectPlaceholder(block, 'Mermaid diagram');
        return;
      }
      try {
        const svg = await io.renderMermaid(code);
        if (!block.isConnected) return;
        if (svg) {
          const wrapper = document.createElement('div');
          wrapper.className = 'diagram-svg-wrap mermaid-svg-wrap';
          wrapper.innerHTML = svg;
          block.appendChild(wrapper);
        } else {
          injectPlaceholder(block, 'Mermaid diagram');
        }
      } catch (err) {
        if (!block.isConnected) return;
        const message = err instanceof Error ? err.message : String(err);
        block.insertAdjacentHTML('beforeend', errorBox(message || 'Invalid Mermaid syntax'));
      }
    }),
  );
};

// --- R22: draw.io embed postMessage protocol (pure, testable parts) ---

export interface DrawioAttrs {
  diagramData: string | null;
  svgData: string | null;
  themeMode: string;
}

export type DrawioOutboundAction = { action: 'load'; xml: string } | { action: 'export'; format: 'svg' };

export interface DrawioProtocolResult {
  attrs: Partial<DrawioAttrs>;
  outbound?: DrawioOutboundAction;
  close: boolean;
}

export const DRAWIO_EMPTY_MODEL =
  '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';

/** Portal DrawioExtension.tsx message handling, extracted as a pure reducer. */
export const createDrawioProtocolHandler = (initial: DrawioAttrs) => {
  let diagramData = initial.diagramData;
  const isOriginAllowed = (origin: string): boolean => {
    if (!origin) return false;
    if (origin.includes('diagrams.net')) return true;
    try {
      return typeof window !== 'undefined' && origin === window.location.origin;
    } catch {
      return false;
    }
  };
  return {
    isOriginAllowed,
    onInit: (): DrawioOutboundAction => ({ action: 'load', xml: diagramData || DRAWIO_EMPTY_MODEL }),
    onSave: (xml: string): DrawioProtocolResult => {
      diagramData = xml;
      return { attrs: { diagramData: xml }, outbound: { action: 'export', format: 'svg' }, close: false };
    },
    onExport: (payload: string): DrawioProtocolResult => ({
      attrs: { svgData: decodeSvgPayload(payload) },
      close: true,
    }),
    onExit: (): DrawioProtocolResult => ({ attrs: {}, close: true }),
  };
};