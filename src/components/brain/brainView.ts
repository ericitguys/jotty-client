import { useEffect, useMemo, useRef, useState } from 'react';
import type { ForceGraphMethods, LinkObject, NodeObject } from 'react-force-graph-2d';
export { spreadRadius } from './brainForces';

export type Rgb = [number, number, number];

export interface BrainPalette {
  primary: Rgb;
  foreground: Rgb;
  muted: Rgb;
  background: Rgb;
  card: Rgb;
  border: Rgb;
}

export interface BrainVMNode {
  id: string;
  kind: string;
  title: string;
  category?: string | null;
  links: number;
  distance?: number | null;
}

export interface BrainVMEdge {
  source: string;
  target: string;
  kind: string;
  weight: number;
}

export type BrainColourMode = 'type' | 'category';
export type BrainDimension = '2d' | '3d';

export interface BrainFilterFlags {
  notes: boolean;
  checklists: boolean;
  tags: boolean;
  ghosts: boolean;
  suggestions: boolean;
  orphans: boolean;
}

export interface BrainScope {
  local: boolean;
  depth: number;
}

const MAX_DEPTH = 3;

const KIND_FILTER: Record<string, keyof BrainFilterFlags> = {
  note: 'notes',
  checklist: 'checklists',
  tag: 'tags',
  ghost: 'ghosts',
};

export const neighbourMap = (edges: BrainVMEdge[], withSuggested = false) => {
  const map = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    if (!map.has(from)) map.set(from, new Set());
    map.get(from)!.add(to);
  };
  edges.forEach((edge) => {
    if (!withSuggested && edge.kind === 'suggested') return;
    add(edge.source, edge.target);
    add(edge.target, edge.source);
  });
  return map;
};

const _within = (focus: string, neighbours: Map<string, Set<string>>, depth: number) => {
  const reached = new Set<string>([focus]);
  let frontier = [focus];
  for (let level = 0; level < depth; level++) {
    const next: string[] = [];
    frontier.forEach((id) =>
      neighbours.get(id)?.forEach((other) => {
        if (reached.has(other)) return;
        reached.add(other);
        next.push(other);
      }),
    );
    frontier = next;
  }
  return reached;
};

export const brainView = (
  nodes: BrainVMNode[],
  edges: BrainVMEdge[],
  filters: BrainFilterFlags,
  scope: BrainScope,
  focus: string | null,
): { nodes: BrainVMNode[]; edges: BrainVMEdge[] } => {
  const filteredEdges = edges.filter(
    (edge) =>
      (filters.suggestions || edge.kind !== 'suggested') &&
      (filters.tags || edge.kind !== 'tag'),
  );
  const linked = neighbourMap(filteredEdges);
  const local =
    scope.local && focus
      ? _within(focus, neighbourMap(edges, true), Math.min(scope.depth, MAX_DEPTH))
      : null;

  const filteredNodes = nodes.filter((node) => {
    if (!filters[KIND_FILTER[node.kind]]) return false;
    if (local && !local.has(node.id)) return false;
    if (!filters.orphans && !linked.has(node.id) && node.id !== focus) return false;
    return true;
  });

  const kept = new Set(filteredNodes.map((node) => node.id));
  const outEdges = filteredEdges.filter(
    (edge) => kept.has(edge.source) && kept.has(edge.target),
  );
  // Recompute adjacency from the kept edges for orphan calculation so dropped
  // tag/suggestion edges don't strand nodes that still have a kept edge.
  const keptLinked = neighbourMap(outEdges);
  const finalNodes = filteredNodes.filter((node) => {
    if (!filters.orphans && !keptLinked.has(node.id) && node.id !== focus) return false;
    return true;
  });
  const finalKept = new Set(finalNodes.map((node) => node.id));
  return {
    nodes: finalNodes,
    edges: outEdges.filter((edge) => finalKept.has(edge.source) && finalKept.has(edge.target)),
  };
};

export const searchNodes = (
  nodes: BrainVMNode[],
  query: string,
  limit = 8,
): BrainVMNode[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return nodes
    .filter((node) => node.title.toLowerCase().includes(needle))
    .sort((a, b) => b.links - a.links)
    .slice(0, limit);
};

const _hue = (text: string): number => {
  let hash = 0;
  for (let i = 0; i < text.length; i++)
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash % 360;
};

export const mix = (from: Rgb, to: Rgb, amount: number): Rgb => [
  Math.round(from[0] + (to[0] - from[0]) * amount),
  Math.round(from[1] + (to[1] - from[1]) * amount),
  Math.round(from[2] + (to[2] - from[2]) * amount),
];

export const rgba = ([r, g, b]: Rgb, alpha = 1): string =>
  `rgba(${r}, ${g}, ${b}, ${alpha})`;

const _categoryTint = (category: string, palette: BrainPalette): Rgb => {
  const spread = (_hue(category) % 7) / 7;
  return spread < 0.5
    ? mix(palette.primary, palette.foreground, spread * 0.9)
    : mix(palette.primary, palette.background, (spread - 0.5) * 0.9);
};

export const nodeRgb = (
  node: BrainVMNode,
  mode: BrainColourMode,
  palette: BrainPalette,
): Rgb => {
  if (node.kind === 'ghost') return palette.muted;
  if (node.kind === 'tag') return mix(palette.primary, palette.background, 0.45);
  if (mode === 'category') {
    return _categoryTint(node.category || node.kind, palette);
  }
  return node.kind === 'checklist'
    ? mix(palette.primary, palette.foreground, 0.45)
    : palette.primary;
};

export const nodeColour = (
  node: BrainVMNode,
  mode: BrainColourMode,
  palette: BrainPalette,
): string => rgba(nodeRgb(node, mode, palette));

export const edgeRgb = (edge: BrainVMEdge, palette: BrainPalette): Rgb => {
  if (edge.kind === 'suggested') return palette.muted;
  if (edge.kind === 'tag') return mix(palette.primary, palette.background, 0.55);
  if (edge.kind === 'wiki') return palette.primary;
  if (edge.kind === 'mention') return mix(palette.primary, palette.foreground, 0.5);
  if (edge.kind === 'checklist') return mix(palette.primary, palette.muted, 0.6);
  return mix(palette.foreground, palette.background, 0.35);
};

export const edgeColour = (edge: BrainVMEdge, palette: BrainPalette, lit: boolean): string =>
  rgba(edgeRgb(edge, palette), lit ? 0.85 : 0.25);

export const nodeRadius = (node: BrainVMNode, emphasised: boolean): number => {
  if (node.kind === 'tag') return 2.2;
  const base = Math.min(9, 3.2 + Math.sqrt(node.links) * 1.1);
  return emphasised ? base * 1.35 : base;
};

export const endpointId = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value)
    return String((value as { id: unknown }).id);
  return '';
};

export const isItemNode = (node?: BrainVMNode | null): boolean =>
  node?.kind === 'note' || node?.kind === 'checklist';

export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, size };
}

export const getBrainPalette = (): BrainPalette => {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: Rgb): Rgb => {
    const value = style.getPropertyValue(name).trim();
    if (!value) return fallback;
    if (value.startsWith('#')) {
      const hex = value.slice(1);
      if (hex.length === 3) {
        const r = parseInt(hex[0] + hex[0], 16);
        const g = parseInt(hex[1] + hex[1], 16);
        const b = parseInt(hex[2] + hex[2], 16);
        return [r, g, b];
      }
      if (hex.length === 6) {
        return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
      }
      return fallback;
    }
    const rgb = value.match(/rgba?\(([^)]+)\)/);
    if (rgb) {
      const parts = rgb[1].split(',').map((p) => parseFloat(p.trim()));
      if (parts.length >= 3 && parts.every((n) => !Number.isNaN(n))) {
        return [parts[0], parts[1], parts[2]];
      }
    }
    return fallback;
  };

  return {
    primary: read('--accent', [157, 95, 254]),
    foreground: read('--fg', [249, 249, 249]),
    muted: read('--muted', [163, 156, 175]),
    background: read('--bg', [14, 24, 64]),
    card: read('--surface', [27, 34, 51]),
    border: read('--border', [38, 47, 63]),
  };
};

export function useBrainPalette(): BrainPalette {
  const [palette, setPalette] = useState(() => getBrainPalette());

  useEffect(() => {
    const update = () => setPalette(getBrainPalette());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  return palette;
}

type CanvasNode = NodeObject<BrainVMNode> & BrainVMNode;
type CanvasLink = LinkObject<BrainVMNode, BrainVMEdge> & BrainVMEdge;

export const FOCUS_ZOOM = 3;
export const FLY_MS = 1100;
export const FIT_PADDING = 120;
export const DIM_ALPHA = 0.15;
export const HUB_LABELS = 10;
export const CLICK_SLOP_PX = 6;
export const CLICK_MAX_MS = 450;
export const DOUBLE_CLICK_MS = 350;
export const CHARGE_FORCE = -110;
export const CHARGE_REACH = 500;
export const LINK_DISTANCE = 42;
export const PERSONAL_SPACE = 5;
export const REGION_FORCE = 0.05;
export const GRAVITY_FORCE = 0.012;
export const COOLDOWN_TICKS = 120;

export const STAMP_SCALE = 1.05;
export const LABEL_MAX_CHARS = 28;
export const LABEL_FONT_PX = 12;
export const LABEL_PAD_PX = 5;
export const GLYPH_MIN_PX = 7;

export type GraphRef = ForceGraphMethods<CanvasNode, CanvasLink> | undefined;
