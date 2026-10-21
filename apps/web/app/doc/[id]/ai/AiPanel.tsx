'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../../lib/api';

interface AiStatus {
  enabled: boolean;
  llmConfigured: boolean;
  searchConfigured: boolean;
  features: string[];
}

/**
 * Entry point of the AI collaborator UI. Loaded only in the AI build (see page.tsx). This is the
 * seam the AI features grow from; today it just reports what the server has configured.
 */
export default function AiPanel({ docId }: { docId: string; canEdit: boolean }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<AiStatus>('GET', '/ai/status')
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
  }, [docId]);

  return (
    <aside className="panel" data-testid="inkwell-ai-collaborator-ui">
      <h3>AI collaborator</h3>
      {error && <p className="error">{error}</p>}
      {!status && !error && <p className="muted">Loading…</p>}
      {status && (
        <p className="muted" data-testid="ai-status">
          {status.llmConfigured ? 'Model connected.' : 'No model is configured on this server.'}
        </p>
      )}
    </aside>
  );
}
