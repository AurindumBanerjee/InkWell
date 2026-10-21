'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

interface Hit {
  id: string;
  title: string;
  updated_at: string;
  snippet: string;
}

const HIT_START = '\u0001';
const HIT_END = '\u0002';

/** Renders a snippet whose matches are wrapped in control characters, with no HTML involved. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(new RegExp(`${HIT_START}([\\s\\S]*?)${HIT_END}`));
  return (
    <span className="muted clip-2">
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}

export function Search() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState('');
  const latest = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setHits(null);
      setError('');
      return;
    }
    const seq = ++latest.current;
    const timer = setTimeout(async () => {
      try {
        const r = await api<{ results: Hit[] }>('GET', `/search?q=${encodeURIComponent(term)}`);
        if (seq === latest.current) {
          setHits(r.results);
          setError('');
        }
      } catch (e) {
        if (seq === latest.current) setError((e as Error).message);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <section className="search" aria-label="Search documents">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder='Search documents…  try "exact phrase", -exclude, or'
        aria-label="Search"
        data-testid="search-input"
      />
      {error && <p className="error">{error}</p>}
      {hits && (
        <ul className="list results" data-testid="search-results">
          {hits.map((h) => (
            <li key={h.id}>
              <a href={`/doc/${h.id}`}>
                <strong>{h.title}</strong>
                <Snippet text={h.snippet} />
              </a>
            </li>
          ))}
          {hits.length === 0 && <li className="muted">No matches.</li>}
        </ul>
      )}
    </section>
  );
}
