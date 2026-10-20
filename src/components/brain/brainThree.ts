import * as THREE from 'three';

export interface StampInk {
  fill: string;
  edge: string;
  mark: string;
}

export interface PaintTarget {
  body: number;
  ring: number;
  label: number;
}

export interface NodeParts {
  group: THREE.Group;
  body: THREE.Sprite;
  hit: THREE.Mesh;
  ring: THREE.Sprite;
  label: THREE.Sprite;
  labelAspect: number;
  crowded: boolean;
  target: PaintTarget;
}

export interface PartColours {
  body: string;
  halo: string;
  edge: string;
  mark: string;
  ink: string;
  paper: string;
  border: string;
}

interface BrainNodeLike {
  id: string;
  kind: string;
  title: string;
  category?: string | null;
  checklistType?: string | null;
}

const LABEL_FONT_PX = 40;
const LABEL_PAD_X = 18;
const LABEL_PAD_Y = 10;
const LABEL_MAX_CHARS = 32;
const LABEL_SCREEN_HEIGHT = 0.026;
export const LABEL_PIXEL_SHARE = LABEL_SCREEN_HEIGHT * 1.35;
const LABEL_LIFT = 3;
const RING_TEXTURE_PX = 128;
const STAMP_TEXTURE_PX = 128;
const STAMP_PADDING = 1.25;
const TWEEN_RATE = 0.2;
const SETTLED = 0.004;
const HIT_SCALE = 1.8;
const HIT_MIN_EXTRA = 2.5;
const PICKABLE_OPACITY = 0.3;
const EDGE_SHARE = 0.16;
const TILE_CORNER = 0.34;
const ICON_SHARE = 1.3;
const ICON_BOX = 24;
const ICON_STROKE = 1.9;

enum NodeShapes {
  DISC = 'disc',
  TILE = 'tile',
  GEM = 'gem',
  HOLLOW = 'hollow',
}

enum NodeGlyphs {
  PAGE = 'page',
  TICK = 'tick',
  COLUMNS = 'columns',
  HASH = 'hash',
  PLUS = 'plus',
}

const GLYPH_LETTER: Record<NodeGlyphs, string> = {
  [NodeGlyphs.PAGE]: 'n',
  [NodeGlyphs.TICK]: 'c',
  [NodeGlyphs.COLUMNS]: 'k',
  [NodeGlyphs.HASH]: '#',
  [NodeGlyphs.PLUS]: '+',
};

const shapeOf = (node: BrainNodeLike): NodeShapes => {
  if (node.kind === 'ghost') return NodeShapes.HOLLOW;
  if (node.kind === 'tag') return NodeShapes.GEM;
  if (node.kind === 'checklist') return NodeShapes.TILE;
  return NodeShapes.DISC;
};

const glyphOf = (node: BrainNodeLike): NodeGlyphs => {
  if (node.kind === 'ghost') return NodeGlyphs.PLUS;
  if (node.kind === 'tag') return NodeGlyphs.HASH;
  if (node.kind === 'checklist') {
    return node.checklistType === 'kanban' ? NodeGlyphs.COLUMNS : NodeGlyphs.TICK;
  }
  return NodeGlyphs.PAGE;
};

export const stampKey = (node: BrainNodeLike, ink: StampInk): string =>
  [shapeOf(node), glyphOf(node), ink.fill, ink.edge, ink.mark].join('|');

const _roundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  corner: number,
) => {
  const half = size / 2;
  ctx.beginPath();
  ctx.moveTo(x - half + corner, y - half);
  ctx.arcTo(x + half, y - half, x + half, y + half, corner);
  ctx.arcTo(x + half, y + half, x - half, y + half, corner);
  ctx.arcTo(x - half, y + half, x - half, y - half, corner);
  ctx.arcTo(x - half, y - half, x + half, y - half, corner);
  ctx.closePath();
};

const _outline = (ctx: CanvasRenderingContext2D, shape: NodeShapes, x: number, y: number, r: number) => {
  if (shape === NodeShapes.TILE) {
    _roundRect(ctx, x, y, r * 1.8, r * TILE_CORNER * 1.8);
    return;
  }
  if (shape === NodeShapes.GEM) {
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    return;
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
};

const _glyph = (ctx: CanvasRenderingContext2D, glyph: NodeGlyphs, x: number, y: number, size: number) => {
  ctx.save();
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = ICON_STROKE;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const letter = GLYPH_LETTER[glyph];
  ctx.strokeText(letter, x, y + size * 0.06);
  ctx.restore();
};

export const paintStamp = (
  ctx: CanvasRenderingContext2D,
  node: BrainNodeLike,
  x: number,
  y: number,
  r: number,
  ink: StampInk,
  withGlyph = true,
) => {
  const shape = shapeOf(node);
  const edge = r * EDGE_SHARE;

  if (shape === NodeShapes.HOLLOW) {
    _outline(ctx, NodeShapes.DISC, x, y, r + edge / 2);
    ctx.fillStyle = ink.edge;
    ctx.fill();
    _outline(ctx, NodeShapes.DISC, x, y, r - edge / 2);
    ctx.setLineDash([r * 0.45, r * 0.3]);
    ctx.lineWidth = edge;
    ctx.strokeStyle = ink.fill;
    ctx.stroke();
    ctx.setLineDash([]);
    if (withGlyph) {
      ctx.strokeStyle = ink.fill;
      _glyph(ctx, NodeGlyphs.PLUS, x, y, r * ICON_SHARE);
    }
    return;
  }

  _outline(ctx, shape, x, y, r + edge);
  ctx.fillStyle = ink.edge;
  ctx.fill();
  _outline(ctx, shape, x, y, r);
  ctx.fillStyle = ink.fill;
  ctx.fill();

  if (withGlyph) {
    ctx.strokeStyle = ink.mark;
    _glyph(ctx, glyphOf(node), x, y, r * (shape === NodeShapes.GEM ? ICON_SHARE * 0.8 : ICON_SHARE));
  }
};

const _ignoreRaycast = () => undefined;

const stamps = new Map<string, THREE.CanvasTexture>();

const _stampTexture = (node: BrainNodeLike, ink: StampInk): THREE.CanvasTexture => {
  const key = stampKey(node, ink);
  const cached = stamps.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = STAMP_TEXTURE_PX;
  canvas.height = STAMP_TEXTURE_PX;
  const context = canvas.getContext('2d')!;
  const centre = STAMP_TEXTURE_PX / 2;
  paintStamp(context, node, centre, centre, centre / STAMP_PADDING / 1.16, ink);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  stamps.set(key, texture);
  return texture;
};

export const forgetStamps = () => {
  stamps.forEach((texture) => texture.dispose());
  stamps.clear();
};

const _stampSprite = (node: BrainNodeLike, radius: number, ink: StampInk): THREE.Sprite => {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: _stampTexture(node, ink),
      transparent: true,
      alphaTest: 0.05,
      opacity: 1,
      depthWrite: true,
    }),
  );
  sprite.raycast = _ignoreRaycast;
  sprite.renderOrder = 5;
  const size = radius * 2 * STAMP_PADDING;
  sprite.scale.set(size, size, 1);
  return sprite;
};

const _pill = (context: CanvasRenderingContext2D, width: number, height: number) => {
  const radius = height / 2;
  context.beginPath();
  context.moveTo(radius, 0);
  context.arcTo(width, 0, width, height, radius);
  context.arcTo(width, height, 0, height, radius);
  context.arcTo(0, height, 0, 0, radius);
  context.arcTo(0, 0, width, 0, radius);
  context.closePath();
};

const _sprite = (canvas: HTMLCanvasElement, fixedSize = false): THREE.Sprite => {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      sizeAttenuation: !fixedSize,
    }),
  );
  sprite.raycast = _ignoreRaycast;
  sprite.visible = false;
  return sprite;
};

const _labelCanvas = (text: string, ink: string, paper: string, border: string): HTMLCanvasElement => {
  const shown = text.length > LABEL_MAX_CHARS ? `${text.slice(0, LABEL_MAX_CHARS - 1)}…` : text;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const font = `600 ${LABEL_FONT_PX}px Inter, system-ui, sans-serif`;
  context.font = font;
  canvas.width = Math.ceil(context.measureText(shown).width) + LABEL_PAD_X * 2;
  canvas.height = LABEL_FONT_PX + LABEL_PAD_Y * 2;

  _pill(context, canvas.width, canvas.height);
  context.fillStyle = paper;
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = border;
  context.stroke();
  context.font = font;
  context.textBaseline = 'middle';
  context.fillStyle = ink;
  context.fillText(shown, LABEL_PAD_X, canvas.height / 2 + 2);
  return canvas;
};

const _labelSprite = (text: string, ink: string, paper: string, border: string): THREE.Sprite => {
  const canvas = _labelCanvas(text, ink, paper, border);
  const sprite = _sprite(canvas, true);
  sprite.renderOrder = 20;
  sprite.center.set(0.5, 0);
  sprite.scale.set((LABEL_SCREEN_HEIGHT * canvas.width) / canvas.height, LABEL_SCREEN_HEIGHT, 1);
  return sprite;
};

const _ringCanvas = (colour: string): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = RING_TEXTURE_PX;
  canvas.height = RING_TEXTURE_PX;
  const context = canvas.getContext('2d')!;
  context.beginPath();
  context.arc(RING_TEXTURE_PX / 2, RING_TEXTURE_PX / 2, RING_TEXTURE_PX / 2 - 6, 0, Math.PI * 2);
  context.lineWidth = 6;
  context.strokeStyle = colour;
  context.stroke();
  return canvas;
};

const _ringSprite = (colour: string, radius: number): THREE.Sprite => {
  const sprite = _sprite(_ringCanvas(colour));
  sprite.renderOrder = 10;
  sprite.scale.set(radius * 3, radius * 3, 1);
  return sprite;
};

const _stampInk = (colours: PartColours): StampInk => ({
  fill: colours.body,
  edge: colours.edge,
  mark: colours.mark,
});

export const nodeParts = (node: BrainNodeLike, radius: number, colours: PartColours): NodeParts => {
  const group = new THREE.Group();
  const body = _stampSprite(node, radius, _stampInk(colours));

  const hit = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(radius * HIT_SCALE, radius + HIT_MIN_EXTRA), 12, 8),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
  );

  hit.userData.nodeId = node.id;

  const ring = _ringSprite(colours.halo, radius);
  const label = _labelSprite(node.title, colours.ink, colours.paper, colours.border);
  label.position.set(0, radius + LABEL_LIFT, 0);

  group.add(body, hit, ring, label);
  return {
    group,
    body,
    hit,
    ring,
    label,
    labelAspect: label.scale.x / label.scale.y,
    crowded: false,
    target: { body: 1, ring: 0, label: 0 },
  };
};

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

export const pickNode = (
  parts: Map<string, NodeParts>,
  camera: THREE.Camera,
  ndcX: number,
  ndcY: number,
): string | null => {
  pointer.set(ndcX, ndcY);
  raycaster.setFromCamera(pointer, camera);
  const targets = Array.from(parts.values())
    .filter((part) => part.body.material.opacity > PICKABLE_OPACITY)
    .map((part) => part.hit);
  const [first] = raycaster.intersectObjects(targets, false);
  return (first?.object.userData.nodeId as string | undefined) || null;
};

const _swapTexture = (sprite: THREE.Sprite, canvas: HTMLCanvasElement) => {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  sprite.material.map?.dispose();
  sprite.material.map = texture;
  sprite.material.needsUpdate = true;
};

export const recolourParts = (parts: NodeParts, node: BrainNodeLike, colours: PartColours) => {
  parts.body.material.map = _stampTexture(node, _stampInk(colours));
  parts.body.material.needsUpdate = true;
  _swapTexture(parts.ring, _ringCanvas(colours.halo));
  const canvas = _labelCanvas(node.title, colours.ink, colours.paper, colours.border);
  _swapTexture(parts.label, canvas);
};

const _toward = (current: number, target: number): [number, boolean] => {
  const next = current + (target - current) * TWEEN_RATE;
  return Math.abs(target - next) < SETTLED ? [target, false] : [next, true];
};

export const tweenParts = (parts: NodeParts): boolean => {
  const [body, bodyMoving] = _toward(parts.body.material.opacity, parts.target.body);
  const [ring, ringMoving] = _toward(parts.ring.material.opacity, parts.target.ring);
  const [label, labelMoving] = _toward(
    parts.label.material.opacity,
    parts.crowded ? 0 : parts.target.label,
  );

  parts.body.material.opacity = body;
  parts.ring.material.opacity = ring;
  parts.ring.visible = ring > SETTLED;
  parts.label.material.opacity = label;
  parts.label.visible = label > SETTLED;

  return bodyMoving || ringMoving || labelMoving;
};

export const disposeParts = (parts: NodeParts) => {
  parts.body.material.dispose();
  parts.body.material.map?.dispose();
  parts.hit.geometry.dispose();
  (parts.hit.material as THREE.Material).dispose();
  [parts.ring, parts.label].forEach((sprite) => {
    sprite.material.map?.dispose();
    sprite.material.dispose();
  });
};
