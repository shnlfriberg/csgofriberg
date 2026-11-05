import { useState } from 'react';

const CAPTURE_SIZE = 360;

// Show the exact source-pixel crop before upload without creating another bitmap in memory.
export default function CaptureImagePreview({
  url,
  alt,
}: {
  url: string;
  alt: string;
}) {
  const [width, setWidth] = useState(CAPTURE_SIZE);
  return (
    <figure className="location-crop-preview">
      <img
        loading="lazy"
        decoding="async"
        src={url}
        alt={alt}
        style={{ width: `${(width / CAPTURE_SIZE) * 100}%` }}
        onLoad={(event) => setWidth(event.currentTarget.naturalWidth || CAPTURE_SIZE)}
      />
    </figure>
  );
}
