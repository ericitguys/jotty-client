import { useState } from 'react';

import { decodeSvgPayload, diagramFilterFor } from './diagramUtils';

interface DrawioRendererProps {
  svgData: string;
  themeMode?: string;
  className?: string;
}

/**
 * Portal-parity DrawioRenderer (portal DrawioRenderer.tsx, minus the
 * next-intl/hugeicons chrome): injects the stored svg payload inline
 * (idempotently base64/data-URI tolerant) with the dark-mode invert filter.
 */
export const DrawioRenderer = ({ svgData, themeMode = 'light', className = '' }: DrawioRendererProps) => {
  const [dark, setDark] = useState(themeMode === 'dark');

  if (!svgData) {
    return (
      <div className={`diagram-placeholder-block ${className}`}>
        <p>Draw.io diagram (no SVG preview stored)</p>
      </div>
    );
  }

  const theme = dark ? 'dark' : 'light';
  return (
    <div className={`diagram-frame ${className}`}>
      <button
        type="button"
        className="diagram-theme-toggle"
        title={`Switch to ${dark ? 'light' : 'dark'} mode`}
        onClick={() => setDark(!dark)}
      >
        {dark ? '☀' : '☾'}
      </button>
      <div
        className="diagram-svg-wrap"
        style={{ filter: diagramFilterFor(theme) }}
        dangerouslySetInnerHTML={{ __html: decodeSvgPayload(svgData) }}
      />
    </div>
  );
};