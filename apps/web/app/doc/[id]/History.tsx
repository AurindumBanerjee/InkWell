'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';

interface VersionSummary {
  id: string;
  kind: 'manual' | 'auto' | 'restore';
  label: string | null;
  created_at: string;
  created_by_name: string | null;
  preview: string;
  chars: number;
}

const KIND_LABEL = { manual: 'Saved', auto: 'Auto', restore: 'Before restore' } as const;

export function History({ docId, canEdit }: { docId: string; canEdit: boolean }) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [open, setOpen] = useState<(VersionSummary & { text: string }) | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const r = await api<{ versions: VersionSummary[] }>('GET', `/documents/${docId}/versions`);
    setVersions(r.versions);
  }, [docId]);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    try {
      setError('');
      setNote('');
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <aside className="panel" data-testid="history">
      <div className="row between">
        <h3>History</h3>
        {canEdit && (
          <button
            onClick={() => {
              const label = prompt('Name this version (optional)') ?? undefined;
              void run(async () => {
                await api('POST', `/documents/${docId}/versions`, label ? { label } : {});
                await load();
              });
            }}
          >
            Save version
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {note && <p className="muted">{note}</p>}

      {open ? (
        <div>
          <button className="ghost" onClick={() => setOpen(null)}>
            ← All versions
          </button>
          <p className="muted">
            {open.label ?? KIND_LABEL[open.kind]} · {new Date(open.created_at).toLocaleString()}
          </p>
          <pre className="version-text" data-testid="version-text">
            {open.text}
          </pre>
          {canEdit && (
            <button
              className="primary"
              onClick={() =>
                void run(async () => {
                  if (!confirm('Restore this version? The current text is kept in history.'))
                    return;
                  await api('POST', `/documents/${docId}/versions/${open.id}/restore`);
                  setOpen(null);
                  setNote('Restored. Your previous text is saved in history.');
                  await load();
                })
              }
            >
              Restore this version
            </button>
          )}
        </div>
      ) : (
        <ul className="list">
          {versions.map((v) => (
            <li key={v.id}>
              <button
                className="linklike"
                onClick={() =>
                  void run(async () => {
                    const r = await api<{ version: VersionSummary & { text: string } }>(
                      'GET',
                      `/documents/${docId}/versions/${v.id}`,
                    );
                    setOpen(r.version);
                  })
                }
              >
                <strong>{v.label ?? KIND_LABEL[v.kind]}</strong>
                <span className="muted">
                  {new Date(v.created_at).toLocaleString()}
                  {v.created_by_name ? ` · ${v.created_by_name}` : ''}
                </span>
                <span className="muted clip">{v.preview || '(empty)'}</span>
              </button>
            </li>
          ))}
          {versions.length === 0 && <li className="muted">No versions yet.</li>}
        </ul>
      )}
    </aside>
  );
}
