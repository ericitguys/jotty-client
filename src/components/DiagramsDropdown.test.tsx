import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { noteEditorExtensions } from '../editor/extensions';
import DiagramsDropdown from './DiagramsDropdown';

function makeEditor(content = '<p>hi</p>'): Editor {
  return new Editor({ extensions: noteEditorExtensions(), content });
}

describe('DiagramsDropdown (P3 task 6)', () => {
  const editors: Editor[] = [];
  afterEach(() => {
    // Editor-view teardown hygiene (T4/T5 inter-file flake class).
    for (const ed of editors.splice(0)) ed.destroy();
  });

  it('renders the portal trigger (Diagrams) over the three insert items', () => {
    const editor = makeEditor('<p>x</p>');
    editors.push(editor);
    render(<DiagramsDropdown editor={editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Diagrams' }));
    expect(screen.getByText('Mermaid Diagram')).toBeTruthy();
    expect(screen.getByText('Draw.io Diagram')).toBeTruthy();
    expect(screen.getByText('Excalidraw Diagram')).toBeTruthy();
  });

  it('Mermaid item inserts the portal default template via setMermaid', () => {
    const editor = makeEditor('<p>x</p>');
    editors.push(editor);
    render(<DiagramsDropdown editor={editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Diagrams' }));
    fireEvent.click(screen.getByText('Mermaid Diagram'));
    expect(editor.getHTML()).toContain('data-mermaid-content="graph TD');
    // portal-exact default body (Diagramslayouts from DiagramsDropdown.tsx:27-32)
    const json = editor.getJSON() as {
      content?: Array<{ type: string; attrs?: { content?: string } }>;
    };
    expect(json.content?.find((n) => n.type === 'mermaid')?.attrs?.content).toBe(
      'graph TD\n    A[Start] --> B{Decision}\n    B -->|Yes| C[Option 1]\n    B -->|No| D[Option 2]\n    C --> E[End]\n    D --> E',
    );
  });

  it('Draw.io and Excalidraw items insert their (empty) diagram nodes', () => {
    const editor = makeEditor('<p>x</p>');
    editors.push(editor);
    render(<DiagramsDropdown editor={editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Diagrams' }));
    fireEvent.click(screen.getByText('Draw.io Diagram'));
    expect(editor.getHTML()).toContain('data-drawio');
    fireEvent.click(screen.getByRole('button', { name: 'Diagrams' }));
    fireEvent.click(screen.getByText('Excalidraw Diagram'));
    expect(editor.getHTML()).toContain('data-excalidraw');
  });

  it('markdown mode: trigger stays enabled, drawio/excalidraw items disable with the portal hint', () => {
    const editor = makeEditor('<p>x</p>');
    editors.push(editor);
    render(<DiagramsDropdown editor={editor} markdownMode />);
    const trigger = screen.getByRole('button', { name: 'Diagrams' });
    expect(trigger).not.toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.getByText('Draw.io Diagram').closest('button')).toBeDisabled();
    expect(screen.getByText('Excalidraw Diagram').closest('button')).toBeDisabled();
    expect(
      (screen.getByText('Draw.io Diagram').closest('button') as HTMLElement).title,
    ).toBe('Not available in markdown mode');
    expect(screen.getAllByText('Rich mode only').length).toBe(2);
    // mermaid stays live (textarea insert below)
    expect(screen.getByText('Mermaid Diagram').closest('button')).not.toBeDisabled();
  });

  it('markdown mode: Mermaid splices a ```mermaid fence into the raw textarea at the cursor', () => {
    const onMarkdownChange = vi.fn();
    const editor = makeEditor('<p>x</p>');
    editors.push(editor);
    render(
      <>
        <textarea className="md-editor-area" defaultValue="hello" onChange={() => {}} />
        <DiagramsDropdown editor={editor} markdownMode onMarkdownChange={onMarkdownChange} />
      </>,
    );
    const ta = document.querySelector('.md-editor-area') as HTMLTextAreaElement;
    ta.setSelectionRange(5, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Diagrams' }));
    fireEvent.click(screen.getByText('Mermaid Diagram'));
    expect(onMarkdownChange).toHaveBeenCalledTimes(1);
    const md = onMarkdownChange.mock.calls[0][0] as string;
    expect(md.startsWith('hello\n')).toBe(true);
    expect(md).toContain('```mermaid\ngraph TD\n    A[Start] --> B{Decision}');
    expect(md.trim().endsWith('```')).toBe(true);
  });

  it('trigger is inert without an editor', () => {
    render(<DiagramsDropdown editor={null} />);
    expect(screen.getByRole('button', { name: 'Diagrams' })).toBeDisabled();
  });
});