'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: 'system-ui, sans-serif',
          background: '#0f1419',
          color: '#e7ecf3',
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
        }}
      >
        <div style={{ maxWidth: 420 }}>
          <h1 style={{ fontSize: '1.25rem', margin: '0 0 0.75rem' }}>Something went wrong</h1>
          <p style={{ fontSize: '0.875rem', opacity: 0.75, margin: '0 0 1.25rem' }}>
            {error.message || 'Unexpected application error.'}
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              border: '1px solid #3d4f66',
              background: '#1a2332',
              color: '#e7ecf3',
              borderRadius: 6,
              padding: '0.5rem 0.9rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
