import { useEffect, useState } from 'react';

// ImageSizeModal (P3 task 4, portal GlobalComponents/Modals/ImageSizeModal.tsx
// parity): the size stage of the image insert flow — a live preview fed from
// the confirmed URL, Width (px)/Height (px) inputs ("Auto" placeholder,
// "Leave empty for auto size" hint), Reset/Cancel/Apply. Apply parses ints
// (empty → null) and reports them via onConfirm, then closes; Reset clears
// both fields; Cancel/Escape/backdrop close without confirming. Same
// controlled-card shape as PromptModal — tokens only (.modal-backdrop/
// .modal-card/.prompt-actions + image-size-*).
export default function ImageSizeModal({ isOpen, onClose, onConfirm, currentWidth, currentHeight, imageUrl }: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (width: number | null, height: number | null) => void;
  currentWidth?: number;
  currentHeight?: number;
  imageUrl?: string;
}) {
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');

  // Re-seed from the current dims on every open (portal :30-35).
  useEffect(() => {
    if (isOpen) {
      setWidth(currentWidth != null ? String(currentWidth) : '');
      setHeight(currentHeight != null ? String(currentHeight) : '');
    }
  }, [isOpen, currentWidth, currentHeight]);

  // Escape closes wherever the focus sits — window listener like PromptModal.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const parse = (value: string): number | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  const apply = () => {
    onConfirm(parse(width), parse(height));
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Image Size">
        <h2>Image Size</h2>
        {imageUrl && (
          <div className="image-size-preview">
            <img
              src={imageUrl}
              alt="Preview"
              style={{ width: width ? `${width}px` : 'auto', height: height ? `${height}px` : 'auto' }}
            />
          </div>
        )}
        <div className="image-size-grid">
          <label>
            Width (px)
            <input
              type="number"
              value={width}
              placeholder="Auto"
              onChange={(e) => setWidth(e.target.value)}
            />
          </label>
          <label>
            Height (px)
            <input
              type="number"
              value={height}
              placeholder="Auto"
              onChange={(e) => setHeight(e.target.value)}
            />
          </label>
        </div>
        <p className="image-size-hint">Leave empty for auto size</p>
        <div className="prompt-actions image-size-actions">
          <button type="button" onClick={() => { setWidth(''); setHeight(''); }}>Reset</button>
          <div className="image-size-actions-right">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="primary" onClick={apply}>Apply</button>
          </div>
        </div>
      </div>
    </div>
  );
}