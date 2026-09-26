import { useEffect, useRef, useState } from 'react';
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
  // Live refs: the window-registered pointerup commits once with the LATEST
  // preview dims — state captured in the pointerdown render closure goes
  // stale after pointermove updates (P3 T4 review Important finding: the
  // drag previewed in the inputs but committed pre-drag dims).
  const widthRef = useRef('');
  const heightRef = useRef('');
  const setWidthTracked = (value: string) => { widthRef.current = value; setWidth(value); };
  const setHeightTracked = (value: string) => { heightRef.current = value; setHeight(value); };

  // Seed from the selected node's parsed dims (portal :30-35).
  useEffect(() => {
    if (visible) {
      setWidthTracked(currentWidth != null ? String(currentWidth) : '');
      setHeightTracked(currentHeight != null ? String(currentHeight) : '');
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
    onApply(parse(widthRef.current), parse(heightRef.current));
    onClose();
  };

  // Corner drag: pointerdown captures the pointer and the start dims;
  // pointermove previews the numbers (live, clamped >= 16px); pointerup
  // commits once through apply (portal commits per-move only for its own
  // inputs — the drag geometry itself is ship-time QA, jsdom has no rects).
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    // jsdom's fireEvent fallback Event carries no clientX/clientY (undefined
    // read → NaN deltas) — default to 0 so synthetic pointerdowns work; real
    // browser pointerdowns always carry both.
    const startX = Number.isFinite(e.clientX) ? e.clientX : 0;
    const startY = Number.isFinite(e.clientY) ? e.clientY : 0;
    const baseWidth = parse(widthRef.current) ?? 0;
    const baseHeight = parse(heightRef.current) ?? 0;
    const target = e.currentTarget;
    try { target.setPointerCapture(e.pointerId); } catch { /* jsdom: no capture */ }

    const onMove = (ev: PointerEvent) => {
      // jsdom's fireEvent.pointerMove fallback Event carries no clientX/
      // clientY (undefined read → NaN math) — skip non-finite moves instead
      // of writing 'NaN' state; real browser moves always carry both.
      if (!Number.isFinite(ev.clientX) || !Number.isFinite(ev.clientY)) return;
      const dx = Math.round(ev.clientX - startX);
      const dy = Math.round(ev.clientY - startY);
      setWidthTracked(String(Math.max(16, baseWidth + dx)));
      setHeightTracked(String(Math.max(16, baseHeight + dy)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      apply();
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
          <input type="number" value={width} placeholder="Auto" onChange={(e) => setWidthTracked(e.target.value)} />
        </label>
        <label>
          Height (px)
          <input type="number" value={height} placeholder="Auto" onChange={(e) => setHeightTracked(e.target.value)} />
        </label>
      </div>
      <div className="prompt-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" onClick={apply}>Apply</button>
      </div>
      <div
        data-testid="image-resize-handle"
        className="image-resize-handle"
        onPointerDown={startDrag}
      />
    </div>
  );
}