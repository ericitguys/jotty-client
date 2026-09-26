import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SLASH_ITEMS } from '../editor/slashCommands';
import SlashMenu from './SlashMenu';

describe('SlashMenu', () => {
  it('renders the slash items', () => {
    render(<SlashMenu items={SLASH_ITEMS} onPick={() => {}} />);
    for (const want of ['Heading 1', 'Heading 2', 'Bullet list', 'Ordered list', 'Task list', 'Code block', 'Quote', 'Table']) {
      expect(screen.getByText(want)).toBeInTheDocument();
    }
  });

  it('onPick fires with the picked item on click', () => {
    const onPick = vi.fn();
    render(<SlashMenu items={SLASH_ITEMS} onPick={onPick} />);
    fireEvent.click(screen.getByText('Code block'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(SLASH_ITEMS.find((i) => i.title === 'Code block'));
  });
});