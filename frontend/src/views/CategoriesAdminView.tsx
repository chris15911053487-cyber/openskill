import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Pencil, Loader2, Folder, X, Check } from 'lucide-react';
import { api, ApiClientError } from '../utils/api';
import { useStore, useT } from '../store';
import type { Category } from '../domain';

export function CategoriesAdminView() {
  const t = useT();
  const qc = useQueryClient();
  const showToast = useStore((s) => s.showToast);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  const categoriesQ = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<{ categories: Category[] }>('/categories'),
  });

  const create = useMutation({
    mutationFn: (payload: { name: string; slug?: string; description?: string }) =>
      api<{ category: Category }>('/admin/categories', { method: 'POST', body: payload }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      setName('');
      setSlug('');
      setDescription('');
      showToast(t('categories.created'), 'success');
    },
    onError: (err) => {
      const msg = err instanceof ApiClientError ? err.message : t('categories.createFailed');
      showToast(msg, 'error');
    },
  });

  const patch = useMutation({
    mutationFn: ({ slug: s, body }: { slug: string; body: Record<string, unknown> }) =>
      api<{ category: Category }>(`/admin/categories/${s}`, { method: 'PATCH', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      setEditingSlug(null);
      showToast(t('categories.updated'), 'success');
    },
    onError: (err) => {
      const msg = err instanceof ApiClientError ? err.message : t('categories.updateFailed');
      showToast(msg, 'error');
    },
  });

  const remove = useMutation({
    mutationFn: (s: string) => api<void>(`/admin/categories/${s}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      showToast(t('categories.deleted'), 'success');
    },
    onError: (err) => {
      const msg = err instanceof ApiClientError ? err.message : t('categories.deleteFailed');
      showToast(msg, 'error');
    },
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate({
      name: name.trim(),
      slug: slug.trim() || undefined,
      description: description.trim() || undefined,
    });
  }

  function startEdit(c: Category) {
    setEditingSlug(c.slug);
    setEditName(c.name);
    setEditDescription(c.description ?? '');
  }

  function saveEdit(c: Category) {
    patch.mutate({
      slug: c.slug,
      body: {
        name: editName.trim() !== c.name ? editName.trim() : undefined,
        description: editDescription.trim() !== (c.description ?? '') ? editDescription.trim() : undefined,
      },
    });
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Folder className="w-5 h-5" />
          {t('categories.title')}
        </h1>
        <p className="text-sm text-slate-500 mt-1">{t('categories.subtitle')}</p>
      </header>

      <form
        onSubmit={handleCreate}
        className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t('categories.name')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('categories.namePlaceholder')}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              {t('categories.slug')} <span className="text-slate-400">({t('common.optional')})</span>
            </label>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder={t('categories.slugPlaceholder')}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            {t('categories.description')} <span className="text-slate-400">({t('common.optional')})</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={create.isPending || !name.trim()}
            className="inline-flex items-center gap-1.5 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm font-medium rounded-md px-4 py-2 transition-colors"
          >
            {create.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {t('categories.add')}
          </button>
        </div>
      </form>

      <div className="bg-white rounded-2xl border border-slate-200">
        {categoriesQ.isLoading && (
          <div className="p-8 text-center text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin mx-auto" />
          </div>
        )}
        {categoriesQ.error && (
          <div className="p-4 text-sm text-rose-700 bg-rose-50 rounded-2xl">
            {t('categories.failedToLoad')}
          </div>
        )}
        {categoriesQ.data && (
          <ul className="divide-y divide-slate-100">
            {categoriesQ.data.categories.length === 0 && (
              <li className="p-8 text-center text-sm text-slate-400">
                {t('categories.empty')}
              </li>
            )}
            {categoriesQ.data.categories.map((c) => (
              <li key={c.id} className="px-4 py-3">
                {editingSlug === c.slug ? (
                  <div className="space-y-2">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                    />
                    <textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      rows={2}
                      className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => setEditingSlug(null)}
                        className="inline-flex items-center gap-1 px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 rounded-md"
                      >
                        <X className="w-4 h-4" /> {t('common.cancel')}
                      </button>
                      <button
                        type="button"
                        onClick={() => saveEdit(c)}
                        disabled={patch.isPending}
                        className="inline-flex items-center gap-1 px-3 py-1 text-sm text-white bg-brand-600 hover:bg-brand-700 rounded-md disabled:opacity-60"
                      >
                        {patch.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                        {t('common.save')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{c.name}</div>
                      <div className="text-xs text-slate-500">
                        <code className="text-slate-600">{c.slug}</code>
                        {' · '}
                        {c.skill_count ?? 0} {t('categories.publishedSkills')}
                      </div>
                      {c.description && (
                        <div className="text-sm text-slate-600 mt-1">{c.description}</div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => startEdit(c)}
                      title={t('common.edit')}
                      className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(t('categories.confirmDelete', { name: c.name }))) {
                          remove.mutate(c.slug);
                        }
                      }}
                      title={t('common.delete')}
                      className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
