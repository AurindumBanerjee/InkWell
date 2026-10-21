export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
}
export type Role = 'owner' | 'editor' | 'viewer';
export interface Workspace {
  id: string;
  name: string;
  role: Role;
}
export interface DocSummary {
  id: string;
  title: string;
  updated_at: string;
  role?: Role;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers:
      body === undefined && !headers
        ? undefined
        : {
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...headers,
          },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, data.message ?? data.error ?? res.statusText);
  return data;
}

export const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
