import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeStringify from 'rehype-stringify';

// P3 base64 helpers (portal markdown-utils.tsx:19-39; DOM path — Buffer is absent in the webview).
const utf8ToBase64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const base64ToUtf8 = (value: string): string => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

export const createTurndownService = (): TurndownService => {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    bulletListMarker: '-',
  });
  service.addRule('taskItem', {
    filter: (node) => node.nodeName === 'LI' && node.getAttribute('data-type') === 'taskItem',
    replacement: (content, node) => {
      const el = node as HTMLElement;
      if (el.parentElement?.getAttribute('data-type') !== 'taskList') return content;
      const checked = el.getAttribute('data-checked') === 'true';
      const inner = content.trim().replace(/\n/g, '\n    ');
      return `${checked ? '- [x] ' : '- [ ] '}${inner}\n`;
    },
  });
  service.use(gfm);

  // --- P3 portal shapes (portal markdown-utils.tsx + custom-html-utils.tsx) ---

  // Collapsible: raw HTML block (portal markdown-utils.tsx:208-222).
  service.addRule('details', {
    filter: 'details',
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const summaryNode = element.querySelector('summary');
      const summaryText = summaryNode ? (summaryNode.textContent ?? '') : 'Details';
      const contentNode = element.cloneNode(true) as HTMLElement;
      const summaryToRemove = contentNode.querySelector('summary');
      if (summaryToRemove) contentNode.removeChild(summaryToRemove);
      const mainContent = service.turndown(contentNode.innerHTML);
      return `\n<details>\n<summary>${summaryText}</summary>\n\n${mainContent}\n\n</details>\n`;
    },
  });

  // FileAttachment → image ![n](u) / video [🎥 n](u) / file [📎 n](u) link (portal :233-254).
  service.addRule('fileAttachment', {
    filter: (node) => node.nodeName === 'P' && (node as HTMLElement).hasAttribute('data-file-attachment'),
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const url = element.getAttribute('data-url');
      const fileName = element.getAttribute('data-file-name');
      const type = element.getAttribute('data-type');
      if (type === 'image') return `![${fileName}](${url})`;
      if (type === 'video') return `[🎥 ${fileName}](${url})`;
      return `[📎 ${fileName}](${url})`;
    },
  });

  // Image: sized (non-zero width/height) → inline <img> with px style; unsized → link (portal :276-306).
  // P3 task 4: the editor's image node serializes size through the STYLE
  // attribute (extension attrs width/height → style="width: Npx; height:
  // Npx"), so after the legacy width/height attrs the rule falls back to
  // parsing the px decls out of the style attr.
  service.addRule('image', {
    filter: (node) => node.nodeName === 'IMG',
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const src = element.getAttribute('src');
      const alt = element.getAttribute('alt') || '';
      const styleAttr = element.getAttribute('style') || '';
      const width = element.getAttribute('width') || styleAttr.match(/width:\s*(\d+)px/)?.[1] || '';
      const height = element.getAttribute('height') || styleAttr.match(/height:\s*(\d+)px/)?.[1] || '';
      if (!src) return '';
      if (
        (width && width !== '0' && width.trim() !== '') ||
        (height && height !== '0' && height.trim() !== '')
      ) {
        const style: string[] = [];
        if (width && width !== '0' && width.trim() !== '') style.push(`width: ${width}px`);
        if (height && height !== '0' && height.trim() !== '') style.push(`height: ${height}px`);
        return `\n<img src="${src}" alt="${alt}" style="${style.join('; ')}" />\n`;
      }
      return `![${alt}](${src})`;
    },
  });

  // Mermaid: div[data-mermaid] → ```mermaid fence (portal :352-365).
  service.addRule('mermaid', {
    filter: (node) => node.nodeName === 'DIV' && (node as HTMLElement).hasAttribute('data-mermaid'),
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const mermaidContent = element.getAttribute('data-mermaid-content') || '';
      return `\n\`\`\`mermaid\n${mermaidContent}\n\`\`\`\n`;
    },
  });

  // Draw.io: div[data-drawio-*] → base64 HTML comment (portal :367-385).
  service.addRule('drawio', {
    filter: (node) => node.nodeName === 'DIV' && (node as HTMLElement).hasAttribute('data-drawio'),
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const diagramData = element.getAttribute('data-drawio-data') || '';
      const svgData = element.getAttribute('data-drawio-svg') || '';
      const themeMode = element.getAttribute('data-drawio-theme') || 'light';
      return `\n\n<!-- drawio-diagram\ndata: ${utf8ToBase64(diagramData)}\nsvg: ${utf8ToBase64(svgData)}\ntheme: ${themeMode}\n-->\n\n`;
    },
  });

  // Excalidraw: div[data-excalidraw-*] → base64 HTML comment (portal :387-405).
  service.addRule('excalidraw', {
    filter: (node) => node.nodeName === 'DIV' && (node as HTMLElement).hasAttribute('data-excalidraw'),
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const diagramData = element.getAttribute('data-excalidraw-data') || '';
      const svgData = element.getAttribute('data-excalidraw-svg') || '';
      const themeMode = element.getAttribute('data-excalidraw-theme') || 'light';
      return `\n\n<!-- excalidraw-diagram\ndata: ${utf8ToBase64(diagramData)}\nsvg: ${utf8ToBase64(svgData)}\ntheme: ${themeMode}\n-->\n\n`;
    },
  });

  // Callout: div[data-type=callout] → GFM [!TYPE] blockquote (portal :407-422).
  service.addRule('callout', {
    filter: (node) => node.nodeName === 'DIV' && (node as HTMLElement).getAttribute('data-type') === 'callout',
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const calloutType = (element.getAttribute('data-callout-type') || 'info').toUpperCase();
      const innerContent = service.turndown(element.innerHTML);
      const quotedContent = innerContent
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      return `\n> [!${calloutType}]\n${quotedContent}\n\n`;
    },
  });

  // Inline HTML marks (portal custom-html-utils.tsx:126-165 — fontFamily/abbreviation/kbd only).
  service.addRule('fontFamily', {
    filter: (node) =>
      node.nodeName.toLowerCase() === 'span' && (node as HTMLElement).style.fontFamily !== '',
    replacement: (content, node) => {
      const element = node as HTMLElement;
      const fontFamily = element.style.fontFamily;
      if (!fontFamily) return content;
      const normalizedFont = fontFamily.replace(/"/g, "'");
      return `<span style="font-family: ${normalizedFont}">${content}</span>`;
    },
  });

  service.addRule('abbreviation', {
    filter: (node) => node.nodeName.toLowerCase() === 'abbr',
    replacement: (content, node) => {
      const element = node as HTMLElement;
      const title = element.getAttribute('title');
      const attrs = title ? ` title="${title}"` : '';
      return `<abbr${attrs}>${content}</abbr>`;
    },
  });

  service.addRule('kbd', {
    filter: (node) => node.nodeName.toLowerCase() === 'kbd',
    replacement: (content) => `<kbd>${content}</kbd>`,
  });

  // P2-gap fix (portal custom-html-utils.tsx:11-48 + 126-165): the four
  // pre-existing marks (Highlight→mark, Underline→u, Subscript→sub,
  // Superscript→sup) had NO turndown rules, so their styling was DROPPED on
  // markdown save→reload. Shapes portal-exact: mark preserves its style
  // attribute, u/sub/sup carry no attributes.
  service.addRule('mark', {
    filter: (node) => node.nodeName.toLowerCase() === 'mark',
    replacement: (content, node) => {
      const element = node as HTMLElement;
      const style = element.getAttribute('style');
      const attrs = style ? ` style="${style}"` : '';
      return `<mark${attrs}>${content}</mark>`;
    },
  });

  service.addRule('underline', {
    filter: (node) => node.nodeName.toLowerCase() === 'u',
    replacement: (content) => `<u>${content}</u>`,
  });

  service.addRule('subscript', {
    filter: (node) => node.nodeName.toLowerCase() === 'sub',
    replacement: (content) => `<sub>${content}</sub>`,
  });

  service.addRule('superscript', {
    filter: (node) => node.nodeName.toLowerCase() === 'sup',
    replacement: (content) => `<sup>${content}</sup>`,
  });

  return service;
};

const turndown = createTurndownService();

export const convertHtmlToMarkdown = (html: string): string => {
  if (!html || typeof html !== 'string') return '';
  return turndown.turndown(html);
};

// Minimal structural typing over hast nodes (no runtime dependency on @types/hast).
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const isElement = (node: HastNode, tag: string): boolean =>
  node.type === 'element' && node.tagName === tag;

const isTaskItemLi = (node: HastNode): boolean => {
  if (!isElement(node, 'li')) return false;
  const className = node.properties?.className;
  return Array.isArray(className) && className.includes('task-list-item');
};

const elementChildren = (node: HastNode): HastNode[] =>
  (node.children ?? []).filter((child) => child.type === 'element');

const hasClass = (node: HastNode, className: string): boolean => {
  const classList = node.properties?.className;
  if (Array.isArray(classList)) return classList.some((cn) => String(cn) === className);
  if (typeof classList === 'string') return classList.split(' ').includes(className);
  return false;
};

/**
 * P3 diagram-comment parse-back (portal markdown-utils.tsx:462-527): a raw
 * `<!-- drawio-diagram … -->` / `<!-- excalidraw-diagram … -->` HTML comment
 * (surviving rehype-raw as a `comment` node) becomes the TipTap-consumable
 * `div[data-drawio-*]` / `div[data-excalidraw-*]` shape. Base64 payloads are
 * decoded back to raw markup; malformed base64 leaves the comment untouched
 * (portal's empty catch).
 */
const applyDiagramComment = (node: HastNode): void => {
  const commentValue = String(node.value ?? '');
  if (commentValue.includes('drawio-diagram')) {
    const dataMatch = commentValue.match(/data:\s*([^\n]+)/);
    const svgMatch = commentValue.match(/svg:\s*([^\n]+)/);
    const themeMatch = commentValue.match(/theme:\s*([^\n]+)/);
    if (dataMatch && svgMatch) {
      try {
        const diagramData = base64ToUtf8(dataMatch[1].trim());
        const svgData = base64ToUtf8(svgMatch[1].trim());
        const themeMode = themeMatch ? themeMatch[1].trim() : 'light';
        node.type = 'element';
        node.tagName = 'div';
        node.properties = {
          'data-drawio': '',
          'data-drawio-data': diagramData,
          'data-drawio-svg': svgData,
          'data-drawio-theme': themeMode,
        };
        node.children = [{ type: 'text', value: '[Draw.io Diagram]' }];
      } catch {
        // Portal-exact: undecodable payload keeps the raw comment node.
      }
    }
    return;
  }
  if (commentValue.includes('excalidraw-diagram')) {
    const dataMatch = commentValue.match(/data:\s*([^\n]+)/);
    const svgMatch = commentValue.match(/svg:\s*([^\n]+)/);
    const themeMatch = commentValue.match(/theme:\s*([^\n]+)/);
    if (dataMatch) {
      try {
        const diagramData = base64ToUtf8(dataMatch[1].trim());
        const svgData = svgMatch ? base64ToUtf8(svgMatch[1].trim()) : '';
        const themeMode = themeMatch ? themeMatch[1].trim() : 'light';
        node.type = 'element';
        node.tagName = 'div';
        node.properties = {
          'data-excalidraw': '',
          'data-excalidraw-data': diagramData,
          'data-excalidraw-svg': svgData,
          'data-excalidraw-theme': themeMode,
        };
        node.children = [{ type: 'text', value: '[Excalidraw Diagram]' }];
      } catch {
        // Portal-exact: undecodable payload keeps the raw comment node.
      }
    }
  }
};

/** Sized-image parse-back (portal :531-544): `style="width: Npx; height: Npx"` → width/height attrs (style kept). */
const applyImageSizing = (node: HastNode): void => {
  if (!node.properties?.style) return;
  const style = String(node.properties.style);
  const widthMatch = style.match(/width:\s*(\d+)px/);
  const heightMatch = style.match(/height:\s*(\d+)px/);
  if (widthMatch) node.properties.width = widthMatch[1];
  if (heightMatch) node.properties.height = heightMatch[1];
  node.properties.style = style;
};

/** Callout parse-back (portal :705-728): `> [!TYPE] …` → div[data-type=callout][data-callout-type]. */
const applyCalloutBlockquote = (node: HastNode): void => {
  const children = node.children ?? [];
  const firstParagraph = children.find(
    (child) => child.type === 'element' && child.tagName === 'p',
  );
  const textNode = firstParagraph?.children?.[0];
  if (textNode?.type !== 'text') return;
  const match = String(textNode.value).match(/^\[!(INFO|WARNING|SUCCESS|DANGER)\]\s*/i);
  if (!match) return;
  const calloutType = match[1].toLowerCase();
  textNode.value = String(textNode.value).replace(match[0], '');
  if (!textNode.value && firstParagraph?.children?.length === 1) {
    node.children = children.filter((child) => child !== firstParagraph);
  }
  node.tagName = 'div';
  node.properties = {
    'data-type': 'callout',
    'data-callout-type': calloutType,
    class: `callout callout-${calloutType}`,
  };
};

/** Mermaid parse-back (portal :730-768): pre>code.language-mermaid → div[data-mermaid][data-mermaid-content]. */
const applyMermaidFence = (node: HastNode): void => {
  const children = node.children ?? [];
  if (children.length === 0) return;
  const codeNode = children[0];
  if (codeNode.type !== 'element' || codeNode.tagName !== 'code') return;
  if (!hasClass(codeNode, 'language-mermaid')) return;
  let mermaidContent = '';
  const codeChildren = codeNode.children ?? [];
  if (codeChildren.length > 0 && codeChildren[0].type === 'text') {
    mermaidContent = String(codeChildren[0].value ?? '').trim();
  }
  node.tagName = 'div';
  node.properties = {
    'data-mermaid': '',
    'data-mermaid-content': mermaidContent,
  };
  node.children = [{ type: 'text', value: '[Mermaid Diagram]' }];
};

/**
 * P3 shapes parse-back, mirroring the portal's unified visitor
 * (markdown-utils.tsx:458-772): diagram comments → diagram divs, sized
 * images → width/height attrs, [!TYPE] blockquotes → callout divs, and
 * ```mermaid fences → div[data-mermaid]. Runs after rehype-raw, so raw HTML
 * has already been re-parsed into real elements/comments.
 */
const p3RichBlocks = () => (tree: HastNode): void => {
  const walk = (node: HastNode): void => {
    for (const child of node.children ?? []) walk(child);
    if (node.type === 'comment') {
      applyDiagramComment(node);
      return;
    }
    if (node.type !== 'element') return;
    if (node.tagName === 'img') applyImageSizing(node);
    else if (node.tagName === 'blockquote') applyCalloutBlockquote(node);
    else if (node.tagName === 'pre') applyMermaidFence(node);
  };
  walk(tree);
};

/** The item's own checkbox marker — first `input[type=checkbox]` in DFS order
 * (GFM always emits it as the first thing inside the item's first block). */
const findCheckboxInput = (node: HastNode): HastNode | undefined => {
  for (const child of node.children ?? []) {
    if (isElement(child, 'input') && child.properties?.type === 'checkbox') return child;
    const deep = findCheckboxInput(child);
    if (deep) return deep;
  }
  return undefined;
};

const removeChildNode = (node: HastNode, target: HastNode): void => {
  const kids = node.children ?? [];
  const index = kids.indexOf(target);
  if (index >= 0) {
    kids.splice(index, 1);
    return;
  }
  for (const child of kids) removeChildNode(child, target);
};

/**
 * Post-`remark-rehype` hast-tree transform that reshapes GFM task lists into the
 * TipTap-consumable shape TipTap's TaskList/TaskItem parse rules expect
 * (`<ul data-type="taskList"><li data-type="taskItem" data-checked="…">…`),
 * dropping the GitHub-flavored checkbox `<input>` marker. Walking the tree keeps
 * nested lists correct by construction (no string/regex parsing). remark-rehype
 * tags task lists with `class="contains-task-list"` and items with
 * `task-list-item`; we key on those (with an all-items fallback for plugins
 * that only tag the items). Note: `rehype-raw` re-parses the tree, so
 * whitespace text nodes can sit between elements — match on elements only.
 */
const tiptapShapedTaskLists = () => (tree: HastNode): void => {
  const walk = (node: HastNode): void => {
    for (const child of node.children ?? []) walk(child);
    if (!isElement(node, 'ul')) return;
    const items = elementChildren(node);
    if (items.length === 0) return;
    const markerClass = Array.isArray(node.properties?.className)
      && (node.properties?.className as unknown[]).includes('contains-task-list');
    if (!markerClass && !items.every((item) => isTaskItemLi(item))) return;

    node.properties = { ...node.properties, dataType: 'taskList' };
    for (const li of items) {
      const input = findCheckboxInput(li);
      const checked = Boolean(input?.properties?.checked);
      li.properties = { ...li.properties, dataType: 'taskItem', dataChecked: String(checked) };
      if (input) {
        li.children ??= [];
        removeChildNode(li, input);
      }
    }
  };
  walk(tree);
};

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(tiptapShapedTaskLists)
  .use(p3RichBlocks)
  .use(rehypeStringify);

export const convertMarkdownToHtml = (markdown: string): string => {
  if (!markdown || typeof markdown !== 'string') return '';
  return String(markdownProcessor.processSync(markdown));
};