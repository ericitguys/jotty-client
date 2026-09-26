import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeStringify from 'rehype-stringify';

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
  .use(rehypeStringify);

export const convertMarkdownToHtml = (markdown: string): string => {
  if (!markdown || typeof markdown !== 'string') return '';
  return String(markdownProcessor.processSync(markdown));
};