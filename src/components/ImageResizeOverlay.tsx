import { useEffect, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

// ImageResizeOverlay (P3 task 4 — port of the portal pair
// TipTap/EditorHooks/useImageResize.ts:10-136 + FileAttachment/
// CompactImageResizeOverlay.tsx): the floating "Resize Image" card mounted by
// NoteEditor while a NodeSelection sits on an image node. Width (px)/Height
// (px) are seeded from the node's px dims (parsed from the style attr by the
// caller); Apply/Cancel/Escape/handle-drag-commit report px via onApply
// (null = auto) and close — the parent dispatches the setNodeMarkup
// (imageResize.ts applyImageSize) and leaves the selection. The corner
// handle drags: pointerdown captures, pointermove previews the px numbers,
// pointerup commits once. Tokens only (.image-resize-* + image-size-grid).
export default function ImageResizeOverlay({ visible, src, currentWidth, currentHeight, top = 0, left = 0, onApply, onClose }: {
  visible: boolean;
  src: string;
  currentWidth?: number | null;
  currentHeight?: number | null;
  top?: number;
  left?: number;
  onApply: (width: number | null, height: number | null) => void;
  onClose: () => void;
}) {
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');

  // Seed from the selected node's parsed dims (portal :30-35).
  useEffect(() => {
    if (visible) {
      setWidth(currentWidth != null ? String(currentWidth) : '');
      setHeight(currentHeight != null ? String(currentHeight) : '');
    }
  }, [visible, currentWidth, currentHeight]);

  // Escape closes wherever the focus sits (portal useOverlayClickOutside
  // semantics collapse to the same window listener the modals use).
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [visible, onClose]);

  if (!visible) return null;

  const parse = (value: string): number | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  const apply = () => {
    onApply(parse(width), parse(height));
    onClose();
  };

  // Corner drag: pointerdown captures the pointer and the start dims;
  // pointermove previews the numbers (live, clamped >= 16px); pointerup
  // commits once through onApply (portal commits per-move only for its own
  // inputs — the drag geometry itself is ship-time QA, jsdom has no rects).
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const baseWidth = parse(width) ?? 0;
    const baseHeight = parse(height) ?? 0;
    const target = e.currentTarget;
    try { target.setPointerCapture(e.pointerId); } catch { /* jsdom: no capture */ }

    const onMove = (ev: PointerEvent) => {
      const dx = Math.round(ev.clientX - startX);
      const dy = Math.round(ev.clientY - startY);
      setWidth(String(Math.max(16, baseWidth + dx)));
      setHeight(String(Math.max(16, baseHeight + dy)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      onApply(parse(width), parse(height));
      onClose();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      data-testid="image-resize-overlay"
      className="image-resize-overlay"
      style={{ top: `${top}px`, left: `${left}px` }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="image-resize-head">
        <span>Resize Image</span>
        <button type="button" aria-label="Close overlay" onClick={onClose}>×</button>
      </div>
      <div className="image-size-grid">
        <label>
          Width (px)
          <input type="number" value={width} placeholder="Auto" onChange={(e) => setWidth(e.target.value)} />
        </label>
        <label>
          Height (px)
          <input type="number" value={height} placeholder="Auto" onChange={(e) => setHeight(e.target.value)} />
        </label>
      </div>
      <div className="prompt-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" onClick={() => { onApply(parse(width), parse(height)); onClose(); }}>Apply</button>
      </div>
      <div
        data-testid="image-resize-handle"
        className="image-resize-handle"
        onPointerDown={startDrag}
      />
    </div>
  );
}