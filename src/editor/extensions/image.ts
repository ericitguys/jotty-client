import Image from '@tiptap/extension-image';

// P3 task 4 — desktop Image node (portal editorConfig.ts:149-169 parity):
// stock @tiptap/extension-image (inline: false → block, draggable, URL-only
// parse per allowBase64: false default — R18) extended with the sizing attrs.
// Persistence shape on disk (T1 markdown.ts img rule + parse-back):
// `style="width: Npx; height: Npx"` — width/height are declared NODE attrs
// (typed command surface + resize flow) but serialize ONLY through the style
// attribute, like the portal (the portal's stock-plus-style node keeps the px
// in attrs.style; useImageResize.ts:18-36 parses px from that style).
// parseHTML prefers the style decls (the shape markdown-utils.tsx:531-544
// re-adds) and falls back to legacy width/height attributes.

export interface InsertImageOptions {
  src: string;
  alt?: string;
  title?: string;
  width?: number | null;
  height?: number | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    jottyImage: {
      /** Insert a block image (URL-only, R18) with optional px size. */
      insertImage: (options: InsertImageOptions) => ReturnType;
    };
  }
}

export const JottyImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element) => {
          const fromStyle = (element.getAttribute('style') || '').match(/width:\s*(\d+)px/);
          if (fromStyle) return parseInt(fromStyle[1], 10);
          const attr = element.getAttribute('width');
          return attr && attr.trim() !== '' ? parseInt(attr, 10) : null;
        },
        // never rendered as a direct attribute — the px lives in style
        renderHTML: () => ({}),
      },
      height: {
        default: null,
        parseHTML: (element) => {
          const fromStyle = (element.getAttribute('style') || '').match(/height:\s*(\d+)px/);
          if (fromStyle) return parseInt(fromStyle[1], 10);
          const attr = element.getAttribute('height');
          return attr && attr.trim() !== '' ? parseInt(attr, 10) : null;
        },
        renderHTML: () => ({}),
      },
      // portal editorConfig.ts:153-163 — style kept verbatim; when absent it
      // is derived from the width/height attrs (the insertImage path).
      style: {
        default: null,
        parseHTML: (element) => element.getAttribute('style'),
        renderHTML: (attributes) => {
          if (attributes.style) return { style: attributes.style };
          const decls: string[] = [];
          if (typeof attributes.width === 'number' && attributes.width > 0) {
            decls.push(`width: ${attributes.width}px`);
          }
          if (typeof attributes.height === 'number' && attributes.height > 0) {
            decls.push(`height: ${attributes.height}px`);
          }
          return decls.length > 0 ? { style: decls.join('; ') } : {};
        },
      },
    };
  },

  addCommands() {
    return {
      ...this.parent?.(),
      insertImage:
        (options: InsertImageOptions) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: options }),
    };
  },
});