'use client';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useRef, useState } from 'react';
import { yCollab } from 'y-codemirror.next';
import { colorFor, openCollab, type Collab, type ConnStatus } from '../../../lib/collab';

interface Me {
  id: string;
  name: string;
}
interface Peer {
  clientId: number;
  name: string;
  color: string;
}

const STATUS_LABEL: Record<ConnStatus, string> = {
  connecting: 'Connecting…',
  online: 'Live',
  offline: 'Offline — edits are saved locally and will sync when you reconnect',
  denied: 'Access lost',
};

export function Editor({ docId, canEdit, me }: { docId: string; canEdit: boolean; me: Me }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [preview, setPreview] = useState('');
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    const collab: Collab = openCollab(docId, setStatus);
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
        ],
      }),
    });

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
      view.destroy();
      collab.destroy();
    };
  }, [docId, canEdit, me.id, me.name]);

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', margin: '12px 0' }}>
        <span className="muted" data-testid="status" data-status={status}>
          {STATUS_LABEL[status]}
        </span>
        <span className="row" data-testid="presence">
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
          <button onClick={() => setShowPreview((v) => !v)}>
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
