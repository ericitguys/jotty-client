import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

// P3 task 4 — resize plumbing ported from the portal hook
// (TipTap/EditorHooks/useImageResize.ts:10-136). The portal's click/overlay
// state machine collapses here into pure helpers + one dispatch: the desktop
// overlay is selection-driven (NoteEditor re-renders on every transaction and
// mounts the overlay while a NodeSelection sits on an image node), so the
// hook's job splits into three jsdom-testable parts:
//   1. parseImageSizeFromStyle — px dims parse from the style attr (:19-23)
//   2. buildResizedStyle — strip old width/height decls, keep others, append
//      the new px decls (:54-79)
//   3. applyImageSize — find the image node by src (:90-95) and setNodeMarkup
//      with {style, width, height} (:97-108)

export interface ImageSize {
  width: number | null;
  height: number | null;
}

/** px dims parsed out of an inline style string (portal :18-23 — style decls first). */
export function parseImageSizeFromStyle(style: string | null | undefined): ImageSize {
  const s = style ?? '';
  const width = s.match(/width:\s*(\d+)px/);
  const height = s.match(/height:\s*(\d+)px/);
  return {
    width: width ? parseInt(width[1], 10) : null,
    height: height ? parseInt(height[1], 10) : null,
  };
}

/**
 * Rebuild an inline style for a new size: old width/height decls are dropped,
 * everything else is preserved, and the new px decls are appended
 * (portal :54-79). null/0 removes the dimension (back to auto).
 */
export function buildResizedStyle(
  oldStyle: string | null | undefined,
  width: number | null,
  height: number | null,
): string {
  const kept: string[] = [];
  for (const raw of (oldStyle ?? '').split(';')) {
    const decl = raw.trim();
    if (!decl) continue;
    if (/^width\s*:/.test(decl) || /^height\s*:/.test(decl)) continue;
    kept.push(decl);
  }
  if (width != null && width > 0) kept.push(`width: ${width}px`);
  if (height != null && height > 0) kept.push(`height: ${height}px`);
  return kept.join('; ');
}

/** The first image node whose src matches, with its doc position. */
export function findImageNodeBySrc(editor: Editor, src: string): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && node.attrs.src === src && found === null) {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Resize the image matching src to the given px dims (null = auto).
 * Dispatches one setNodeMarkup transaction carrying the rebuilt style attr
 * plus width/height; returns false when no image with that src exists.
 */
export function applyImageSize(
  editor: Editor,
  src: string,
  width: number | null,
  height: number | null,
): boolean {
  const found = findImageNodeBySrc(editor, src);
  if (!found) return false;
  const style = buildResizedStyle(
    typeof found.node.attrs.style === 'string' ? found.node.attrs.style : '',
    width,
    height,
  );
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(found.pos, undefined, {
      ...found.node.attrs,
      width,
      height,
      style: style || null,
    }),
  );
  return true;
}