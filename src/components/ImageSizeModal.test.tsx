import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ImageSizeModal from './ImageSizeModal';

describe('ImageSizeModal', () => {
  it('renders the portal card (title, labels, Auto placeholders, hint, Reset/Cancel/Apply)', () => {
    render(
      <ImageSizeModal isOpen onClose={() => {}} onConfirm={() => {}} imageUrl="https://example.com/i.png" />,
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Image Size');
    expect(screen.getByText('Image Size')).toBeInTheDocument();
    expect(screen.getByLabelText('Width (px)')).toBeInTheDocument();
    expect(screen.getByLabelText('Height (px)')).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText('Auto')).toHaveLength(2);
    expect(screen.getByText('Leave empty for auto size')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(<ImageSizeModal isOpen={false} onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('seeds the inputs from currentWidth/currentHeight on open', () => {
    const { rerender } = render(
      <ImageSizeModal isOpen={false} onClose={() => {}} onConfirm={() => {}} currentWidth={300} currentHeight={200} />,
    );
    rerender(<ImageSizeModal isOpen onClose={() => {}} onConfirm={() => {}} currentWidth={300} currentHeight={200} />);
    expect(screen.getByLabelText('Width (px)')).toHaveValue(300);
    expect(screen.getByLabelText('Height (px)')).toHaveValue(200);
  });

  it('shows a live preview img fed from imageUrl and the typed size', () => {
    render(<ImageSizeModal isOpen onClose={() => {}} onConfirm={() => {}} imageUrl="https://example.com/i.png" />);
    const preview = screen.getByAltText('Preview');
    expect(preview).toHaveAttribute('src', 'https://example.com/i.png');
    fireEvent.change(screen.getByLabelText('Width (px)'), { target: { value: '640' } });
    expect(preview).toHaveAttribute('style', expect.stringContaining('width: 640px'));
  });

  it('Apply reports parsed ints via onConfirm (empty field → null) and closes', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ImageSizeModal isOpen onClose={onClose} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByLabelText('Width (px)'), { target: { value: '320' } });
    fireEvent.change(screen.getByLabelText('Height (px)'), { target: { value: '240' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onConfirm).toHaveBeenCalledWith(320, 240);
    expect(onClose).toHaveBeenCalled();
  });

  it('Apply with both fields empty reports (null, null)', () => {
    const onConfirm = vi.fn();
    render(<ImageSizeModal isOpen onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onConfirm).toHaveBeenCalledWith(null, null);
  });

  it('Reset clears both fields (next Apply reports nulls)', () => {
    const onConfirm = vi.fn();
    render(
      <ImageSizeModal isOpen onClose={() => {}} onConfirm={onConfirm} currentWidth={300} currentHeight={200} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByLabelText('Width (px)')).toHaveValue(null);
    expect(screen.getByLabelText('Height (px)')).toHaveValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onConfirm).toHaveBeenCalledWith(null, null);
  });

  it('Cancel and Escape close without confirming', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ImageSizeModal isOpen onClose={onClose} onConfirm={onConfirm} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('backdrop click closes without confirming', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ImageSizeModal isOpen onClose={onClose} onConfirm={onConfirm} />);
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!, { target: screen.getByRole('dialog').parentElement });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});