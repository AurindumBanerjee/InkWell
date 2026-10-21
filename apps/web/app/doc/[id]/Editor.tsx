'use client';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { yCollab } from 'y-codemirror.next';
import {
  colorFor,
  encodeAnchor,
  openCollab,
  resolveAnchor,
  type Collab,
  type ConnStatus,
} from '../../../lib/collab';

interface Me {
  id: string;
  name: string;
}
interface Peer {
  clientId: number;
  name: string;
  color: string;
}

/** What the comments UI needs from a comment to highlight it. */
export interface AnchoredComment {
  id: string;
  anchor_start: string | null;
  anchor_end: string | null;
  resolved_at: string | null;
}
/** The user's current text selection, as anchors a new comment can attach to. */
export interface TextSelection {
  anchorStart: string;
  anchorEnd: string;
  quoted: string;
}
export interface EditorApi {
  jumpTo(commentId: string): void;
}

interface EditorProps {
  docId: string;
  canEdit: boolean;
  me: Me;
  comments: AnchoredComment[];
  onSelection: (s: TextSelection | null) => void;
  onCommentClick: (id: string) => void;
  /** Called when the server says comments changed, and after every (re)connect. */
  onCommentsChanged: () => void;
  apiRef: MutableRefObject<EditorApi | null>;
}

const STATUS_LABEL: Record<ConnStatus, string> = {
  connecting: 'Connecting…',
  online: 'Live',
  offline: 'Offline — edits are saved locally and will sync when you reconnect',
  denied: 'Access lost',
};

// Highlights live in editor state so CodeMirror maps them through every edit, local or remote.
const setHighlights = StateEffect.define<DecorationSet>();
const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setHighlights)) value = e.value;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function Editor({
  docId,
  canEdit,
  me,
  comments,
  onSelection,
  onCommentClick,
  onCommentsChanged,
  apiRef,
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [preview, setPreview] = useState('');
  const [showPreview, setShowPreview] = useState(false);

  // Latest props for long-lived editor callbacks, without rebuilding the editor on every render.
  const live = useRef({ comments, onSelection, onCommentClick, onCommentsChanged });
  live.current = { comments, onSelection, onCommentClick, onCommentsChanged };
  const applyHighlights = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const collab: Collab = openCollab(docId, setStatus, () => live.current.onCommentsChanged());
    const { awareness } = collab.provider;
    const { color, light } = colorFor(me.id);
    awareness.setLocalStateField('user', { id: me.id, name: me.name, color, colorLight: light });

    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: collab.text.toString(),
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          EditorView.lineWrapping,
          EditorState.readOnly.of(!canEdit),
          EditorView.editable.of(canEdit),
          yCollab(collab.text, awareness),
          highlightField,
          EditorView.updateListener.of((u) => {
            if (!u.selectionSet) return;
            const { from, to } = u.state.selection.main;
            if (from === to) return live.current.onSelection(null);
            live.current.onSelection({
              anchorStart: encodeAnchor(collab.text, from),
              anchorEnd: encodeAnchor(collab.text, to),
              quoted: u.state.sliceDoc(from, Math.min(to, from + 500)),
            });
          }),
          EditorView.domEventHandlers({
            click(e) {
              const el = (e.target as HTMLElement).closest('[data-comment]');
              const id = el?.getAttribute('data-comment');
              if (id) live.current.onCommentClick(id);
            },
          }),
        ],
      }),
    });

    // (Re)compute highlights from the authoritative anchors; between calls CodeMirror maps them.
    applyHighlights.current = () => {
      const ranges = [];
      for (const c of live.current.comments) {
        if (!c.anchor_start || !c.anchor_end || c.resolved_at) continue;
        const from = resolveAnchor(collab.ydoc, c.anchor_start);
        const to = resolveAnchor(collab.ydoc, c.anchor_end);
        if (from === null || to === null || to <= from || to > view.state.doc.length) continue;
        ranges.push(
          Decoration.mark({ class: 'cm-comment', attributes: { 'data-comment': c.id } }).range(
            from,
            to,
          ),
        );
      }
      view.dispatch({ effects: setHighlights.of(Decoration.set(ranges, true)) });
    };
    applyHighlights.current();

    apiRef.current = {
      jumpTo(commentId) {
        const c = live.current.comments.find((x) => x.id === commentId);
        const at = c?.anchor_start ? resolveAnchor(collab.ydoc, c.anchor_start) : null;
        if (at === null || at > view.state.doc.length) return;
        view.dispatch({
          selection: { anchor: at },
          effects: EditorView.scrollIntoView(at, { y: 'center' }),
        });
      },
    };

    const syncPeers = () => {
      const seen = new Map<string, Peer>();
      awareness.getStates().forEach((s, clientId) => {
        const u = (s as { user?: { id: string; name: string; color: string } }).user;
        if (u && !seen.has(u.id)) seen.set(u.id, { clientId, name: u.name, color: u.color });
      });
      setPeers([...seen.values()]);
    };
    awareness.on('change', syncPeers);
    syncPeers();

    const render = () =>
      setPreview(DOMPurify.sanitize(marked.parse(collab.text.toString(), { async: false })));
    collab.text.observe(render);
    render();

    // Test hook: lets end-to-end tests simulate going offline/online deterministically.
    if (process.env.NEXT_PUBLIC_E2E === 'true') {
      (window as unknown as Record<string, unknown>).__inkwell = {
        goOffline: () => collab.provider.disconnect(),
        goOnline: () => collab.provider.connect(),
        text: () => collab.text.toString(),
      };
    }

    return () => {
      awareness.off('change', syncPeers);
      applyHighlights.current = null;
      apiRef.current = null;
      view.destroy();
      collab.destroy();
    };
  }, [docId, canEdit, me.id, me.name, apiRef]);

  // New or changed comments: refresh the highlights.
  useEffect(() => {
    applyHighlights.current?.();
  }, [comments]);

  return (
    <div>
      <div className="row between" style={{ margin: '12px 0' }}>
        <span className={`pill ${status}`} data-testid="status" data-status={status}>
          {STATUS_LABEL[status]}
        </span>
        <span className="row" data-testid="presence">
          <span className="avatars">
            {peers.map((p) => (
              <span
                key={p.clientId}
                className="avatar"
                title={p.name}
                style={{ background: p.color }}
                data-testid="peer"
              >
                {p.name.slice(0, 1).toUpperCase()}
              </span>
            ))}
          </span>
          <button className="ghost" onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? 'Hide' : 'Show'} preview
          </button>
        </span>
      </div>
      <div className={showPreview ? 'split' : undefined}>
        <div ref={host} className="editor" data-testid="editor" />
        {showPreview && (
          <div
            className="preview"
            data-testid="preview"
            dangerouslySetInnerHTML={{ __html: preview }}
          />
        )}
      </div>
    </div>
  );
}
