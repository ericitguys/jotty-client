import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MarkdownEditor from './MarkdownEditor';

describe('MarkdownEditor', () => {
  it('renders a textarea with the markdown value and reports changes', () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value={'# hi'} onChange={onChange} editor={null} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '# hello' } });
    expect(onChange).toHaveBeenCalledWith('# hello');
  });
  it('preview toggle renders converted HTML instead of the textarea', () => {
    const { rerender } = render(<MarkdownEditor value={'# hi'} onChange={() => {}} editor={null} preview />);
    expect(document.querySelector('.md-preview')?.innerHTML).toContain('h1');
    expect(screen.queryByRole('textbox')).toBeNull();
    rerender(<MarkdownEditor value={'# hi'} onChange={() => {}} editor={null} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
  it('highlight overlay tokens exist (markdown grammar via highlight.js)', () => {
    render(<MarkdownEditor value={'# hi\n\n- a'} onChange={() => {}} editor={null} />);
    expect(document.querySelector('.md-editor .hljs-markdown, .md-editor code.language-markdown')).toBeTruthy();
  });
});