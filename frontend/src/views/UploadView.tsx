import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload, Loader2, AlertCircle, CheckCircle, FileArchive } from 'lucide-react';
import { api, ApiClientError, getToken } from '../utils/api';
import { useStore, useT } from '../store';
import type { Category, Tag } from '../domain';

interface UploadResult {
  skill: { slug: string; name: string; status: string };
}

interface FieldIssue {
  path: string;
  message: string;
}

async function uploadSkill(form: FormData): Promise<UploadResult> {
  const headers = new Headers();
  const tok = getToken();
  if (tok) headers.set('authorization', `Bearer ${tok}`);
  const res = await fetch('/api/skills', { method: 'POST', headers, body: form });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* keep null */
  }
  if (!res.ok) {
    const payload =
      data && typeof data === 'object' && 'error' in (data as object)
        ? (data as { error: string; code: string; detail?: unknown })
        : { error: `HTTP ${res.status}`, code: 'UNKNOWN' };
    throw new ApiClientError(res.status, payload);
  }
  return data as UploadResult;
}

export function UploadView() {
  const t = useT();
  const qc = useQueryClient();
  const showToast = useStore((s) => s.showToast);
  const goToSkill = useStore((s) => s.goToSkill);
  const setView = useStore((s) => s.setView);
  const user = useStore((s) => s.user);

  const [file, setFile] = useState<File | null>(null);
  const [slug, setSlug] = useState('');
  const [categorySlug, setCategorySlug] = useState('');
  const [tagSlugs, setTagSlugs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<FieldIssue[]>([]);

  const categoriesQ = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<{ categories: Category[] }>('/categories'),
  });
  const tagsQ = useQuery({
    queryKey: ['tags'],
    queryFn: () => api<{ tags: Tag[] }>('/tags'),
  });

  const upload = useMutation({
    mutationFn: uploadSkill,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      qc.invalidateQueries({ queryKey: ['my-uploads'] });
      const isPending = data.skill.status === 'pending';
      showToast(
        isPending
          ? t('upload.submitted', { name: data.skill.name })
          : t('upload.published', { name: data.skill.name }),
        'success',
      );
      goToSkill(data.skill.slug);
    },
    onError: (err) => {
      if (err instanceof ApiClientError) {
        if (err.code === 'INVALID_INPUT' && Array.isArray(err.detail)) {
          setIssues(err.detail as FieldIssue[]);
          setError(t('upload.fixErrors'));
        } else {
          setError(err.message);
        }
      } else {
        setError(t('common.networkError'));
      }
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIssues([]);
    if (!file) {
      setError(t('upload.chooseFile'));
      return;
    }
    const form = new FormData();
    form.append('file', file);
    if (slug.trim()) form.append('slug', slug.trim().toLowerCase());
    if (categorySlug) form.append('categorySlug', categorySlug);
    if (tagSlugs.length) form.append('tagSlugs', JSON.stringify(tagSlugs));
    upload.mutate(form);
  }

  function toggleTag(tag: string) {
    setTagSlugs((cur) => (cur.includes(tag) ? cur.filter((x) => x !== tag) : [...cur, tag]));
  }

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <header>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Upload className="w-5 h-5" />
          {t('upload.title')}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t('upload.subtitle')}{' '}
          {user?.role === 'admin' ? t('upload.adminNote') : t('upload.userNote')}
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5"
      >
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">{t('upload.zipArchive')}</label>
          <label className="block border-2 border-dashed border-slate-300 rounded-xl p-6 text-center cursor-pointer hover:border-brand-300 hover:bg-brand-50/30">
            <FileArchive className="w-8 h-8 mx-auto text-slate-400 mb-2" />
            {file ? (
              <>
                <div className="text-sm font-medium text-slate-700">{file.name}</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {(file.size / 1024).toFixed(1)} KB
                </div>
              </>
            ) : (
              <>
                <div className="text-sm text-slate-600">{t('upload.pickFile')}</div>
                <div className="text-xs text-slate-400 mt-0.5">{t('upload.maxSize')}</div>
              </>
            )}
            <input
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              {t('upload.slug')} <span className="text-slate-400">({t('common.optional')})</span>
            </label>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder={t('upload.slugPlaceholder')}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t('upload.category')}</label>
            <select
              value={categorySlug}
              onChange={(e) => setCategorySlug(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm bg-white focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="">{t('upload.categoryNone')}</option>
              {categoriesQ.data?.categories.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t('upload.tags')}</label>
          {tagsQ.data && tagsQ.data.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {tagsQ.data.tags.map((tg) => (
                <button
                  key={tg.slug}
                  type="button"
                  onClick={() => toggleTag(tg.slug)}
                  className={`text-xs px-2.5 py-1 rounded-full border ${
                    tagSlugs.includes(tg.slug)
                      ? 'bg-brand-50 border-brand-300 text-brand-700'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {tg.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              {t('upload.noTags')} {user?.role === 'admin' && t('upload.adminAddTags')}
            </p>
          )}
        </div>

        {error && (
          <div className="rounded-md bg-rose-50 border border-rose-200 p-3 flex gap-2 items-start">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <div className="text-sm">
              <div className="font-medium text-rose-800">{error}</div>
              {issues.length > 0 && (
                <ul className="mt-1 text-rose-700 list-disc pl-4">
                  {issues.map((i, ix) => (
                    <li key={ix}>
                      {i.path && <code className="font-mono">{i.path}: </code>}
                      {i.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={() => setView('catalog')}
            className="px-3 py-1.5 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={upload.isPending || !file}
            className="inline-flex items-center gap-1.5 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm font-medium rounded-md px-4 py-2"
          >
            {upload.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CheckCircle className="w-4 h-4" />
            )}
            {user?.role === 'admin' ? t('upload.publish') : t('upload.submitForReview')}
          </button>
        </div>
      </form>
    </div>
  );
}
