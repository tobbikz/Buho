import Link from 'next/link';

const VISTAS = [
  { key: 'trafico', label: 'Traffic', href: (id: number) => `/instances/${id}/topology` },
  {
    key: 'estructura',
    label: 'Structure',
    href: (id: number) => `/instances/${id}/topology?vista=estructura`,
  },
  {
    key: 'detalle',
    label: 'Columns',
    href: (id: number) => `/instances/${id}/topology?vista=detalle`,
  },
] as const;

export type CatalogVistaKey = (typeof VISTAS)[number]['key'];

/** Fixed order so Traffic / Structure / Columns never jump when switching. */
export function CatalogVistaTabs({
  instanceId,
  active,
}: {
  instanceId: number;
  active: CatalogVistaKey;
}) {
  return (
    <div className="catalog-vista-tabs flex flex-wrap items-center gap-1">
      {VISTAS.map((vista) =>
        vista.key === active ? (
          <span key={vista.key} className="tag tag--info">
            {vista.label}
          </span>
        ) : (
          <Link key={vista.key} href={vista.href(instanceId)} className="tag tag--muted">
            {vista.label}
          </Link>
        ),
      )}
    </div>
  );
}
