import { describe, expect, it } from 'vitest';
import { brainFetch } from '../../api/client';
import { brainView, searchNodes, neighbourMap } from './brainView';
import type { BrainVMNode, BrainVMEdge, BrainFilterFlags, BrainScope } from './brainView';

const n = (id: string, kind: string, links = 0, title = id): BrainVMNode => ({ id, kind, title, links });
const e = (source: string, target: string, kind: string): BrainVMEdge => ({ source, target, kind, weight: 1 });
const allFilters: BrainFilterFlags = { notes: true, checklists: true, tags: true, ghosts: true, suggestions: true, orphans: true };
const noSuggest: BrainFilterFlags = { ...allFilters, suggestions: false };
const noOrphans: BrainFilterFlags = { ...allFilters, orphans: false };

describe('brainView filtering', () => {
  it('drops suggested edges when suggestions filter is off', () => {
    const nodes = [n('a', 'note'), n('b', 'note')];
    const edges = [e('a', 'b', 'link'), e('a', 'b', 'suggested')];
    const vm = brainView(nodes, edges, noSuggest, { local: false, depth: 2 }, null);
    expect(vm.edges).toHaveLength(1);
    expect(vm.edges[0].kind).toBe('link');
  });

  it('drops tag edges when tags filter is off', () => {
    const nodes = [n('a', 'note'), n('b', 'note')];
    const edges = [e('a', 'b', 'tag'), e('a', 'b', 'link')];
    const filters: BrainFilterFlags = { ...allFilters, tags: false };
    const vm = brainView(nodes, edges, filters, { local: false, depth: 2 }, null);
    expect(vm.edges).toHaveLength(1);
    expect(vm.edges[0].kind).toBe('link');
  });

  it('drops nodes whose kind filter is off', () => {
    const nodes = [n('a', 'note'), n('b', 'checklist'), n('c', 'ghost'), n('d', 'tag')];
    const edges = [e('a', 'b', 'link'), e('c', 'd', 'link')];
    const filters: BrainFilterFlags = { ...allFilters, ghosts: false, tags: false };
    const vm = brainView(nodes, edges, filters, { local: false, depth: 2 }, null);
    expect(vm.nodes.map((x) => x.id)).toEqual(['a', 'b']);
    expect(vm.edges).toHaveLength(1);
  });

  it('keeps focus node even when orphan filter is off and it has no filtered edge', () => {
    const nodes = [n('focus', 'note'), n('lonely', 'note')];
    const edges = [e('other', 'lonely', 'link')];
    const vm = brainView(nodes, edges, noOrphans, { local: false, depth: 2 }, 'focus');
    expect(vm.nodes.map((x) => x.id)).toContain('focus');
    expect(vm.nodes.map((x) => x.id)).not.toContain('lonely');
  });

  it('drops non-focus orphan nodes when orphans filter is off', () => {
    const nodes = [n('a', 'note'), n('b', 'note'), n('c', 'note')];
    const edges = [e('a', 'b', 'link')];
    const vm = brainView(nodes, edges, noOrphans, { local: false, depth: 2 }, null);
    expect(vm.nodes.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('local scope keeps only focus + BFS reachability using suggestion-inclusive adjacency', () => {
    // focus --suggested--> mid --link--> far
    const nodes = [n('focus', 'note'), n('mid', 'note'), n('far', 'note'), n('outside', 'note')];
    const edges = [e('focus', 'mid', 'suggested'), e('mid', 'far', 'link'), e('outside', 'far', 'link')];
    const vm = brainView(nodes, edges, noSuggest, { local: true, depth: 2 }, 'focus');
    expect(vm.nodes.map((x) => x.id).sort()).toEqual(['far', 'focus', 'mid']);
  });

  it('local scope depth 1 keeps only immediate suggestion-reachable nodes', () => {
    const nodes = [n('focus', 'note'), n('mid', 'note'), n('far', 'note')];
    const edges = [e('focus', 'mid', 'suggested'), e('mid', 'far', 'link')];
    const vm = brainView(nodes, edges, noSuggest, { local: true, depth: 1 }, 'focus');
    expect(vm.nodes.map((x) => x.id)).toEqual(['focus', 'mid']);
  });

  it('edges are only kept when both endpoints survive', () => {
    const nodes = [n('a', 'note'), n('b', 'note'), n('c', 'tag')];
    const edges = [e('a', 'b', 'link'), e('b', 'c', 'tag'), e('a', 'c', 'tag')];
    const filters: BrainFilterFlags = { ...allFilters, tags: false };
    const vm = brainView(nodes, edges, filters, { local: false, depth: 2 }, null);
    expect(vm.edges).toHaveLength(1);
    expect(vm.edges[0].source).toBe('a');
    expect(vm.edges[0].target).toBe('b');
  });
});

describe('neighbourMap', () => {
  it('is bidirectional', () => {
    const map = neighbourMap([e('a', 'b', 'link')], false);
    expect(map.get('a')).toEqual(new Set(['b']));
    expect(map.get('b')).toEqual(new Set(['a']));
  });

  it('excludes suggested edges by default', () => {
    const map = neighbourMap([e('a', 'b', 'suggested')], false);
    expect(map.has('a')).toBe(false);
  });

  it('includes suggested edges when asked', () => {
    const map = neighbourMap([e('a', 'b', 'suggested')], true);
    expect(map.get('a')).toEqual(new Set(['b']));
  });
});

describe('searchNodes', () => {
  it('returns empty for blank query', () => {
    const nodes = [n('a', 'note', 0, 'Alpha'), n('b', 'note', 0, 'Beta')];
    expect(searchNodes(nodes, '')).toEqual([]);
    expect(searchNodes(nodes, '   ')).toEqual([]);
  });

  it('matches substring case-insensitively', () => {
    const nodes = [n('a', 'note', 0, 'Alpha'), n('b', 'note', 0, 'BETA')];
    expect(searchNodes(nodes, 'al').map((x) => x.id)).toEqual(['a']);
  });

  it('sorts by links descending and caps at 8', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => n(`n${i}`, 'note', i, `Node ${i}`));
    const result = searchNodes(nodes, 'node', 8);
    expect(result).toHaveLength(8);
    expect(result[0].links).toBeGreaterThan(result[7].links);
  });
});

describe('api guard', () => {
  it('throws the exact bounds message', async () => {
    await expect(brainFetch({ focus: null, depth: 0, limit: 60, suggestions: false })).rejects.toThrow('brain query bounds: depth 1..3, limit 1..200');
    await expect(brainFetch({ focus: null, depth: 2, limit: 201, suggestions: false })).rejects.toThrow('brain query bounds: depth 1..3, limit 1..200');
  });
});
