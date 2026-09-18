'use client';

import { useState } from 'react';
import { Modal } from '@/components/Modal';
import { describeExtension } from '@/lib/pg-extensions';

export function ExtensionsList({
  extensions,
}: {
  extensions: { name: string; version: string }[];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const info = selected ? describeExtension(selected) : null;
  const version = selected
    ? extensions.find((ext) => ext.name === selected)?.version
    : null;

  return (
    <>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Extension</th>
              <th style={{ width: '8rem' }}>Version</th>
            </tr>
          </thead>
          <tbody>
            {extensions.map((ext) => (
              <tr
                key={ext.name}
                className="cursor-pointer"
                onClick={() => setSelected(ext.name)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelected(ext.name);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={`About ${ext.name}`}
              >
                <td className="font-mono">
                  <span className="underline decoration-dotted underline-offset-2">
                    {ext.name}
                  </span>
                </td>
                <td className="font-mono text-foreground-muted">{ext.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={selected !== null}
        title={selected ?? 'Extension'}
        subtitle={version ? `v${version} · PostgreSQL extension` : 'PostgreSQL extension'}
        size="compact"
        onClose={() => setSelected(null)}
      >
        {info && selected ? (
          <div className="ext-blurb">
            <p className="ext-blurb__summary">{info.summary}</p>
            {info.whyItMatters ? (
              <div className="ext-blurb__block">
                <div className="ext-blurb__label">Why it matters</div>
                <p>{info.whyItMatters}</p>
              </div>
            ) : null}
            {info.caution ? (
              <div className="ext-blurb__block ext-blurb__block--warn">
                <div className="ext-blurb__label">Caution</div>
                <p>{info.caution}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
