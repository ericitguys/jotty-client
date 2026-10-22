import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type {
  BrainVMNode,
  BrainVMEdge,
  BrainColourMode,
  BrainPalette,
  GraphRef,
} from './brainView';
import {
  useElementSize,
  nodeColour,
  nodeRadius,
  edgeColour,
  endpointId,
  neighbourMap,
  isItemNode,
  rgba,
  CHARGE_FORCE,
  CHARGE_REACH,
  LINK_DISTANCE,
  PERSONAL_SPACE,
  REGION_FORCE,
  GRAVITY_FORCE,
  COOLDOWN_TICKS,
  FOCUS_ZOOM,
  FLY_MS,
  FIT_PADDING,
  DIM_ALPHA,
  HUB_LABELS,
  CLICK_SLOP_PX,
  CLICK_MAX_MS,
  DOUBLE_CLICK_MS,
  STAMP_SCALE,
  LABEL_MAX_CHARS,
  LABEL_FONT_PX,
  LABEL_PAD_PX,
  GLYPH_MIN_PX,
} from './brainView';
import { collideForce, gravityForce, regionForce } from './brainForces';

interface Props {
  nodes: BrainVMNode[];
  edges: BrainVMEdge[];
  focusId: string | null;
  selectedId: string | null;
  colourMode: BrainColourMode;
  palette: BrainPalette;
  flyTo: { id: string; at: number } | null;
  onSelect: (id: string | null) => void;
  onOpen: (node: BrainVMNode) => void;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type CanvasNode = BrainVMNode & { x?: number; y?: number };
type CanvasLink = BrainVMEdge & { source: string | CanvasNode; target: string | CanvasNode };

const _overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const _clip = (title: string) =>
  title.length > LABEL_MAX_CHARS ? `${title.slice(0, LABEL_MAX_CHARS - 1)}…` : title;

const GLYPH_LETTER: Record<string, string> = {
  note: 'n',
  checklist: 'c',
  tag: 't',
  ghost: '?',
};

export default function BrainCanvas2D({
  nodes,
  edges,
  focusId,
  selectedId,
  colourMode,
  palette,
  flyTo,
  onSelect,
  onOpen,
}: Props) {
  const graphRef = useRef<GraphRef>(undefined);
  const settledRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasContext, setHasContext] = useState(true);
  const { ref: containerRef, size } = useElementSize<HTMLDivElement>();
  const [hoverId, setHoverId] = useState<string | null>(null);
  const hoverRef = useRef<CanvasNode | null>(null);
  const pressRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const lastClickRef = useRef({ id: '', at: 0 });

  useEffect(() => {
    // jsdom gives a canvas with no context; real webview gives 2d. Probe once
    // per mount and render a structural stub if the context is absent.
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    setHasContext(!!ctx);
  }, []);

  const emptyGraphData = useMemo(() => ({ nodes: [] as CanvasNode[], links: [] as CanvasLink[] }), []);

  const graphData = useMemo(
    () => ({
      nodes: nodes.map((node) => ({ ...node })) as CanvasNode[],
      links: edges.map((edge) => ({ ...edge })) as CanvasLink[],
    }),
    [nodes, edges],
  );

  useEffect(() => {
    if (!hasContext) return;
    const graph = graphRef.current;
    if (!graph) return;
    graph.d3Force('charge')?.strength?.(CHARGE_FORCE)?.distanceMax?.(CHARGE_REACH);
    graph.d3Force('link')?.distance?.(LINK_DISTANCE);
    graph.d3Force('collide', collideForce((node) => nodeRadius(node as BrainVMNode, false) + PERSONAL_SPACE));
    graph.d3Force('region', regionForce(REGION_FORCE));
    graph.d3Force('gravity', gravityForce(GRAVITY_FORCE));
  }, [size.width, graphData, hasContext]);

  const nodeAt = (event: React.PointerEvent): CanvasNode | null => {
    const graph = graphRef.current;
    const container = containerRef.current;
    if (!graph || !container) return null;
    const rect = container.getBoundingClientRect();
    const point = graph.screen2GraphCoords(event.clientX - rect.left, event.clientY - rect.top);
    let best: CanvasNode | null = null;
    let bestDistance = Infinity;
    graphData.nodes.forEach((candidate) => {
      const distance = Math.hypot((candidate.x || 0) - point.x, (candidate.y || 0) - point.y);
      const reach = Math.max(6, nodeRadius(candidate, false)) * 1.4;
      if (distance <= reach && distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    });
    return best;
  };

  const onPointerDown = (event: React.PointerEvent) => {
    pressRef.current = { x: event.clientX, y: event.clientY, at: Date.now() };
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press || event.button !== 0) return;
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (moved > CLICK_SLOP_PX || Date.now() - press.at > CLICK_MAX_MS) return;

    const node = hoverRef.current || nodeAt(event);
    if (!node) {
      onSelect(null);
      return;
    }
    const now = Date.now();
    const last = lastClickRef.current;
    lastClickRef.current = { id: node.id, at: now };
    if (last.id === node.id && now - last.at < DOUBLE_CLICK_MS) onOpen(node);
    else onSelect(node.id);
  };

  const neighbours = useMemo(() => neighbourMap(edges, true), [edges]);
  const hubs = useMemo(
    () =>
      new Set(
        [...nodes]
          .filter(isItemNode)
          .sort((a, b) => b.links - a.links)
          .slice(0, HUB_LABELS)
          .map((node) => node.id),
      ),
    [nodes],
  );

  const anchor = hoverId || selectedId || focusId;
  const lit = useMemo(
    () =>
      anchor
        ? new Set([anchor, ...Array.from(neighbours.get(anchor) || [])])
        : null,
    [anchor, neighbours],
  );

  const centreOn = (id: string) => {
    const node = graphData.nodes.find((candidate) => candidate.id === id);
    if (!node || node.x === undefined || node.y === undefined) return;
    graphRef.current?.centerAt(node.x, node.y, FLY_MS);
    graphRef.current?.zoom(FOCUS_ZOOM, FLY_MS);
  };

  useEffect(() => {
    if (flyTo) centreOn(flyTo.id);
  }, [flyTo]);

  const isLitLink = (link: CanvasLink) =>
    !lit ||
    (lit.has(endpointId(link.source)) && lit.has(endpointId(link.target)));

  const drawNode = (raw: object, ctx: CanvasRenderingContext2D, scale: number) => {
    const node = raw as CanvasNode;
    const isAnchor = node.id === focusId || node.id === selectedId;
    const radius = nodeRadius(node, node.id === focusId) * STAMP_SCALE;
    const x = node.x || 0;
    const y = node.y || 0;

    ctx.globalAlpha = !lit || lit.has(node.id) ? 1 : DIM_ALPHA;
    if (isAnchor || node.id === hoverId) {
      ctx.beginPath();
      ctx.arc(x, y, radius * 1.55, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.2 / scale, radius * 0.14);
      ctx.strokeStyle = rgba(palette.primary, isAnchor ? 1 : 0.55);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = nodeColour(node, colourMode, palette);
    ctx.fill();
    ctx.lineWidth = Math.max(0.8 / scale, radius * 0.12);
    ctx.strokeStyle = rgba(palette.background);
    ctx.stroke();

    if (radius * scale >= GLYPH_MIN_PX) {
      ctx.fillStyle = rgba(palette.background);
      ctx.font = `${Math.max(6, radius * 0.7)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(GLYPH_LETTER[node.kind] ?? '?', x, y);
    }

    ctx.globalAlpha = 1;
  };

  const labelOrder = useMemo(() => {
    const rank = (node: CanvasNode) => {
      if (node.id === hoverId) return 0;
      if (node.id === selectedId || node.id === focusId) return 1;
      if (lit?.has(node.id)) return 2;
      if (!lit && hubs.has(node.id)) return 3;
      return -1;
    };
    return graphData.nodes
      .map((node) => ({ node, rank: rank(node) }))
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank || b.node.links - a.node.links)
      .map((entry) => entry.node);
  }, [graphData.nodes, hoverId, selectedId, focusId, lit, hubs]);

  const drawLabels = (ctx: CanvasRenderingContext2D, scale: number) => {
    const taken: Box[] = [];
    const font = LABEL_FONT_PX / scale;
    const pad = LABEL_PAD_PX / scale;
    ctx.font = `600 ${font}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    labelOrder.forEach((node) => {
      const text = _clip(node.title);
      const width = ctx.measureText(text).width + pad * 2;
      const height = font + pad * 1.4;
      const x = node.x || 0;
      const top = (node.y || 0) + nodeRadius(node, node.id === focusId) * STAMP_SCALE * 1.7 + 2 / scale;
      const box = { left: x - width / 2, top, right: x + width / 2, bottom: top + height };
      if (taken.some((other) => _overlaps(box, other))) return;
      taken.push(box);

      ctx.beginPath();
      // roundRect is available in modern webviews; jsdom's canvas 2d context is
      // null so this path only runs in real environments.
      (ctx as unknown as { roundRect?: (...args: unknown[]) => void }).roundRect?.(box.left, box.top, width, height, height / 2);
      ctx.fillStyle = rgba(palette.card);
      ctx.fill();
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = rgba(palette.border);
      ctx.stroke();
      ctx.fillStyle = rgba(palette.foreground);
      ctx.fillText(text, x, box.top + height / 2);
    });
  };

  const paintHitArea = (raw: object, colour: string, ctx: CanvasRenderingContext2D) => {
    const node = raw as CanvasNode;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(
      node.x || 0,
      node.y || 0,
      Math.max(6, nodeRadius(node, false)),
      0,
      2 * Math.PI,
    );
    ctx.fill();
  };

  if (!hasContext) {
    return (
      <div className="brain-canvas-stub" data-node-count={nodes.length} data-testid="brain-canvas-stub">
        <canvas ref={canvasRef} style={{ display: 'none' }} />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="brain-canvas"
      onPointerDownCapture={onPointerDown}
      onPointerUpCapture={onPointerUp}
    >
      {size.width > 0 && (
        <ForceGraph2D
          ref={graphRef}
          width={size.width}
          height={size.height}
          graphData={graphData}
          nodeId="id"
          nodeLabel={() => ''}
          nodeCanvasObject={drawNode}
          onRenderFramePost={drawLabels}
          nodePointerAreaPaint={paintHitArea}
          linkColor={(link) =>
            edgeColour(
              link as unknown as BrainVMEdge,
              palette,
              isLitLink(link as unknown as CanvasLink),
            )
          }
          linkWidth={(link) =>
            lit && isLitLink(link as unknown as CanvasLink) ? 1.6 : 0.6
          }
          linkVisibility={(link) => {
            const canvasLink = link as unknown as CanvasLink;
            if (canvasLink.kind !== 'suggested') return true;
            return Boolean(anchor) &&
              (endpointId(canvasLink.source) === anchor || endpointId(canvasLink.target) === anchor);
          }}
          linkLineDash={(link) =>
            (link as unknown as CanvasLink).kind === 'suggested'
              ? [3, 3]
              : null
          }
          linkDirectionalParticles={(link) =>
            lit &&
            isLitLink(link as unknown as CanvasLink) &&
            (link as unknown as CanvasLink).kind !== 'tag'
              ? 3
              : 0
          }
          linkDirectionalParticleWidth={2}
          linkDirectionalParticleColor={() => rgba(palette.primary, 0.95)}
          onNodeHover={(node) => {
            hoverRef.current = (node as unknown as CanvasNode | null) || null;
            setHoverId(hoverRef.current?.id || null);
          }}
          onNodeRightClick={(node) => onOpen(node as unknown as BrainVMNode)}
          onEngineStop={() => {
            if (settledRef.current) return;
            settledRef.current = true;
            if (focusId) centreOn(focusId);
            else graphRef.current?.zoomToFit(600, FIT_PADDING);
          }}
          cooldownTicks={COOLDOWN_TICKS}
        />
      )}
    </div>
  );
}
