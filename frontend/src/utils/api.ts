import type { ApiError } from '../types';

const TOKEN_KEY = 'openskill_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/**
 * ApiClientError carries the structured backend error (code/detail) so views
 * can show specific feedback (e.g. field-level validation messages).
 */
export class ApiClientError extends Error {
  status: number;
  code: string;
  detail?: unknown;
  constructor(status: number, payload: ApiError) {
    super(payload.error || 'Request failed');
    this.status = status;
    this.code = payload.code;
    this.detail = payload.detail;
  }
}

/**
 * Optional listener invoked when any request returns 401.
 * The auth store sets this so it can clear local state and redirect to login.
 */
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(handler: () => void): void {
  onUnauthorized = handler;
}

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** When false, do not send the Authorization header even if a token exists. */
  auth?: boolean;
}

/**
 * Wrapper around fetch:
 * - Prepends /api so it goes through the Vite dev proxy (and matches prod, where
 *   the same Fastify server serves both API and built frontend).
 *   In production we serve the SPA from the same Fastify server, so /api/* maps
 *   to /api-prefixed routes there too.
 * - Attaches the JWT bearer token by default
 * - Decodes JSON
 * - Throws ApiClientError on non-2xx so callers can use try/catch
 * - Calls onUnauthorized() on 401 (auto-logout)
 */
export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  const useAuth = opts.auth !== false;

  if (opts.body !== undefined && !(opts.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }

  if (useAuth) {
    const tok = getToken();
    if (tok) headers.set('authorization', `Bearer ${tok}`);
  }

  const init: RequestInit = {
    ...opts,
    headers,
    body:
      opts.body === undefined
        ? undefined
        : opts.body instanceof FormData
          ? opts.body
          : JSON.stringify(opts.body),
  };

  const url = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  const res = await fetch(url, init);

  let data: unknown = null;
  if (res.status !== 204) {
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    const payload: ApiError =
      data && typeof data === 'object' && 'error' in (data as object)
        ? (data as ApiError)
        : { error: `HTTP ${res.status}`, code: 'UNKNOWN' };
    throw new ApiClientError(res.status, payload);
  }

  return data as T;
}

/**
 * Trigger a file download for a path served by our API. Adds the bearer token
 * via fetch (since `<a download>` cannot inject custom headers) and falls
 * back to throwing ApiClientError on non-2xx so callers can show a toast.
 */
export async function downloadFile(path: string, suggestedFilename: string): Promise<void> {
  const headers = new Headers();
  const tok = getToken();
  if (tok) headers.set('authorization', `Bearer ${tok}`);

  const url = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  const res = await fetch(url, { method: 'GET', headers });

  if (!res.ok) {
    const text = await res.text();
    let payload: ApiError = { error: `HTTP ${res.status}`, code: 'UNKNOWN' };
    try {
      const parsed = text ? JSON.parse(text) : null;
      if (parsed && typeof parsed === 'object' && 'error' in parsed) payload = parsed;
    } catch {
      /* ignore */
    }
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiClientError(res.status, payload);
  }

  // Honour Content-Disposition filename if present
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename="?([^"]+)"?/);
  const filename = m ? m[1] : suggestedFilename;

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoking so Safari has time to start the download
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
