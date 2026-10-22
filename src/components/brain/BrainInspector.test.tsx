import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BrainInspector, { BrainInspectorProps } from './BrainInspector';
import type { BrainVMNode, BrainVMEdge } from './brainView';

const node = (over: Partial<BrainVMNode> = {}): BrainVMNode => ({
  id: 'n1',
  kind: 'note',
  title: 'Alpha',
  links: 1,
  category: null,
  distance: null,
  ...over,
});

const edge = (over: Partial<BrainVMEdge> = {}): BrainVMEdge => ({
  source: 'n1',
  target: 'n2',
  kind: 'link',
  weight: 1,
  ...over,
});

describe('BrainInspector', () => {
  it('renders node title, kind and category', () => {
    render(
      <BrainInspector
        node={node({ title: 'Alpha', kind: 'note', category: 'Home' })}
        edges={[]}
        onClose={vi.fn()}
        onPick={vi.fn()}
        onOpen={vi.fn()}
        canOpen={() => true}
      />,
    );
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('note')).toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
  });

  it('shows the lonely line when no edges connect', () => {
    render(
      <BrainInspector
        node={node()}
        edges={[]}
        onClose={vi.fn()}
        onPick={vi.fn()}
        onOpen={vi.fn()}
        canOpen={() => true}
      />,
    );
    expect(screen.getByText(/Not linked to anything yet/)).toBeInTheDocument();
  });

  it('splits out/in/suggested edges and resolves titles from edges only', () => {
    const n1 = node({ id: 'n1', title: 'Alpha' });
    const edges: BrainVMEdge[] = [
      edge({ source: 'n1', target: 'n2', kind: 'link', weight: 1 }),
      edge({ source: 'n3', target: 'n1', kind: 'mention', weight: 1 }),
      edge({ source: 'n1', target: 'n4', kind: 'suggested', weight: 0.91 }),
      edge({ source: 'n1', target: 'n5', kind: 'suggested', weight: 0.42 }),
    ];
    render(
      <BrainInspector
        node={n1}
        edges={edges}
        onClose={vi.fn()}
        onPick={vi.fn()}
        onOpen={vi.fn()}
        canOpen={() => true}
      />,
    );
    expect(screen.getByText('Links to')).toBeInTheDocument();
    expect(screen.getByText('Linked from')).toBeInTheDocument();
    expect(screen.getByText('Suggested links')).toBeInTheDocument();
    const scores = screen.getAllByText(/%$/);
    expect(scores.map((s) => s.textContent)).toEqual(['91%', '42%']);
  });

  it('clicking a neighbour fires onPick', () => {
    const onPick = vi.fn();
    render(
      <BrainInspector
        node={node()}
        edges={[edge({ target: 'n2', kind: 'link' })]}
        onClose={vi.fn()}
        onPick={onPick}
        onOpen={vi.fn()}
        canOpen={() => true}
      />,
    );
    fireEvent.click(screen.getByText('Links to'));
    fireEvent.click(document.querySelector('.brain-inspector-neighbour-title')!);
    expect(onPick).toHaveBeenCalledWith('n2');
  });

  it('Open button label and disabled state follow node kind/canOpen', () => {
    const onOpen = vi.fn();
    const { rerender } = render(
      <BrainInspector
        node={node({ kind: 'note' })}
        edges={[]}
        onClose={vi.fn()}
        onPick={vi.fn()}
        onOpen={onOpen}
        canOpen={() => true}
      />,
    );
    const openBtn = () => screen.getByRole('button', { name: 'Open' });
    expect(openBtn()).not.toBeDisabled();
    fireEvent.click(openBtn());
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1', kind: 'note' }));

    rerender(
      <BrainInspector
        node={node({ kind: 'ghost' })}
        edges={[]}
        onClose={vi.fn()}
        onPick={vi.fn()}
        onOpen={onOpen}
        canOpen={() => false}
      />,
    );
    const ghostBtn = screen.getByRole('button', { name: 'Open' });
    expect(ghostBtn).toBeDisabled();
    expect(ghostBtn).toHaveAttribute('title', 'not written yet');

    rerender(
      <BrainInspector
        node={node({ kind: 'tag' })}
        edges={[]}
        onClose={vi.fn()}
        onPick={vi.fn()}
        onOpen={onOpen}
        canOpen={() => false}
      />,
    );
    const tagBtn = screen.getByRole('button', { name: 'Open' });
    expect(tagBtn).toBeDisabled();
    expect(tagBtn).toHaveAttribute('title', 'not written yet');

    rerender(
      <BrainInspector
        node={node({ kind: 'note' })}
        edges={[]}
        onClose={vi.fn()}
        onPick={vi.fn()}
        onOpen={onOpen}
        canOpen={() => false}
      />,
    );
    const noteBtn = screen.getByRole('button', { name: 'Open' });
    expect(noteBtn).toBeDisabled();
    expect(noteBtn).toHaveAttribute('title', 'not synced');
  });

  it('Close button fires onClose', () => {
    const onClose = vi.fn();
    render(
      <BrainInspector
        node={node()}
        edges={[]}
        onClose={onClose}
        onPick={vi.fn()}
        onOpen={vi.fn()}
        canOpen={() => true}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders stale chip override text when provided', () => {
    render(
      <BrainInspector
        node={node()}
        edges={[]}
        onClose={vi.fn()}
        onPick={vi.fn()}
        onOpen={vi.fn()}
        canOpen={() => true}
        stale="· stale data · server indexing"
      />,
    );
    expect(screen.getByText('· stale data · server indexing')).toHaveClass('sync-stale');
  });
});
