'use client';

import { use, useEffect, useRef, useState } from 'react';
import { api, type Role, type User } from '../../../lib/api';
import { Editor } from './Editor';
import { History } from './History';

interface Doc {
  id: string;
  title: string;
}
interface Share {
  id: string;
  email: string;
  name: string;
  role: 'editor' | 'viewer';
}

export default function DocPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [me, setMe] = useState<User | null>(null);
  const [error, setError] = useState('');
  const [panel, setPanel] = useState<'history' | null>(null);
  const shareDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    Promise.all([
      api<{ document: Doc; role: Role }>('GET', `/documents/${id}`),
      api<{ user: User }>('GET', '/me'),
    ])
      .then(([r, m]) => {
        setDoc(r.document);
        setRole(r.role);
        setMe(m.user);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!doc || !role || !me) return <p className="muted">Loading…</p>;
  const canEdit = role !== 'viewer';

  return (
    <div>
      <div className="row between">
        <input
          aria-label="Title"
          defaultValue={doc.title}
          disabled={!canEdit}
          className="title-input"
          onBlur={(e) => {
            const title = e.target.value.trim();
            if (title && title !== doc.title) {
              api('PATCH', `/documents/${id}`, { title }).catch((err: Error) =>
                setError(err.message),
              );
            }
          }}
        />
        <span className="badge">{role}</span>
        <button onClick={() => setPanel((p) => (p === 'history' ? null : 'history'))}>
          History
        </button>
        {role === 'owner' && (
          <button onClick={() => shareDialog.current?.showModal()}>Share</button>
        )}
      </div>
      <div className={panel ? 'with-panel' : undefined}>
        <Editor docId={id} canEdit={canEdit} me={me} />
        {panel === 'history' && <History docId={id} canEdit={canEdit} />}
      </div>
      {role === 'owner' && <ShareDialog docId={id} dialogRef={shareDialog} />}
    </div>
  );
}

function ShareDialog({
  docId,
  dialogRef,
}: {
  docId: string;
  dialogRef: React.RefObject<HTMLDialogElement | null>;
}) {
  const [shares, setShares] = useState<Share[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('viewer');
  const [error, setError] = useState('');

  const load = () =>
    api<{ shares: Share[] }>('GET', `/documents/${docId}/shares`).then((r) => setShares(r.shares));
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [docId]);

  return (
    <dialog ref={dialogRef}>
      <h3>Share</h3>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setError('');
            await api('PUT', `/documents/${docId}/shares`, { email, role });
            setEmail('');
            await load();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <input
          type="email"
          required
          placeholder="email (must have signed in once)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}>
          <option value="viewer">viewer</option>
          <option value="editor">editor</option>
        </select>
        <button className="primary">Add</button>
      </form>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {shares.map((s) => (
          <li key={s.id}>
            <span>
              {s.name} <span className="muted">{s.email}</span>
            </span>
            <span className="row">
              {s.role}
              <button
                onClick={() =>
                  api('DELETE', `/documents/${docId}/shares/${s.id}`).then(load, (e: Error) =>
                    setError(e.message),
                  )
                }
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>
      <button onClick={() => dialogRef.current?.close()}>Close</button>
    </dialog>
  );
}
