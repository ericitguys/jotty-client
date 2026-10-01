// List-row snippet extraction (UX tier A task 2; spec L7). The plan sketched
// regex-strip + entity subset; we ride DOMParser (proven available in jsdom,
// src/editor/markdown.test.ts) instead so entity decoding is the DOM's, not a
// subset table. Block-level elements get a space around their collected text
// so '<h1>t1</h1><p>t2</p>' collapses to 't1 t2' rather than glued 't1t2'.
// Empty/tags-only content returns '' — NoteList renders no .row-snippet span.

const BLOCK_SEL =
  'p,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,pre,div,table,tr,td,th,br,hr';

// R5 (T2-review): script/style carry code, not note text — the walk drops
// their WHOLE subtree (probe: '<p>x</p><script>var steal = 1</script><p>y</p>'
// must be 'x y', not 'x var steal = 1 y').
const SKIP_SEL = 'script,style';

const TEXT_NODE = 3; // DOM Node.TEXT_NODE

export function snippetFromHtml(html: string, max = 70): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      parts.push(node.nodeValue ?? '');
      return;
    }
    const el = node as Element;
    if (el.matches?.(SKIP_SEL)) return;
    const isBlock = !!el.matches?.(BLOCK_SEL);
    if (isBlock) parts.push(' ');
    node.childNodes.forEach(walk);
    if (isBlock) parts.push(' ');
  };
  walk(doc.body);
  const text = parts.join('').replace(/\s+/g, ' ').trim(); // \s eats &nbsp;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut).trimEnd();
}