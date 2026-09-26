import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';

import {
  DrawioNodeView,
  ExcalidrawNodeView,
  MermaidNodeView,
} from './diagramsNodeViews';

// P3 diagram nodes (portal-exact shapes). NodeViews attached T3 per R21 —
// the visual/edit surfaces live in ./diagramsNodeViews.tsx (React), while
// this module keeps the headless attrs/parseHTML/renderHTML + commands.
// Persistence shapes are consumed from the T1 serialization layer
// (src/editor/markdown.ts): ```mermaid fence and base64 HTML comments.

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mermaid: {
      /** Insert a mermaid diagram block carrying the given mermaid code. */
      setMermaid: (content: string) => ReturnType;
    };
    drawio: {
      /** Insert an empty draw.io diagram block (edit surface is T3, R22). */
      insertDrawIo: () => ReturnType;
    };
    excalidraw: {
      /** Insert an empty excalidraw diagram block (edit surface is T3, R21). */
      insertExcalidraw: () => ReturnType;
    };
  }
}

// --- mermaid (portal MermaidExtension.tsx:186-248) ---

export const MermaidExtension = Node.create({
  name: 'mermaid',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      content: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-mermaid-content') || '',
        renderHTML: (attributes) => {
          if (!attributes.content) return {};
          return {
            'data-mermaid-content': attributes.content,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-mermaid]',
        getAttrs: (element) => ({
          content: (element as HTMLElement).getAttribute('data-mermaid-content') || '',
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return [
      'div',
      mergeAttributes({
        'data-mermaid': '',
        'data-mermaid-content': node.attrs.content,
      }),
      '[Mermaid Diagram]',
    ];
  },

  addCommands() {
    return {
      setMermaid:
        (content: string) =>
        ({ commands }) =>
          commands.insertContent({
            type: 'mermaid',
            attrs: { content },
          }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidNodeView);
  },
});

// --- draw.io (portal DrawioExtension.tsx:231-340, minus NodeView) ---

interface DrawioOptions {
  drawioUrl: string;
  drawioProxyEnabled: boolean;
}

export const DrawioExtension = Node.create<DrawioOptions>({
  name: 'drawio',
  group: 'block',
  atom: true,
  draggable: true,

  addOptions() {
    return {
      drawioUrl: 'https://embed.diagrams.net',
      drawioProxyEnabled: false,
    };
  },

  addStorage() {
    return {
      drawioUrl: this.options.drawioUrl,
      drawioProxyEnabled: this.options.drawioProxyEnabled,
    };
  },

  addAttributes() {
    return {
      diagramData: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-drawio-data') || null,
        renderHTML: (attributes) => {
          if (!attributes.diagramData) return {};
          return {
            'data-drawio-data': attributes.diagramData,
          };
        },
      },
      svgData: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-drawio-svg') || null,
        renderHTML: (attributes) => {
          if (!attributes.svgData) return {};
          return {
            'data-drawio-svg': attributes.svgData,
          };
        },
      },
      themeMode: {
        default: 'light',
        parseHTML: (element) => element.getAttribute('data-drawio-theme') || 'light',
        renderHTML: (attributes) => ({
          'data-drawio-theme': attributes.themeMode || 'light',
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-drawio]',
        getAttrs: (element) => ({
          diagramData: (element as HTMLElement).getAttribute('data-drawio-data') || null,
          svgData: (element as HTMLElement).getAttribute('data-drawio-svg') || null,
          themeMode:
            (element as HTMLElement).getAttribute('data-drawio-theme') || 'light',
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return [
      'div',
      mergeAttributes({
        'data-drawio': '',
        'data-drawio-data': node.attrs.diagramData || '',
        'data-drawio-svg': node.attrs.svgData || '',
        'data-drawio-theme': node.attrs.themeMode || 'light',
      }),
      '[Draw.io Diagram]',
    ];
  },

  addCommands() {
    return {
      insertDrawIo:
        () =>
        ({ commands }) =>
          commands.insertContent({
            type: 'drawio',
            attrs: { diagramData: null, svgData: null },
          }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(DrawioNodeView);
  },
});

// --- excalidraw (portal ExcalidrawExtension.tsx:230-322, minus NodeView) ---

export const ExcalidrawExtension = Node.create({
  name: 'excalidraw',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      diagramData: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-excalidraw-data') || null,
        renderHTML: (attributes) => {
          if (!attributes.diagramData) return {};
          return {
            'data-excalidraw-data': attributes.diagramData,
          };
        },
      },
      svgData: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-excalidraw-svg') || null,
        renderHTML: (attributes) => {
          if (!attributes.svgData) return {};
          return {
            'data-excalidraw-svg': attributes.svgData,
          };
        },
      },
      themeMode: {
        default: 'light',
        parseHTML: (element) => element.getAttribute('data-excalidraw-theme') || 'light',
        renderHTML: (attributes) => ({
          'data-excalidraw-theme': attributes.themeMode || 'light',
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-excalidraw]',
        getAttrs: (element) => ({
          diagramData:
            (element as HTMLElement).getAttribute('data-excalidraw-data') || null,
          svgData: (element as HTMLElement).getAttribute('data-excalidraw-svg') || null,
          themeMode:
            (element as HTMLElement).getAttribute('data-excalidraw-theme') || 'light',
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return [
      'div',
      mergeAttributes({
        'data-excalidraw': '',
        'data-excalidraw-data': node.attrs.diagramData || '',
        'data-excalidraw-svg': node.attrs.svgData || '',
        'data-excalidraw-theme': node.attrs.themeMode || 'light',
      }),
      '[Excalidraw Diagram]',
    ];
  },

  addCommands() {
    return {
      insertExcalidraw:
        () =>
        ({ commands }) =>
          commands.insertContent({
            type: 'excalidraw',
            attrs: { diagramData: null },
          }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ExcalidrawNodeView);
  },
});