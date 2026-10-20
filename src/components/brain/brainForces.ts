type SimNode = {
  id: string;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
};

type Force = ((alpha: number) => void) & { initialize: (nodes: SimNode[]) => void };

const _force = (tick: (nodes: SimNode[], alpha: number) => void): Force => {
  let nodes: SimNode[] = [];
  const force = ((alpha: number) => tick(nodes, alpha)) as Force;
  force.initialize = (next) => {
    nodes = next;
  };
  return force;
};

export const regionForce = (strength: number): Force =>
  _force((nodes, alpha) => {
    const centres = new Map<string, { x: number; y: number; count: number }>();
    nodes.forEach((node) => {
      const region = (node as unknown as { category?: string | null }).category;
      if (!region) return;
      const centre = centres.get(region) || { x: 0, y: 0, count: 0 };
      centre.x += node.x || 0;
      centre.y += node.y || 0;
      centre.count += 1;
      centres.set(region, centre);
    });

    nodes.forEach((node) => {
      const region = (node as unknown as { category?: string | null }).category;
      const centre = region ? centres.get(region) : undefined;
      if (!centre || centre.count < 2) return;
      ['x', 'y'].forEach((axis) => {
        const key = axis === 'x' ? 'vx' : 'vy';
        const target = axis === 'x' ? centre.x / centre.count : centre.y / centre.count;
        node[key] = (node[key] || 0) + (target - (node[axis as 'x' | 'y'] || 0)) * strength * alpha;
      });
    });
  });

export const gravityForce = (strength: number): Force =>
  _force((nodes, alpha) => {
    nodes.forEach((node) => {
      node.vx = (node.vx || 0) - (node.x || 0) * strength * alpha;
      node.vy = (node.vy || 0) - (node.y || 0) * strength * alpha;
    });
  });

const _cellKey = (x: number, y: number) => `${x},${y}`;

export const collideForce = (radiusOf: (node: SimNode) => number, strength = 0.7): Force =>
  _force((nodes) => {
    const reach = nodes.reduce((max, node) => Math.max(max, radiusOf(node)), 1) * 2;
    const grid = new Map<string, SimNode[]>();
    const cell = (value?: number) => Math.floor((value || 0) / reach);

    nodes.forEach((node) => {
      const key = _cellKey(cell(node.x), cell(node.y));
      const bucket = grid.get(key);
      if (bucket) bucket.push(node);
      else grid.set(key, [node]);
    });

    nodes.forEach((node) => {
      const cx = cell(node.x);
      const cy = cell(node.y);
      const mine = radiusOf(node);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          grid.get(_cellKey(cx + dx, cy + dy))?.forEach((other) => {
            if (other === node || other.id > node.id) return;
            const gap = mine + radiusOf(other);
            const x = (node.x || 0) - (other.x || 0);
            const y = (node.y || 0) - (other.y || 0);
            const distance = Math.hypot(x, y) || 0.01;
            if (distance >= gap) return;
            const push = ((gap - distance) / distance) * strength * 0.5;
            node.vx = (node.vx || 0) + x * push;
            node.vy = (node.vy || 0) + y * push;
            other.vx = (other.vx || 0) - x * push;
            other.vy = (other.vy || 0) - y * push;
          });
        }
      }
    });
  });
