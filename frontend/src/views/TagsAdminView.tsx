import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Loader2, Tag as TagIcon } from 'lucide-react';
import { api, ApiClientError } from '../utils/api';
import { useStore, useT } from '../store';
import type { Tag } from '../domain';

export function TagsAdminView() {
  const t = useT();
  const qc = useQueryClient();
  const showToast = useStore((s) => s.showToast);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');

  const tagsQ = useQuery({
    queryKey: ['tags'],
    queryFn: () => api<{ tags: Tag[] }>('/tags'),
  });

  const create = useMutation({
    mutationFn: (payload: { name: string; slug?: string }) =>
      api<{ tag: Tag }>('/admin/tags', { method: 'POST', body: payload }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tags'] });
      setName('');
      setSlug('');
      showToast(t('tags.created'), 'success');
    },
    onError: (err) => {
      const msg = err instanceof ApiClientError ? err.message : t('tags.createFailed');
      showToast(msg, 'error');
    },
  });

  const remove = useMutation({
    mutationFn: (slugToDelete: string) =>
      api<void>(`/admin/tags/${slugToDelete}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tags'] });
      showToast(t('tags.deleted'), 'success');
    },
    onError: (err) => {
      const msg = err instanceof ApiClientError ? err.message : t('tags.deleteFailed');
      showToast(msg, 'error');
    },
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate({ name: name.trim(), slug: slug.trim() || undefined });
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <TagIcon className="w-5 h-5" />
          {t('tags.title')}
        </h1>
        <p className="text-sm text-slate-500 mt-1">{t('tags.subtitle')}</p>
      </header>

      <form
        onSubmit={handleCreate}
        className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col sm:flex-row gap-3 items-end"
      >
        <div className="flex-1 w-full">
          <label className="block text-sm font-medium text-slate-700 mb-1">{t('tags.name')}</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('tags.namePlaceholder')}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>
        <div className="flex-1 w-full">
          <label className="block text-sm font-medium text-slate-700 mb-1">
            {t('tags.slug')} <span className="text-slate-400">({t('common.optional')})</span>
          </label>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder={t('tags.slugPlaceholder')}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>
        <button
          type="submit"
          disabled={create.isPending || !name.trim()}
          className="inline-flex items-center gap-1.5 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm font-medium rounded-md px-4 py-2 transition-colors"
        >
          {create.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {t('tags.add')}
        </button>
      </form>

      <div className="bg-white rounded-2xl border border-slate-200">
        {tagsQ.isLoading && (
          <div className="p-8 text-center text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin mx-auto" />
          </div>
        )}
        {tagsQ.error && (
          <div className="p-4 text-sm text-rose-700 bg-rose-50 rounded-2xl">
            {t('tags.failedToLoad')}
          </div>
        )}
        {tagsQ.data && (
          <ul className="divide-y divide-slate-100">
            {tagsQ.data.tags.length === 0 && (
              <li className="p-8 text-center text-sm text-slate-400">{t('tags.empty')}</li>
            )}
            {tagsQ.data.tags.map((tag) => (
              <li key={tag.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1">
                  <div className="text-sm font-medium">{tag.name}</div>
                  <div className="text-xs text-slate-500">
                    <code className="text-slate-600">{tag.slug}</code>
                    {' · '}
                    {tag.skill_count ?? 0} {t('tags.publishedSkills')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(t('tags.confirmDelete', { name: tag.name }))) {
                      remove.mutate(tag.slug);
                    }
                  }}
                  title={t('common.delete')}
                  className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
