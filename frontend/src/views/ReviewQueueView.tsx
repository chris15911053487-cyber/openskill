import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Loader2,
  CheckCircle,
  XCircle,
  Eye,
  Inbox,
  X,
  Send,
} from 'lucide-react';
import { api, ApiClientError } from '../utils/api';
import { useStore, useT } from '../store';
import type { SkillListResponse, SkillSummary } from '../domain';

export function ReviewQueueView() {
  const t = useT();
  const goToSkill = useStore((s) => s.goToSkill);
  const showToast = useStore((s) => s.showToast);
  const qc = useQueryClient();

  const [rejectingSlug, setRejectingSlug] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const pendingQ = useQuery({
    queryKey: ['admin-review-pending'],
    queryFn: () => api<SkillListResponse>('/skills?status=pending&limit=50'),
  });

  const approve = useMutation({
    mutationFn: (slug: string) =>
      api<{ skill: SkillSummary }>(`/admin/skills/${slug}/approve`, { method: 'POST' }),
    onSuccess: (data) => {
      showToast(t('review.approved', { name: data.skill.name }), 'success');
      qc.invalidateQueries({ queryKey: ['admin-review-pending'] });
      qc.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (err) => {
      const msg = err instanceof ApiClientError ? err.message : t('review.approveFailed');
      showToast(msg, 'error');
    },
  });

  const reject = useMutation({
    mutationFn: ({ slug, reason }: { slug: string; reason: string }) =>
      api<{ skill: SkillSummary }>(`/admin/skills/${slug}/reject`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: (data) => {
      showToast(t('review.rejected', { name: data.skill.name }), 'info');
      qc.invalidateQueries({ queryKey: ['admin-review-pending'] });
      setRejectingSlug(null);
      setRejectReason('');
    },
    onError: (err) => {
      const msg = err instanceof ApiClientError ? err.message : t('review.rejectFailed');
      showToast(msg, 'error');
    },
  });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Inbox className="w-5 h-5" />
          {t('review.title')}
        </h1>
        <p className="text-sm text-slate-500 mt-1">{t('review.subtitle')}</p>
      </header>

      {pendingQ.isLoading && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      )}
      {pendingQ.error && (
        <div className="rounded-2xl bg-rose-50 border border-rose-200 p-4 text-sm text-rose-700">
          {t('review.failedToLoad')}
        </div>
      )}
      {pendingQ.data && pendingQ.data.items.length === 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
          <CheckCircle className="w-8 h-8 mx-auto text-emerald-300" />
          <p className="mt-2 text-sm text-slate-500">{t('review.empty')}</p>
        </div>
      )}

      {pendingQ.data && pendingQ.data.items.length > 0 && (
        <ul className="space-y-3">
          {pendingQ.data.items.map((s) => (
            <li
              key={s.id}
              className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h3 className="text-base font-semibold truncate">{s.name}</h3>
                  {s.version && (
                    <span className="text-xs font-mono text-slate-400">v{s.version}</span>
                  )}
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                    {t('skill.status.pending')}
                  </span>
                </div>
                <p className="text-sm text-slate-600 line-clamp-2">{s.description}</p>
                <div className="mt-1 text-xs text-slate-400">
                  {t('review.submittedBy')} <span className="text-slate-600">{s.author_username}</span>
                  {' · '}
                  {t('review.submittedAt')} {new Date(s.created_at + 'Z').toLocaleString()}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => goToSkill(s.slug)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                >
                  <Eye className="w-4 h-4" />
                  {t('review.inspect')}
                </button>
                <button
                  type="button"
                  onClick={() => setRejectingSlug(s.slug)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border border-rose-200 text-rose-700 bg-white hover:bg-rose-50"
                >
                  <XCircle className="w-4 h-4" />
                  {t('review.reject')}
                </button>
                <button
                  type="button"
                  onClick={() => approve.mutate(s.slug)}
                  disabled={approve.isPending}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60"
                >
                  {approve.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <CheckCircle className="w-4 h-4" />
                  )}
                  {t('review.approve')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {rejectingSlug && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-md p-5">
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-base font-semibold">
                {t('review.rejectTitle', { slug: rejectingSlug })}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setRejectingSlug(null);
                  setRejectReason('');
                }}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-slate-500 mb-3">{t('review.rejectHelp')}</p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={4}
              placeholder={t('review.rejectPlaceholder')}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => {
                  setRejectingSlug(null);
                  setRejectReason('');
                }}
                className="px-3 py-1.5 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={!rejectReason.trim() || reject.isPending}
                onClick={() =>
                  reject.mutate({ slug: rejectingSlug, reason: rejectReason.trim() })
                }
                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-rose-600 hover:bg-rose-700 text-white disabled:opacity-60"
              >
                {reject.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
                {t('review.sendRejection')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
