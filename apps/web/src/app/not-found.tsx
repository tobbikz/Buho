import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="page">
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">No encontrado</span>
        </div>
        <div className="panel-body text-[12px]">
          Esa instancia no existe en el store.{' '}
          <Link href="/" className="text-accent hover:underline">
            Volver al resumen de flota
          </Link>
          .
        </div>
      </section>
    </div>
  );
}
