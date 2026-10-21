import * as Y from 'yjs';
import type { Db } from '../db.js';
import { resolveRange, TEXT_KEY } from './anchors.js';
import { rebaseHunks, type Hunk } from './hunks.js';
import type { Limits } from './usage.js';

export type SuggestionStatus =
  'working' | 'pending' | 'accepted' | 'rejected' | 'stale' | 'failed' | 'cancelled';

export interface Source {
  url: string;
  title: string;
}

export interface SuggestionRow {
  id: string;
  document_id: string;
  created_by: string | null;
  mode: string;
  status: SuggestionStatus;
  anchor_start: string;
  anchor_end: string;
  base_text: string;
  proposed_text: string | null;
  hunks: Hunk[] | null;
  sources: Source[] | null;
  tokens_used: number;
  steps: number;
  own_key: boolean;
  error_code: string | null;
  limits: (Limits & { retryAfterS?: number; kind?: string; takenAt?: number }) | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

const COLS = `id, document_id, created_by, mode, status, anchor_start, anchor_end, base_text,
  proposed_text, hunks, sources, tokens_used, steps, own_key, error_code, limits, resolved_by,
  resolved_at, created_at`;

export async function insertWorking(
  db: Db,
  a: {
    documentId: string;
    userId: string;
    mode: string;
    anchorStart: string;
    anchorEnd: string;
    baseText: string;
    ownKey: boolean;
  },
): Promise<SuggestionRow> {
  const { rows } = await db.query<SuggestionRow>(
    `INSERT INTO ai_suggestions
       (document_id, created_by, mode, status, anchor_start, anchor_end, base_text, own_key)
     VALUES ($1, $2, $3, 'working', $4, $5, $6, $7) RETURNING ${COLS}`,
    [a.documentId, a.userId, a.mode, a.anchorStart, a.anchorEnd, a.baseText, a.ownKey],
  );
  return rows[0]!;
}

export async function markPending(
  db: Db,
  id: string,
  a: {
    proposedText: string;
    hunks: Hunk[];
    sources?: Source[];
    tokens: number;
    steps: number;
    limits?: SuggestionRow['limits'];
  },
): Promise<SuggestionRow | null> {
  const { rows } = await db.query<SuggestionRow>(
    `UPDATE ai_suggestions SET status = 'pending', proposed_text = $2, hunks = $3, sources = $4,
            tokens_used = $5, steps = $6, limits = $7
      WHERE id = $1 AND status = 'working' RETURNING ${COLS}`,
    [
      id,
      a.proposedText,
      JSON.stringify(a.hunks),
      a.sources ? JSON.stringify(a.sources) : null,
      a.tokens,
      a.steps,
      a.limits ? JSON.stringify(a.limits) : null,
    ],
  );
  return rows[0] ?? null;
}

export async function markFailed(
  db: Db,
  id: string,
  code: string,
  a: {
    tokens: number;
    steps: number;
    limits?: SuggestionRow['limits'];
    status?: 'failed' | 'cancelled';
  },
): Promise<SuggestionRow | null> {
  const { rows } = await db.query<SuggestionRow>(
    `UPDATE ai_suggestions SET status = $5, error_code = $2, tokens_used = $3, steps = $4,
            limits = COALESCE($6, limits)
      WHERE id = $1 AND status = 'working' RETURNING ${COLS}`,
    [id, code, a.tokens, a.steps, a.status ?? 'failed', a.limits ? JSON.stringify(a.limits) : null],
  );
  return rows[0] ?? null;
}

export async function getSuggestion(db: Db, id: string): Promise<SuggestionRow | null> {
  const { rows } = await db.query<SuggestionRow>(
    `SELECT ${COLS} FROM ai_suggestions WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listSuggestions(
  db: Db,
  documentId: string,
  limit = 50,
): Promise<SuggestionRow[]> {
  const { rows } = await db.query<SuggestionRow>(
    `SELECT ${COLS} FROM ai_suggestions WHERE document_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [documentId, limit],
  );
  return rows;
}

/** Moves a suggestion between statuses atomically; null if it was not in one of the `from` states. */
export async function transition(
  db: Db,
  id: string,
  from: SuggestionStatus[],
  to: SuggestionStatus,
  userId?: string,
): Promise<SuggestionRow | null> {
  const { rows } = await db.query<SuggestionRow>(
    `UPDATE ai_suggestions SET status = $3, resolved_by = $4, resolved_at = now()
      WHERE id = $1 AND status = ANY($2::text[]) RETURNING ${COLS}`,
    [id, from, to, userId ?? null],
  );
  return rows[0] ?? null;
}

/** A single-node instance has no run in flight at start-up, so any "working" row was interrupted. */
export async function sweepInterrupted(db: Db): Promise<number> {
  const r = await db.query(
    `UPDATE ai_suggestions SET status = 'failed', error_code = 'interrupted' WHERE status = 'working'`,
  );
  return r.rowCount ?? 0;
}

/** What clients see. Own-key rate-limit numbers go to the person who made the request only. */
export interface PublicSuggestion {
  id: string;
  documentId: string;
  mode: string;
  status: SuggestionStatus;
  anchorStart: string;
  anchorEnd: string;
  baseText: string;
  proposedText: string | null;
  hunks: Hunk[] | null;
  sources: Source[] | null;
  tokensUsed: number;
  steps: number;
  errorCode: string | null;
  createdBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
  limits?: SuggestionRow['limits'];
}

export function toPublic(row: SuggestionRow, viewerId: string): PublicSuggestion {
  return {
    id: row.id,
    documentId: row.document_id,
    mode: row.mode,
    status: row.status,
    anchorStart: row.anchor_start,
    anchorEnd: row.anchor_end,
    baseText: row.base_text,
    proposedText: row.proposed_text,
    hunks: row.hunks,
    sources: row.sources,
    tokensUsed: row.tokens_used,
    steps: row.steps,
    errorCode: row.error_code,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    ...(row.created_by === viewerId && row.limits ? { limits: row.limits } : {}),
  };
}

export type ApplyPlan =
  | { ok: true; from: number; hunks: Hunk[]; current: string }
  | { ok: false; reason: 'overlap' | 'too-changed' | 'anchor-lost' };

/**
 * Decides whether a suggestion can still be applied to the document as it is NOW, without
 * changing anything. The anchored range is re-resolved, the text currently inside it is compared
 * with the text the model saw, and the model's hunks are re-based onto it. Any ambiguity makes
 * the suggestion stale; nothing is ever guessed.
 */
export function planApply(doc: Y.Doc, row: SuggestionRow): ApplyPlan {
  const range = resolveRange(doc, row.anchor_start, row.anchor_end);
  if (!range || !row.hunks) return { ok: false, reason: 'anchor-lost' };
  const current = doc.getText(TEXT_KEY).toString().slice(range.from, range.to);
  const merged = rebaseHunks(row.base_text, row.hunks, current);
  if (!merged.ok) return { ok: false, reason: merged.reason };
  return { ok: true, from: range.from, hunks: merged.hunks, current };
}

/**
 * Applies a plan as ONE Yjs transaction. Hunks go in from the end backwards so earlier positions
 * stay valid; only the characters the hunks cover are touched, so concurrent edits elsewhere,
 * including ones still arriving from other clients, merge normally.
 */
export function commitApply(
  doc: Y.Doc,
  plan: Extract<ApplyPlan, { ok: true }>,
  origin: unknown,
): void {
  const text = doc.getText(TEXT_KEY);
  doc.transact(() => {
    for (const h of [...plan.hunks].sort((a, b) => b.start - a.start)) {
      const at = plan.from + h.start;
      if (h.end > h.start) text.delete(at, h.end - h.start);
      if (h.insert) text.insert(at, h.insert);
    }
  }, origin);
}
