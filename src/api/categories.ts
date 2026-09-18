import type { CategoriesDto, CategoryNode, ChecklistDto, NoteDto } from './types';

// The server derives GET /api/categories from its on-disk directory tree
// (app/_utils/category-utils.ts buildCategoryTree): every category is a
// directory, a node's `count` is the number of files DIRECTLY in it (files in
// subdirectories count only toward the subdirectory), children are
// subdirectories, and the response is a depth-first pre-order list with
// siblings sorted by name. Notes and checklists derive separate trees.
//
// Every synced note/checklist row carries its category string, so the client
// can reproduce that same tree locally — this is the offline fallback for a
// cold start where the live fetch has never succeeded (no last-known value to
// preserve). Category strings are used verbatim (they ARE the server's
// directory paths); empty segments collapse. An EMPTY category string maps to
// "Uncategorized" exactly like the server's REST layer does
// (`category: note.category || "Uncategorized"` — uncategorized notes live in
// the server's Uncategorized/ directory, so /api/categories shows that node);
// any other string is kept verbatim, including unusual ones, because the
// server performs no trimming either.
export const UNCATEGORIZED = 'Uncategorized';
const ARCHIVED = '.archive';

export function deriveCategories(notes: NoteDto[], checklists: ChecklistDto[]): CategoriesDto {
  return {
    notes: deriveSide(notes.map((n) => n.category)),
    checklists: deriveSide(checklists.map((c) => c.category)),
  };
}

function deriveSide(categories: string[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const raw of categories) {
    const segments = (raw || UNCATEGORIZED).split('/').filter((s) => s.length > 0);
    // paths through the archive directory are excluded server-side
    // (filterArchived); rows pulled from the server never carry them, this is
    // defense in depth for a pathological manually-typed category
    if (segments.length === 0 || segments.includes(ARCHIVED)) continue;
    for (let i = 0; i < segments.length; i++) {
      const path = segments.slice(0, i + 1).join('/');
      const node = nodes.get(path) ?? { name: segments[i], path, count: 0, level: i };
      if (i === segments.length - 1) node.count += 1;
      nodes.set(path, node);
    }
  }
  return orderDfs(nodes);
}

// Children of each directory sorted by name, emitted parents-first (DFS).
function orderDfs(nodes: Map<string, CategoryNode>): CategoryNode[] {
  const byParent = new Map<string, CategoryNode[]>();
  for (const node of nodes.values()) {
    const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
    const list = byParent.get(parent) ?? [];
    list.push(node);
    byParent.set(parent, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const out: CategoryNode[] = [];
  const walk = (parent: string) => {
    for (const node of byParent.get(parent) ?? []) {
      out.push(node);
      walk(node.path);
    }
  };
  walk('');
  return out;
}