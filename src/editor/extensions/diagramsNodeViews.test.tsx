import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DrawioNodeView, ExcalidrawNodeView, MermaidNodeView } from './diagramsNodeViews';

const baseNode = (attrs: Record<string, string | null>) => ({ attrs });

describe('MermaidNodeView (portal MermaidExtension.tsx:63-184)', () => {
  it('renders the diagram block with Edit/Delete actions', () => {
    render(
      <MermaidNodeView
        node={baseNode({ content: 'graph TD; A-->B;' })}
        updateAttributes={vi.fn()}
        deleteNode={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-diagram-node="mermaid"]')).toBeTruthy();
    expect(screen.getByTitle('Edit diagram')).toBeTruthy();
    expect(screen.getByTitle('Delete diagram')).toBeTruthy();
  });

  it('shows an empty placeholder for blank content', () => {
    render(
      <MermaidNodeView node={baseNode({ content: '' })} updateAttributes={vi.fn()} deleteNode={vi.fn()} />,
    );
    expect(screen.getByText('Empty mermaid diagram')).toBeTruthy();
  });

  it('the Edit modal saves the edited code into the node attrs', async () => {
    const updateAttributes = vi.fn();
    render(
      <MermaidNodeView
        node={baseNode({ content: 'graph TD; A-->B;' })}
        updateAttributes={updateAttributes}
        deleteNode={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('Edit diagram'));
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('graph TD; A-->B;');
    fireEvent.change(textarea, { target: { value: 'graph TD; A-->C;' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateAttributes).toHaveBeenCalledWith({ content: 'graph TD; A-->C;' }));
    expect(updateAttributes).toHaveBeenLastCalledWith({ content: 'graph TD; A-->C;' });
  });

  it('cancel re-seeds the textarea from the stored content', async () => {
    render(
      <MermaidNodeView
        node={baseNode({ content: 'graph TD; A-->B;' })}
        updateAttributes={vi.fn()}
        deleteNode={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('Edit diagram'));
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'drift' } });
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByTitle('Edit diagram'));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('graph TD; A-->B;');
  });

  it('the Delete confirm actually deletes the node', () => {
    const deleteNode = vi.fn();
    render(
      <MermaidNodeView node={baseNode({ content: 'x' })} updateAttributes={vi.fn()} deleteNode={deleteNode} />,
    );
    fireEvent.click(screen.getByTitle('Delete diagram'));
    fireEvent.click(screen.getByText('Delete', { selector: '.diagram-confirm-card button.diagram-danger' }));
    expect(deleteNode).toHaveBeenCalledTimes(1);
  });
});

describe('DrawioNodeView (portal DrawioExtension.tsx:12-229; R22 protocol)', () => {
  it('renders the stored svg with the dark invert filter', () => {
    render(
      <DrawioNodeView
        node={baseNode({ svgData: '<svg>drawio</svg>', diagramData: '<mxfile/>', themeMode: 'dark' })}
        updateAttributes={vi.fn()}
        deleteNode={vi.fn()}
      />,
    );
    const wrap = document.querySelector('.diagram-node-container [data-diagram-node], .diagram-node-container .diagram-svg-wrap') as HTMLElement;
    const injected = document.querySelector('.diagram-node-container .diagram-svg-wrap') as HTMLElement;
    expect(injected.innerHTML).toContain('<svg>drawio</svg>');
    expect(injected.getAttribute('style')).toContain('invert(0.92)');
    expect(screen.getByText('☀')).toBeTruthy();
  });

  it('empty nodes show the create row', () => {
    render(
      <DrawioNodeView node={baseNode({ svgData: null, diagramData: null, themeMode: 'light' })} updateAttributes={vi.fn()} deleteNode={vi.fn()} />,
    );
    expect(screen.getByText('Create visual diagram')).toBeTruthy();
  });

  it('drives the full init→save→export postMessage protocol', async () => {
    const updateAttributes = vi.fn();
    render(
      <DrawioNodeView node={baseNode({ diagramData: '<mxfile v1/>', svgData: null, themeMode: 'light' })} updateAttributes={updateAttributes} deleteNode={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('Create visual diagram'));

    const iframe = document.querySelector('iframe.diagram-iframe') as HTMLIFrameElement;
    expect(iframe.getAttribute('src')).toContain('embed.diagrams.net/?embed=1&ui=kennedy&spin=1&proto=json');
    const iframeWin = iframe.contentWindow as Window;
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    expect(postSpy).toBeDefined();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://embed.diagrams.net',
          source: iframeWin,
          data: JSON.stringify({ event: 'init' }),
        }),
      );
    });
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(String(postSpy.mock.calls[0][0])).toContain('"action":"load"');
    expect(String(postSpy.mock.calls[0][0])).toContain('<mxfile v1/>');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://embed.diagrams.net',
          source: iframeWin,
          data: JSON.stringify({ event: 'save', xml: '<mxfile v2/>' }),
        }),
      );
    });
    expect(updateAttributes).toHaveBeenCalledWith({ diagramData: '<mxfile v2/>' });
    expect(String(postSpy.mock.calls[1][0])).toContain('"action":"export"');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://embed.diagrams.net',
          source: iframeWin,
          data: JSON.stringify({ event: 'export', data: btoa('<svg>final</svg>') }),
        }),
      );
    });
    expect(updateAttributes).toHaveBeenCalledWith({ svgData: '<svg>final</svg>' });
    await waitFor(() => expect(screen.queryByText('Edit draw.io diagram')).toBeNull());
  });

  it('rejects messages from foreign origins', () => {
    const updateAttributes = vi.fn();
    render(
      <DrawioNodeView node={baseNode({ diagramData: null, svgData: null, themeMode: 'light' })} updateAttributes={updateAttributes} deleteNode={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('Create visual diagram'));
    const iframe = document.querySelector('iframe.diagram-iframe') as HTMLIFrameElement;
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://evil.example.com',
          source: iframe.contentWindow as Window,
          data: JSON.stringify({ event: 'save', xml: 'evil' }),
        }),
      );
    });
    expect(postSpy).not.toHaveBeenCalled();
    expect(updateAttributes).not.toHaveBeenCalled();
    postSpy.mockRestore();
  });

  it('toggling theme updates the node attr', () => {
    const updateAttributes = vi.fn();
    render(
      <DrawioNodeView node={baseNode({ svgData: '<svg>x</svg>', diagramData: '<x/>', themeMode: 'light' })} updateAttributes={updateAttributes} deleteNode={vi.fn()} />,
    );
    fireEvent.click(screen.getByTitle('Switch to dark mode'));
    expect(updateAttributes).toHaveBeenCalledWith({ themeMode: 'dark' });
  });
});

describe('ExcalidrawNodeView (portal ExcalidrawExtension.tsx:20-228; R21 lazy editor)', () => {
  it('renders the stored svg + theme toggle for data-bearing nodes', () => {
    render(
      <ExcalidrawNodeView
        node={baseNode({ diagramData: '{"elements":[]}', svgData: '<svg>excali</svg>', themeMode: 'light' })}
        updateAttributes={vi.fn()}
        deleteNode={vi.fn()}
      />,
    );
    const injected = document.querySelector('.diagram-node-container .diagram-svg-wrap') as HTMLElement;
    expect(injected.innerHTML).toContain('<svg>excali</svg>');
    expect(injected.getAttribute('style')).toBe('filter: none;');
  });

  it('opens the fullscreen editor lazily and stays placeholder under the jsdom guard', async () => {
    render(
      <ExcalidrawNodeView node={baseNode({})} updateAttributes={vi.fn()} deleteNode={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('Create visual diagram'));
    // The R21 guard keeps jsdom from loading @excalidraw/excalidraw; the lazy
    // surface resolves to the unavailable fallback instead of the canvas lib.
    await waitFor(() => expect(screen.getByText('Excalidraw editor unavailable')).toBeTruthy());
    expect(screen.getByText('Edit excalidraw diagram')).toBeTruthy();
  });

  it('the Delete confirm actually deletes the node', () => {
    const deleteNode = vi.fn();
    render(
      <ExcalidrawNodeView node={baseNode({})} updateAttributes={vi.fn()} deleteNode={deleteNode} />,
    );
    fireEvent.click(screen.getByText('Delete', { selector: '.diagram-create-row button.diagram-danger' }));
    fireEvent.click(screen.getByText('Delete', { selector: '.diagram-confirm-card button.diagram-danger' }));
    expect(deleteNode).toHaveBeenCalledTimes(1);
  });
});