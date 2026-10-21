'use client';

import { useState } from 'react';
import { api, type Role } from '../../../lib/api';
import type { TextSelection } from './Editor';

export interface CommentRow {
  id: string;
  parent_id: string | null;
  author_id: string | null;
  author_name: string | null;
  body: string;
  anchor_start: string | null;
  anchor_end: string | null;
  quoted_text: string | null;
  resolved_at: string | null;
  created_at: string;
  edited_at: string | null;
}

interface Props {
  docId: string;
  meId: string;
  role: Role;
  comments: CommentRow[];
  reload: () => Promise<void>;
  selection: TextSelection | null;
  activeId: string | null;
  onJump: (id: string) => void;
  onPosted: () => void;
}

export function Comments({
  docId,
  meId,
  role,
  comments,
  reload,
  selection,
  activeId,
  onJump,
  onPosted,
}: Props) {
  const [draft, setDraft] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState('');

  const canEdit = role !== 'viewer';
  const roots = comments.filter((c) => !c.parent_id && (showResolved || !c.resolved_at));
  const repliesOf = (id: string) => comments.filter((c) => c.parent_id === id);
  const hiddenCount = comments.filter((c) => !c.parent_id && c.resolved_at).length;

  const run = async (fn: () => Promise<void>) => {
    try {
      setError('');
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const base = `/documents/${docId}/comments`;

  return (
    <aside className="panel" data-testid="comments-panel">
      <h3>Comments</h3>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('POST', base, {
              body: draft,
              ...(selection ?? {}),
              ...(selection ? { quoted: selection.quoted } : {}),
            });
            setDraft('');
            onPosted();
          });
        }}
      >
        {selection ? (
          <p className="quote" data-testid="comment-target">
            On “{selection.quoted.slice(0, 80)}
            {selection.quoted.length > 80 ? '…' : ''}”
          </p>
        ) : (
          <p className="muted">
            Select text in the document to comment on it, or write a general note.
          </p>
        )}
        <textarea
          data-testid="comment-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a comment…"
          rows={3}
          maxLength={4000}
        />
        <button className="primary" disabled={!draft.trim()} data-testid="comment-submit">
          Comment
        </button>
      </form>
      {error && <p className="error">{error}</p>}

      <ul className="threads">
        {roots.map((c) => (
          <li
            key={c.id}
            className={`thread${c.id === activeId ? ' active' : ''}${c.resolved_at ? ' resolved' : ''}`}
            data-testid="thread"
          >
            {c.quoted_text && (
              <button
                className="quote linklike"
                disabled={!c.anchor_start}
                onClick={() => onJump(c.id)}
                title="Jump to text"
              >
                “{c.quoted_text.slice(0, 80)}
                {c.quoted_text.length > 80 ? '…' : ''}”
              </button>
            )}
            <CommentBody c={c} meId={meId} base={base} run={run} role={role} />
            {repliesOf(c.id).map((r) => (
              <div className="reply" key={r.id} data-testid="reply">
                <CommentBody c={r} meId={meId} base={base} run={run} role={role} />
              </div>
            ))}
            <ReplyBox
              onSend={(body) =>
                run(() => api('POST', base, { body, parentId: c.id }).then(() => undefined))
              }
            />
            {(canEdit || c.author_id === meId) && (
              <button
                className="ghost"
                data-testid="resolve"
                onClick={() =>
                  void run(() =>
                    api('PATCH', `${base}/${c.id}`, { resolved: !c.resolved_at }).then(
                      () => undefined,
                    ),
                  )
                }
              >
                {c.resolved_at ? 'Reopen' : 'Resolve'}
              </button>
            )}
          </li>
        ))}
        {roots.length === 0 && <li className="muted">No comments yet.</li>}
      </ul>
      {hiddenCount > 0 && (
        <button className="ghost" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? 'Hide' : 'Show'} {hiddenCount} resolved
        </button>
      )}
    </aside>
  );
}

function CommentBody({
  c,
  meId,
  base,
  run,
  role,
}: {
  c: CommentRow;
  meId: string;
  base: string;
  run: (fn: () => Promise<void>) => Promise<void>;
  role: Role;
}) {
  const mine = c.author_id === meId;
  return (
    <div>
      <div className="meta">
        <strong>{c.author_name ?? 'Deleted user'}</strong>
        <span className="muted">
          {new Date(c.created_at).toLocaleString()}
          {c.edited_at ? ' · edited' : ''}
        </span>
      </div>
      <p className="body" data-testid="comment-body">
        {c.body}
      </p>
      <span className="row">
        {mine && (
          <button
            className="ghost"
            onClick={() => {
              const body = prompt('Edit comment', c.body);
              if (body?.trim()) {
                void run(() => api('PATCH', `${base}/${c.id}`, { body }).then(() => undefined));
              }
            }}
          >
            Edit
          </button>
        )}
        {(mine || role === 'owner') && (
          <button
            className="ghost danger"
            onClick={() => {
              if (
                confirm(c.parent_id ? 'Delete this reply?' : 'Delete this thread and its replies?')
              ) {
                void run(() => api('DELETE', `${base}/${c.id}`).then(() => undefined));
              }
            }}
          >
            Delete
          </button>
        )}
      </span>
    </div>
  );
}

function ReplyBox({ onSend }: { onSend: (body: string) => Promise<void> }) {
  const [text, setText] = useState('');
  return (
    <form
      className="row reply-box"
      onSubmit={(e) => {
        e.preventDefault();
        void onSend(text).then(() => setText(''));
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Reply…"
        maxLength={4000}
        data-testid="reply-input"
      />
      <button disabled={!text.trim()} data-testid="reply-submit">
        Reply
      </button>
    </form>
  );
}
