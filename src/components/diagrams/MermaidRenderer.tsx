import { useEffect, useState } from 'react';

import { renderMermaidToSvg } from './diagramUtils';

interface MermaidRendererProps {
  code: string;
  className?: string;
}

/**
 * Portal-parity MermaidRenderer (portal MermaidRenderer.tsx): renders the
 * given mermaid code via mermaid.render, themed from the live CSS custom
 * properties, with an error-box fallback on invalid syntax. mermaid itself
 * is lazy-imported (guarded by loadMermaid — R21), so merely mounting this
 * component never loads mermaid in jsdom.
 */
export const MermaidRenderer = ({ code, className = '' }: MermaidRendererProps) => {
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const renderDiagram = async () => {
      if (!code) return;
      try {
        const rendered = await renderMermaidToSvg(code);
        if (cancelled) return;
        setSvg(rendered);
        setError(rendered ? null : 'Mermaid renderer unavailable');
      } catch (err) {
        if (cancelled) return;
        setSvg(null);
        setError(err instanceof Error ? err.message : String(err) || 'Invalid Mermaid syntax');
      }
    };
    renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className={`diagram-error-box ${className}`}>
        <div className="diagram-error-title">Diagram error</div>
        <div className="diagram-error-detail">{error}</div>
      </div>
    );
  }

  return (
    <div
      className={`diagram-svg-wrap mermaid-svg-wrap ${className}`}
      data-mermaid-code={code}
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    >
      {!svg ? <div className="diagram-placeholder">Mermaid diagram</div> : null}
    </div>
  );
};