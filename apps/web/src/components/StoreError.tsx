export function StoreError({ message }: { message: string }) {
  return (
    <section className="panel" style={{ borderLeft: '3px solid var(--error)' }}>
      <div className="panel-header">
        <span className="panel-title">No se pudo leer el store</span>
        <span className="tag tag--error">store</span>
      </div>
      <div className="panel-body">
        <p className="font-mono text-[11.5px] text-error">{message}</p>
        <p className="mt-2 text-[12px] text-foreground-secondary">
          La UI sólo lee el store de Búho. Verificar que el contenedor esté arriba y que la migración se haya
          aplicado:
        </p>
        <pre className="mt-2 border border-border bg-surface-muted p-2 font-mono text-[11px]">
          docker compose up -d store{'\n'}npm run migrate
        </pre>
      </div>
    </section>
  );
}
