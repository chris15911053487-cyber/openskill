import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Loader2,
  UploadCloud,
  Trash2,
  AlertCircle,
  Eye,
  Package,
  Plus,
} from 'lucide-react';
import { api, ApiClientError, getToken } from '../utils/api';
import { useStore, useT } from '../store';
import type { TranslationKey } from '../i18n';
import type { SkillSummary, SkillStatus } from '../domain';

interface MyUploadsResponse {
  items: (SkillSummary & { rejection_reason: string | null })[];
}

const STATUS_STYLES: Record<SkillStatus, string> = {
  published: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  rejected: 'bg-rose-50 text-rose-700 border-rose-200',
};

const STATUS_KEYS: Record<SkillStatus, TranslationKey> = {
  published: 'skill.status.published',
  pending: 'skill.status.pending',
  rejected: 'skill.status.rejected',
};

async function reuploadSkill(slug: string, file: File): Promise<void> {
  const headers = new Headers();
  const tok = getToken();
  if (tok) headers.set('authorization', `Bearer ${tok}`);
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/skills/${slug}`, {
    method: 'PUT',
    headers,
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    let payload = { error: `HTTP ${res.status}`, code: 'UNKNOWN' } as {
      error: string;
      code: string;
      detail?: unknown;
    };
    try {
      const parsed = text ? JSON.parse(text) : null;
      if (parsed && typeof parsed === 'object' && 'error' in parsed) payload = parsed;
    } catch {
      /* ignore */
    }
    throw new ApiClientError(res.status, payload);
  }
}

export function MyUploadsView() {
  const t = useT();
  const qc = useQueryClient();
  const showToast = useStore((s) => s.showToast);
  const goToSkill = useStore((s) => s.goToSkill);
  const setView = useStore((s) => s.setView);

  const [reuploadingSlug, setReuploadingSlug] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadsQ = useQuery({
    queryKey: ['my-uploads'],
    queryFn: () => api<MyUploadsResponse>('/me/uploads'),
  });

  const reupload = useMutation({
    mutationFn: ({ slug, file }: { slug: string; file: File }) => reuploadSkill(slug, file),
    onSuccess: (_data, vars) => {
      showToast(t('myUploads.reuploaded', { name: vars.slug }), 'success');
      qc.invalidateQueries({ queryKey: ['my-uploads'] });
      qc.invalidateQueries({ queryKey: ['skill', vars.slug] });
      qc.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (err) => {
      const msg = err instanceof ApiClientError ? err.message : t('myUploads.reuploadFailed');
      showToast(msg, 'error');
    },
  });

  const remove = useMutation({
    mutationFn: (slug: string) => api<void>(`/skills/${slug}`, { method: 'DELETE' }),
    onSuccess: (_, slug) => {
      showToast(t('myUploads.deleted', { name: slug }), 'info');
      qc.invalidateQueries({ queryKey: ['my-uploads'] });
      qc.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (err) => {
      const msg = err instanceof ApiClientError ? err.message : t('myUploads.deleteFailed');
      showToast(msg, 'error');
    },
  });

  function triggerReupload(slug: string) {
    setReuploadingSlug(slug);
    fileInputRef.current?.click();
  }

  function handleFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !reuploadingSlug) return;
    reupload.mutate({ slug: reuploadingSlug, file });
    setReuploadingSlug(null);
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Package className="w-5 h-5" />
            {t('myUploads.title')}
          </h1>
          <p className="text-sm text-slate-500 mt-1">{t('myUploads.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => setView('upload')}
          className="inline-flex items-center gap-1.5 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-md px-4 py-2"
        >
          <Plus className="w-4 h-4" />
          {t('myUploads.newUpload')}
        </button>
      </header>

      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={handleFileChosen}
      />

      {uploadsQ.isLoading && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      )}
      {uploadsQ.error && (
        <div className="rounded-2xl bg-rose-50 border border-rose-200 p-4 text-sm text-rose-700">
          {t('myUploads.failedToLoad')}
        </div>
      )}
      {uploadsQ.data && uploadsQ.data.items.length === 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
          <Package className="w-8 h-8 mx-auto text-slate-300" />
          <p className="mt-2 text-sm text-slate-500">{t('myUploads.empty')}</p>
          <button
            type="button"
            onClick={() => setView('upload')}
            className="mt-4 inline-flex items-center gap-1.5 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-md px-4 py-2"
          >
            <UploadCloud className="w-4 h-4" />
            {t('myUploads.uploadFirst')}
          </button>
        </div>
      )}

      {uploadsQ.data && uploadsQ.data.items.length > 0 && (
        <ul className="space-y-3">
          {uploadsQ.data.items.map((s) => (
            <li
              key={s.id}
              className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-start gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <h3 className="text-base font-semibold truncate">{s.name}</h3>
                  {s.version && (
                    <span className="text-xs font-mono text-slate-400">v{s.version}</span>
                  )}
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs ${STATUS_STYLES[s.status]}`}
                  >
                    {t(STATUS_KEYS[s.status])}
                  </span>
                </div>
                <p className="text-sm text-slate-600 line-clamp-2">{s.description}</p>
                <div className="mt-1 text-xs text-slate-400">
                  {t('myUploads.updated')} {new Date(s.updated_at + 'Z').toLocaleString()}
                  {' · '}
                  {s.subscriber_count} {t('myUploads.subscribers')} · {s.download_count} {t('myUploads.downloads')}
                </div>
                {s.status === 'rejected' && s.rejection_reason && (
                  <div className="mt-2 rounded-md bg-rose-50 border border-rose-200 p-2 flex gap-2 items-start">
                    <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <div className="text-xs text-rose-700">
                      <span className="font-medium">{t('myUploads.rejectionReason')}: </span>
                      {s.rejection_reason}
                    </div>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => goToSkill(s.slug)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                >
                  <Eye className="w-4 h-4" />
                  {t('myUploads.view')}
                </button>
                <button
                  type="button"
                  onClick={() => triggerReupload(s.slug)}
                  disabled={reupload.isPending}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border border-brand-300 text-brand-700 bg-brand-50 hover:bg-brand-100 disabled:opacity-60"
                >
                  {reupload.isPending && reuploadingSlug === s.slug ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <UploadCloud className="w-4 h-4" />
                  )}
                  {t('myUploads.reupload')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(t('myUploads.confirmDelete', { name: s.name }))) {
                      remove.mutate(s.slug);
                    }
                  }}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border border-rose-200 text-rose-700 bg-white hover:bg-rose-50"
                >
                  <Trash2 className="w-4 h-4" />
                  {t('common.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
