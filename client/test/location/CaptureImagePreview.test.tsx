import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CaptureImagePreview from '../../src/components/admin/location/CaptureImagePreview';

describe('source-pixel crop previews', () => {
  it.each([
    [1920, '533.3333333333333%'],
    [1280, '355.55555555555554%'],
  ])(
    'centers a 360-pixel region from a %i-pixel-wide original',
    (width, percent) => {
      render(<CaptureImagePreview url="blob:original" alt="Screenshot" />);
      const img = screen.getByAltText('Screenshot');
      Object.defineProperty(img, 'naturalWidth', { value: width });
      fireEvent.load(img);
      expect(img).toHaveStyle({ width: percent });
      expect(img.closest('figure')).toHaveClass('location-crop-preview');
    }
  );
});
