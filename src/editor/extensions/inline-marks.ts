import { Mark, mergeAttributes } from '@tiptap/core';

// P3 inline marks (portal custom-html-utils.tsx generateCustomHtmlExtensions,
// subset). The portal's array also covers mark/underline/subscript/superscript
// — jotty already ships those as official @tiptap extensions (P1:
// Highlight/Underline/Subscript/Superscript parse <mark>/<u>/<sub>/<sup>
// natively), so ONLY the three missing marks are defined here to avoid
// duplicate schema names.

// --- fontFamily (portal custom-html-utils.tsx:43-47 + 56-94) ---

export const FontFamily = Mark.create({
  name: 'fontFamily',

  addAttributes() {
    return {
      style: {
        default: null,
        parseHTML: (element) => {
          const fontFamily = element.style.fontFamily;
          return fontFamily ? `font-family: ${fontFamily}` : null;
        },
        renderHTML: (attributes) => {
          if (!attributes.style) return {};
          return {
            style: attributes.style,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        // Rule-level priority: out-ranks TextStyle's generic span rule
        // (registered earlier in the extension order) so font spans parse
        // as fontFamily. Non-font spans fall through (getAttrs → false).
        tag: "span[style*='font-family']",
        priority: 1000,
        getAttrs: (node) => {
          if (typeof node === 'string') return false;
          const fontFamily = (node as HTMLElement).style.fontFamily;
          return fontFamily ? {} : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
});

// --- abbreviation (portal custom-html-utils.tsx:37-41) ---

export const Abbreviation = Mark.create({
  name: 'abbreviation',

  addAttributes() {
    return {
      title: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'abbr',
        getAttrs: (node) => {
          if (typeof node === 'string') return false;
          const element = node as HTMLElement;
          return element.hasAttribute('title')
            ? { title: element.getAttribute('title') }
            : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['abbr', mergeAttributes(HTMLAttributes), 0];
  },
});

// --- kbd (portal custom-html-utils.tsx:23-27) ---

export const Kbd = Mark.create({
  name: 'kbd',

  parseHTML() {
    return [{ tag: 'kbd' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['kbd', mergeAttributes(HTMLAttributes), 0];
  },
});