import { useState } from 'react';

import { decodeSvgPayload, diagramFilterFor } from './diagramUtils';

interface ExcalidrawRendererProps {
  svgData: string;
  themeMode?: string;
  className?: string;
}

/**
 * Portal-parity ExcalidrawRenderer (portal ExcalidrawRenderer.tsx): injects
 * the stored svg payload inline with the dark-mode invert filter.
 */
export const ExcalidrawRenderer = ({
  svgData,
  themeMode = 'light',
  className = '',
}: ExcalidrawRendererProps) => {
  const [dark, setDark] = useState(themeMode === 'dark');

  if (!svgData) return null;

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