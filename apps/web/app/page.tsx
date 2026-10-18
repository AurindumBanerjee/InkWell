'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, apiBase, ApiError, type DocSummary, type User, type Workspace } from '../lib/api';

export default function Home() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api<{ user: User }>('GET', '/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) return <p className="muted">Loading…</p>;
  if (user === null) return <Login />;
  return <Dashboard user={user} onLogout={() => setUser(null)} />;
}

function Login() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  // Passwordless dev login is only wired up when the API enables it (localhost only).
  const devLogin = process.env.NEXT_PUBLIC_DEV_LOGIN === 'true';

  return (
    <div>
      <h1>Write together, in real time.</h1>
      <p className="muted">Sign in to create and share Markdown documents.</p>
      <p>
        <a href={`${apiBase}/auth/github`}>
          <button className="primary">Continue with GitHub</button>
        </a>
      </p>
      {devLogin && (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api('POST', '/auth/dev-login', { email });
              location.reload();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <input
            type="email"
            required
            placeholder="dev email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button>Dev login</button>
          {error && <span className="error">{error}</span>}
        </form>
      )}
    </div>
  );
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [wsId, setWsId] = useState('');
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [shared, setShared] = useState<DocSummary[]>([]);
  const [error, setError] = useState('');

  const loadDocs = useCallback(async (id: string) => {
    if (id)
      setDocs(
        (await api<{ documents: DocSummary[] }>('GET', `/workspaces/${id}/documents`)).documents,
      );
  }, []);

  useEffect(() => {
    (async () => {
      const { workspaces } = await api<{ workspaces: Workspace[] }>('GET', '/workspaces');
      setWorkspaces(workspaces);
      setWsId(workspaces[0]?.id ?? '');
      setShared(
        (await api<{ documents: DocSummary[] }>('GET', '/documents/shared-with-me')).documents,
      );
    })().catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    loadDocs(wsId).catch((e: Error) => setError(e.message));
  }, [wsId, loadDocs]);

  const current = workspaces.find((w) => w.id === wsId);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError('');
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'something went wrong');
    }
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="muted">{user.email}</span>
        <button
          onClick={() =>
            run(async () => {
              await api('POST', '/auth/logout');
              onLogout();
            })
          }
        >
          Sign out
        </button>
      </div>

      <h2>Documents</h2>
      <div className="row">
        <select value={wsId} onChange={(e) => setWsId(e.target.value)} aria-label="Workspace">
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({w.role})
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            const name = prompt('Workspace name?');
            if (name)
              run(async () => {
                const { workspace } = await api<{ workspace: Workspace }>('POST', '/workspaces', {
                  name,
                });
                setWorkspaces((w) => [...w, workspace]);
                setWsId(workspace.id);
              });
          }}
        >
          New workspace
        </button>
        {current && current.role !== 'viewer' && (
          <button
            className="primary"
            onClick={() =>
              run(async () => {
                const { document } = await api<{ document: DocSummary }>(
                  'POST',
                  `/workspaces/${wsId}/documents`,
                  {},
                );
                location.href = `/doc/${document.id}`;
              })
            }
          >
            New document
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}

      <ul className="list">
        {docs.map((d) => (
          <li key={d.id}>
            <a href={`/doc/${d.id}`}>{d.title}</a>
            <span className="muted">{new Date(d.updated_at).toLocaleString()}</span>
          </li>
        ))}
        {docs.length === 0 && <li className="muted">No documents yet.</li>}
      </ul>

      {shared.length > 0 && (
        <>
          <h2>Shared with me</h2>
          <ul className="list">
            {shared.map((d) => (
              <li key={d.id}>
                <a href={`/doc/${d.id}`}>{d.title}</a>
                <span className="muted">{d.role}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
