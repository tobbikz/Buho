import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

/** Home-screen / pinned-tab icon — larger version of the navbar mark. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 22,
          background: '#005eb8',
          border: '4px solid #004a92',
        }}
      >
        <div style={{ width: 28, height: 28, background: '#ffffff' }} />
        <div style={{ width: 28, height: 28, background: '#ffffff' }} />
      </div>
    ),
    { ...size },
  );
}
