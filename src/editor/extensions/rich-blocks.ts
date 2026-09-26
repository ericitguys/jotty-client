import { Node, mergeAttributes } from '@tiptap/core';
import type { Editor } from '@tiptap/core';

// P3 rich-block nodes (portal-exact shapes, NodeViews deferred per R21):
// details (collapsible), callout, fileAttachment. InputRules for the
// 📎/🎥/![img] parse-back ride T5 per the plan — this file ships the
// node attrs/parseHTML/renderHTML + insert/toggle commands only.

export type CalloutType = 'info' | 'warning' | 'success' | 'danger';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Insert a callout block of the given type (default info). */
      setCallout: (type?: CalloutType) => ReturnType;
    };
    fileAttachment: {
      /** Insert a URL-only file-attachment block (R18: no upload endpoint). */
      setFileAttachment: (options: {
        url: string;
        fileName: string;
        mimeType: string;
        type: 'image' | 'video' | 'file';
      }) => ReturnType;
    };
  }
}

// --- details (portal DetailsExtension.tsx:21-91, minus NodeView) ---

export const DetailsExtension = Node.create({
  name: 'details',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      summary: {
        default: 'Details',
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'details',
        getAttrs: (dom) => {
          const summaryElement = (dom as HTMLElement).querySelector('summary');
          return { summary: summaryElement?.textContent || 'Details' };
        },
        contentElement: (dom: HTMLElement) => {
          const summaryElement = dom.querySelector('summary');
          if (summaryElement) {
            summaryElement.remove();
          }
          const contentWrapper = dom.querySelector('div');
          return contentWrapper || dom;
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'details',
      mergeAttributes(HTMLAttributes),
      ['summary', node.attrs.summary],
      ['div', 0],
    ];
  },

  // Portal :71-90 — swallow Backspace at the start of the details' first
  // child when a details node sits directly before it (guard against
  // backspacing out of / joining into the wrapper).
  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { selection, doc } = editor.state;
        const { $from } = selection;

        if ($from.parentOffset === 0 && $from.depth >= 1) {
          const beforePos = $from.before();
          if (beforePos > 0) {
            const nodeBefore = doc.resolve(beforePos - 1).nodeBefore;
            if (nodeBefore?.type.name === 'details') {
              return true;
            }
          }
        }

        return false;
      },
    };
  },
});

/**
 * Portal toggle (ExtraItemsDropdown.tsx:94-106 / SlashCommands.tsx:147):
 * the core `toggleWrap` command verified present on installed
 * @tiptap/core 2.27.3 (R20) — wrapping stamps the summary from the
 * selected text when there is one, else the node's 'Details' default;
 * toggling again from inside lifts the content back out.
 */
export function toggleDetails(editor: Editor): void {
  const { from, to, empty } = editor.state.selection;
  const selectedText = editor.state.doc.textBetween(from, to, ' ');
  // Attributes ONLY when there is a selection: passing { summary: undefined }
  // fails isNodeActive's objectIncludes check (undefined !== 'Details') and
  // toggleWrap would re-wrap instead of lifting back out.
  editor
    .chain()
    .focus()
    .toggleWrap('details', !empty ? { summary: selectedText } : undefined)
    .run();
}

// --- callout (portal CalloutExtension.tsx:87-217, minus NodeView) ---

export const CalloutExtension = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      type: {
        default: 'info',
        parseHTML: (element) =>
          (element.getAttribute('data-callout-type') as CalloutType) || 'info',
        renderHTML: (attributes) => ({
          'data-callout-type': attributes.type,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="callout"]',
        getAttrs: (dom) => {
          const element = dom as HTMLElement;
          return {
            type: element.getAttribute('data-callout-type') || 'info',
          };
        },
        contentElement: (dom: HTMLElement) => {
          return dom.querySelector('.callout-content') || dom;
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const type = node.attrs.type || 'info';

    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'callout',
        'data-callout-type': type,
        class: `callout callout-${type}`,
      }),
      [
        'div',
        { class: 'callout-wrapper' },
        ['span', { class: `callout-icon callout-icon-${type}` }],
        ['div', { class: 'callout-content' }, 0],
      ],
    ];
  },

  addCommands() {
    return {
      setCallout:
        (type: CalloutType = 'info') =>
        ({ commands }) =>
          commands.insertContent({
            type: 'callout',
            attrs: { type },
            content: [{ type: 'paragraph' }],
          }),
    };
  },

  // Portal :162-216 — Backspace at the first child lifts out of the
  // callout; Enter on the trailing empty paragraph escapes past it.
  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { selection } = editor.state;
        const { $from, empty } = selection;

        if (!empty) return false;

        if ($from.parentOffset === 0 && $from.depth >= 2) {
          const calloutDepth = $from.depth - 1;
          const calloutNode = $from.node(calloutDepth);

          if (calloutNode?.type.name === 'callout') {
            const indexInCallout = $from.index(calloutDepth);
            if (indexInCallout === 0) {
              return editor.commands.lift('callout');
            }
          }
        }

        return false;
      },
      Enter: ({ editor }) => {
        const { selection } = editor.state;
        const { $from, empty } = selection;

        if (!empty) return false;

        for (let depth = $from.depth; depth > 0; depth--) {
          const node = $from.node(depth);
          if (node.type.name === 'callout') {
            const parent = $from.parent;
            const isEmptyParagraph =
              parent.type.name === 'paragraph' && parent.content.size === 0;
            const calloutNode = $from.node(depth);
            const indexInCallout = $from.index(depth);
            const isLastChild = indexInCallout === calloutNode.childCount - 1;

            if (isEmptyParagraph && isLastChild) {
              const pos = $from.after(depth);
              return editor
                .chain()
                .deleteNode('paragraph')
                .insertContentAt(pos, { type: 'paragraph' })
                .focus()
                .run();
            }
            break;
          }
        }

        return false;
      },
    };
  },
});

// --- fileAttachment (portal FileAttachment/FileAttachmentExtension.tsx,
// minus NodeView and InputRules — the 📎/🎥/![img] input rules ride T5) ---

export interface FileAttachmentOptions {
  HTMLAttributes: Record<string, unknown>;
}

export const FileAttachmentExtension = Node.create<FileAttachmentOptions>({
  name: 'fileAttachment',

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  group: 'block',
  atom: true,

  addAttributes() {
    return {
      url: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-url'),
        renderHTML: (attributes) => {
          if (!attributes.url) {
            return {};
          }
          return {
            'data-url': attributes.url,
          };
        },
      },
      fileName: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-file-name'),
        renderHTML: (attributes) => {
          if (!attributes.fileName) {
            return {};
          }
          return {
            'data-file-name': attributes.fileName,
          };
        },
      },
      mimeType: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mime-type'),
        renderHTML: (attributes) => {
          if (!attributes.mimeType) {
            return {};
          }
          return {
            'data-mime-type': attributes.mimeType,
          };
        },
      },
      type: {
        default: 'file',
        parseHTML: (element) => element.getAttribute('data-type') || 'file',
        renderHTML: (attributes) => ({
          'data-type': attributes.type,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'p[data-file-attachment]',
        // Rule-level priority: without it the StarterKit paragraph rule
        // (registered first, equal precedence) wins matchTag for
        // `<p data-file-attachment>` and the node never parses. Portal
        // carries no priority (its parse rule is dead there — loaded
        // markdown never carries the raw shape); jotty's headless gate
        // requires the shape to parse, so the rule out-prioritizes `p`.
        priority: 1000,
        getAttrs: (element) => {
          return {
            url: (element as HTMLElement).getAttribute('data-url'),
            fileName: (element as HTMLElement).getAttribute('data-file-name'),
            mimeType: (element as HTMLElement).getAttribute('data-mime-type'),
            type: (element as HTMLElement).getAttribute('data-type') || 'file',
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'p',
      mergeAttributes(
        {
          'data-file-attachment': '',
          'data-url': node.attrs.url,
          'data-file-name': node.attrs.fileName,
          'data-mime-type': node.attrs.mimeType,
          'data-type': node.attrs.type,
        },
        this.options.HTMLAttributes,
        HTMLAttributes,
      ),
      `[📎 ${node.attrs.fileName}](${node.attrs.url})`,
    ];
  },

  addCommands() {
    return {
      setFileAttachment:
        (options) =>
        ({ commands }) =>
          commands.insertContent({
            type: 'fileAttachment',
            attrs: options,
          }),
    };
  },
});