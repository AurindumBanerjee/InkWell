'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../../../lib/api';
import { wsBase } from '../../../../lib/collab';
import type { TextSelection } from '../Editor';

interface Mode {
  id: string;
  label: string;
  description: string;
  kind: string;
}
interface UsageLine {
  label: string;
  text: string;
}
interface UsageView {
  heading: string;
  lines: UsageLine[];
  warning?: string;
  note?: string;
}
interface Status {
  enabled: boolean;
  invite: { restricted: boolean; allowed: boolean };
  modes: Mode[];
  llm: { serverKeyConfigured: boolean; model: string };
  search: { configured: boolean };
  limits: { perMinute: number; perDay: number; remaining: { minute: number; day: number } };
  budget: {
    enabled: boolean;
    exhausted: boolean;
    usedToday: number;
    dailyBudget: number;
    resetsAt: string;
  };
  usage: UsageView;
}
interface Hunk {
  start: number;
  end: number;
  insert: string;
}
interface Suggestion {
  id: string;
  mode: string;
  status: string;
  baseText: string;
  hunks: Hunk[] | null;
  sources: { url: string; title: string }[] | null;
  errorCode: string | null;
}
interface Progress {
  id: string;
  kind: string;
  detail: string;
}

/** The last 4 characters at most, computed here: the server never sends a key back. */
const mask = (key: string): string =>
  key.length >= 12 ? `••••${key.slice(-4)}` : key ? '••••' : '';

/** Diff of a suggestion: unchanged context, removed text struck through, added text highlighted. */
function DiffView({ s }: { s: Suggestion }) {
  const parts: { kind: 'same' | 'del' | 'ins'; text: string }[] = [];
  const CONTEXT = 40;
  /** Unchanged text between changes, trimmed to a little context on the sides that touch a change. */
  const same = (t: string, where: 'lead' | 'mid' | 'trail' | 'only') => {
    if (!t) return;
    let text = t;
    if (t.length > CONTEXT * 2 + 10) {
      if (where === 'lead') text = `…${t.slice(-CONTEXT)}`;
      else if (where === 'trail') text = `${t.slice(0, CONTEXT)}…`;
      else if (where === 'mid') text = `${t.slice(0, CONTEXT)}…${t.slice(-CONTEXT)}`;
      else text = `${t.slice(0, CONTEXT * 2)}…`;
    }
    parts.push({ kind: 'same', text });
  };
  const hunks = s.hunks ?? [];
  let pos = 0;
  hunks.forEach((h, i) => {
    same(s.baseText.slice(pos, h.start), i === 0 ? 'lead' : 'mid');
    if (h.end > h.start) parts.push({ kind: 'del', text: s.baseText.slice(h.start, h.end) });
    if (h.insert) parts.push({ kind: 'ins', text: h.insert });
    pos = h.end;
  });
  same(s.baseText.slice(pos), hunks.length === 0 ? 'only' : 'trail');
  return (
    <pre className="ai-diff" data-testid="ai-diff">
      {parts.map((p, i) =>
        p.kind === 'del' ? (
          <del key={i}>{p.text}</del>
        ) : p.kind === 'ins' ? (
          <ins key={i}>{p.text}</ins>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </pre>
  );
}

/**
 * The AI collaborator UI. Loaded only in the AI build (see page.tsx). It proposes changes as
 * suggestions; nothing touches the document until an editor accepts.
 */
export default function AiPanel({
  docId,
  canEdit,
  selection,
}: {
  docId: string;
  canEdit: boolean;
  selection?: TextSelection | null;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [mode, setMode] = useState('grammar');
  const [useSelection, setUseSelection] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  // The user's own key lives in this component's memory only: never in storage, a cookie, or a URL.
  const [key, setKey] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [keyNote, setKeyNote] = useState('');
  const [usage, setUsage] = useState<UsageView | null>(null);
  const keyRef = useRef('');
  keyRef.current = key;

  const keyHeader = () => (keyRef.current ? { 'x-ai-key': keyRef.current } : undefined);

  const loadStatus = useCallback(async () => {
    setStatus(await api<Status>('GET', '/ai/status'));
  }, []);
  const loadList = useCallback(async () => {
    const r = await api<{ suggestions: Suggestion[]; messages: Record<string, string> }>(
      'GET',
      `/ai/suggestions?documentId=${docId}`,
    );
    setSuggestions(r.suggestions);
    setMessages(r.messages);
  }, [docId]);

  useEffect(() => {
    Promise.all([loadStatus(), loadList()]).catch((e: Error) => setError(e.message));
  }, [loadStatus, loadList]);

  // Live updates: suggestion status changes, research progress, and the budget switching off.
  useEffect(() => {
    const ws = new WebSocket(`${wsBase}/ai?doc=${docId}`);
    ws.onmessage = (m) => {
      const e = JSON.parse(String(m.data)) as {
        type: string;
        id?: string;
        kind?: string;
        detail?: string;
      };
      if (e.type === 'suggestion') {
        void loadList();
        if (e.id) setProgress((p) => (p?.id === e.id ? null : p));
      } else if (e.type === 'progress' && e.id) {
        setProgress({ id: e.id, kind: e.kind ?? '', detail: e.detail ?? '' });
      } else if (e.type === 'budget') {
        void loadStatus();
      }
    };
    return () => ws.close();
  }, [docId, loadList, loadStatus]);

  const run = async () => {
    setError('');
    setBusy(true);
    try {
      await api(
        'POST',
        '/ai/suggestions',
        {
          documentId: docId,
          mode,
          ...(useSelection && selection
            ? { anchorStart: selection.anchorStart, anchorEnd: selection.anchorEnd }
            : {}),
        },
        keyHeader(),
      );
      await loadList();
      await loadStatus();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
      await loadStatus().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, what: 'accept' | 'reject' | 'cancel') => {
    setError('');
    try {
      await api('POST', `/ai/suggestions/${id}/${what}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    }
    await loadList().catch(() => undefined);
  };

  const checkKey = async () => {
    setKeyNote('Checking…');
    try {
      const r = await api<{ accepted: boolean; message: string; usage: UsageView | null }>(
        'POST',
        '/ai/key/check',
        {},
        { 'x-ai-key': keyDraft },
      );
      if (r.accepted) {
        setKey(keyDraft);
        setUsage(r.usage);
      }
      setKeyNote(r.message);
    } catch (e) {
      setKeyNote(e instanceof ApiError ? e.message : 'Could not check the key.');
    }
    setKeyDraft(''); // the draft is dropped at once; only the checked key is kept, in memory
  };

  const refreshUsage = async () => {
    try {
      const r = await api<{ usage: UsageView; note?: string }>(
        'POST',
        '/ai/usage/refresh',
        {},
        keyHeader(),
      );
      setUsage(r.usage);
      if (r.note) setKeyNote(r.note);
    } catch (e) {
      setKeyNote(e instanceof ApiError ? e.message : 'Could not read usage.');
    }
  };

  const shownUsage = key ? usage : (status?.usage ?? null);
  const exhausted = status?.budget.exhausted && !key;
  const noModel = status && !status.llm.serverKeyConfigured && !key;
  const current = status?.modes.find((m) => m.id === mode);

  return (
    <aside className="panel" data-testid="inkwell-ai-collaborator-ui">
      <h3>AI collaborator</h3>
      {!status && !error && <p className="muted">Loading…</p>}
      {error && (
        <p className="error" role="alert" data-testid="ai-error">
          {error}
        </p>
      )}

      {status && !status.invite.allowed && (
        <p className="muted">
          The AI assistant is invite-only on this server and your account is not on the list.
        </p>
      )}

      {status?.invite.allowed && (
        <>
          {exhausted && (
            <p className="error" data-testid="ai-budget-exhausted">
              Today&apos;s shared AI budget is used up. It resets at{' '}
              {new Date(status.budget.resetsAt).toLocaleString()}. You can keep going with your own
              key.
            </p>
          )}
          {noModel && (
            <p className="muted">No model is configured on this server. Add your own key below.</p>
          )}

          {canEdit ? (
            <>
              <label className="ai-field">
                Mode
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                  data-testid="ai-mode"
                >
                  {status.modes.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              {current && <p className="muted">{current.description}</p>}
              <label className="ai-field row">
                <input
                  type="checkbox"
                  checked={useSelection}
                  onChange={(e) => setUseSelection(e.target.checked)}
                />
                {selection ? (
                  <span data-testid="ai-scope">Only the selected text</span>
                ) : (
                  <span data-testid="ai-scope">Whole document (select text to narrow it)</span>
                )}
              </label>
              <button
                className="primary"
                onClick={run}
                disabled={busy || !!exhausted || !!noModel}
                data-testid="ai-run"
              >
                {busy ? 'Starting…' : `Run ${current?.label ?? ''}`}
              </button>
            </>
          ) : (
            <p className="muted">Viewers can read suggestions but cannot request or accept them.</p>
          )}

          {progress && (
            <p className="muted" data-testid="ai-progress">
              {progress.kind === 'search'
                ? 'Searching'
                : progress.kind === 'read'
                  ? 'Reading'
                  : 'Writing'}
              : {progress.detail}
            </p>
          )}

          <h4>Suggestions</h4>
          <ul className="list ai-list">
            {suggestions.map((s) => (
              <li key={s.id} data-testid="ai-suggestion" data-status={s.status}>
                <div className="row between">
                  <strong>{status.modes.find((m) => m.id === s.mode)?.label ?? s.mode}</strong>
                  <span className="badge" data-testid="ai-suggestion-status">
                    {s.status}
                  </span>
                </div>
                {s.status === 'working' && <p className="muted">Working…</p>}
                {(s.status === 'pending' || s.status === 'stale') && <DiffView s={s} />}
                {s.sources && s.sources.length > 0 && (
                  <ul className="ai-sources">
                    {s.sources.map((src) => (
                      <li key={src.url}>
                        <a href={src.url} target="_blank" rel="noopener noreferrer nofollow">
                          {src.title || src.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                {s.status === 'stale' && (
                  <p className="muted">
                    The text changed since this was suggested, so it cannot be applied.
                  </p>
                )}
                {s.status === 'failed' && (
                  <p className="muted">
                    {messages[s.errorCode ?? ''] ?? 'This request did not finish.'}
                  </p>
                )}
                {canEdit && (
                  <span className="row">
                    {s.status === 'pending' && (
                      <button
                        className="primary"
                        onClick={() => act(s.id, 'accept')}
                        data-testid="ai-accept"
                      >
                        Accept
                      </button>
                    )}
                    {(s.status === 'pending' || s.status === 'stale') && (
                      <button onClick={() => act(s.id, 'reject')} data-testid="ai-reject">
                        Reject
                      </button>
                    )}
                    {s.status === 'working' && (
                      <button onClick={() => act(s.id, 'cancel')}>Cancel</button>
                    )}
                  </span>
                )}
              </li>
            ))}
            {suggestions.length === 0 && <li className="muted">No suggestions yet.</li>}
          </ul>

          <h4>Usage</h4>
          {shownUsage && (
            <div data-testid="ai-usage">
              <p className="muted">{shownUsage.heading}</p>
              <ul className="ai-sources">
                {shownUsage.lines.map((l) => (
                  <li key={l.label}>
                    {l.label}: {l.text}
                  </li>
                ))}
              </ul>
              {shownUsage.warning && <p className="error">{shownUsage.warning}</p>}
              {shownUsage.note && <p className="muted">{shownUsage.note}</p>}
            </div>
          )}
          {status.budget.enabled && !key && (
            <p className="muted" data-testid="ai-budget">
              Shared budget today: {status.budget.usedToday.toLocaleString('en-US')} of{' '}
              {status.budget.dailyBudget.toLocaleString('en-US')} tokens used by everyone.
            </p>
          )}
          <p className="muted">
            Your requests today: {status.limits.remaining.minute} left this minute,{' '}
            {status.limits.remaining.day} left today.
          </p>
          <button className="ghost" onClick={refreshUsage}>
            Refresh usage
          </button>

          <h4>Your own API key</h4>
          <p className="muted">
            Optional. Kept in this page&apos;s memory only: never stored, never sent anywhere except
            with your own requests, and gone when you reload.
          </p>
          {key ? (
            <p className="row">
              <span data-testid="ai-key-active">Using your key: {mask(key)}</span>
              <button
                className="ghost"
                onClick={() => {
                  setKey('');
                  setUsage(null);
                  setKeyNote('');
                }}
              >
                Remove
              </button>
            </p>
          ) : (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void checkKey();
              }}
            >
              <input
                type="password"
                autoComplete="off"
                placeholder="Paste a key"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                data-testid="ai-key-input"
              />
              <button disabled={!keyDraft.trim()}>Check &amp; use</button>
            </form>
          )}
          {keyNote && <p className="muted">{keyNote}</p>}
        </>
      )}
    </aside>
  );
}
