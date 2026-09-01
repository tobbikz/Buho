export function StoreError({ message }: { message: string }) {
  return (
    <section className="panel" style={{ borderLeft: '3px solid var(--error)' }}>
      <div className="panel-header">
        <span className="panel-title">Could not read the store</span>
        <span className="tag tag--error">store</span>
      </div>
      <div className="panel-body">
        <p className="font-mono text-[11.5px] text-error">{message}</p>
        <p className="mt-2 text-[12px] text-foreground-secondary">
          The UI only reads the Búho store. Make sure the container is up and the migration has been applied:
        </p>
        <pre className="mt-2 border border-border bg-surface-muted p-2 font-mono text-[11px]">
          docker compose up -d store{'\n'}npm run migrate
        </pre>
      </div>
    </section>
  );
}
