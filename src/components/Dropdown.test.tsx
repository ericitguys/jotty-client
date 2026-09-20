import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Dropdown from './Dropdown';

const opts = [
  { id: 'auto', name: 'Follow site' },
  { id: 'dark', name: 'Dark', swatch: { bg: '#0e1840', primary: '#9d5ffe' } },
  { id: 'light', name: 'Light', swatch: { bg: '#f9f9f9', primary: '#9d5ffe' } },
];

describe('Dropdown (site-style theme picker)', () => {
  it('trigger shows the selected option name, not the raw value', () => {
    render(<Dropdown value="dark" options={opts} onChange={() => {}} placeholder="Pick" />);
    expect(screen.getByRole('button', { name: 'Theme' })).toHaveTextContent('Dark');
    expect(screen.queryByText('Follow site')).toBeNull(); // menu closed
  });

  it('trigger falls back to the placeholder when nothing is selected', () => {
    render(<Dropdown value="nope" options={opts} onChange={() => {}} placeholder="Pick" />);
    expect(screen.getByRole('button', { name: 'Theme' })).toHaveTextContent('Pick');
  });

  it('opens a menu listing every option and marks the current one selected', () => {
    render(<Dropdown value="dark" options={opts} onChange={() => {}} ariaLabel="Theme" />);
    fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByText('Follow site')).toBeTruthy();
    expect(screen.getByText('Light')).toBeTruthy();
    const cur = screen.getByRole('option', { name: 'Dark' });
    expect(cur.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('option', { name: 'Follow site' }).getAttribute('aria-selected')).toBe('false');
  });

  it('selecting an option fires onChange with its id and closes the menu', () => {
    const onChange = vi.fn();
    render(<Dropdown value="auto" options={opts} onChange={onChange} ariaLabel="Theme" />);
    fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
    fireEvent.click(screen.getByText('Light'));
    expect(onChange).toHaveBeenCalledWith('light');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Escape closes the menu without firing onChange', () => {
    const onChange = vi.fn();
    render(<Dropdown value="auto" options={opts} onChange={onChange} ariaLabel="Theme" />);
    fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a mousedown outside the dropdown closes the menu', () => {
    render(
      <div>
        <div data-testid="outside" />
        <Dropdown value="auto" options={opts} onChange={() => {}} ariaLabel="Theme" />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('renders a color swatch for options that carry theme colors', () => {
    render(<Dropdown value="dark" options={opts} onChange={() => {}} ariaLabel="Theme" />);
    fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
    const menu = screen.getByRole('listbox');
    expect(menu.querySelectorAll('.jotty-dropdown-swatch').length).toBe(2); // dark + light carry swatches, 'auto' does not
    // the trigger mirrors the SELECTED theme's swatch
    expect(document.querySelectorAll('.jotty-dropdown-button .jotty-dropdown-swatch').length).toBe(1);
    expect((menu.querySelector('.jotty-dropdown-swatch') as HTMLElement).style.background).toBe('rgb(14, 24, 64)'); // #0e1840
  });
});