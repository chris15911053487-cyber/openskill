import { useQuery } from '@tanstack/react-query';
import { Loader2, Package, Download, Users } from 'lucide-react';
import { api } from '../utils/api';
import { useStore, useT } from '../store';
import type { SkillSummary } from '../domain';

interface SubsResponse {
  items: (SkillSummary & { subscribed_at: string })[];
}

export function MySubscriptionsView() {
  const t = useT();
  const goToSkill = useStore((s) => s.goToSkill);
  const subsQ = useQuery({
    queryKey: ['my-subscriptions'],
    queryFn: () => api<SubsResponse>('/me/subscriptions'),
  });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Package className="w-5 h-5" />
          {t('mySubs.title')}
        </h1>
        <p className="text-sm text-slate-500 mt-1">{t('mySubs.subtitle')}</p>
      </header>

      {subsQ.isLoading && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      )}
      {subsQ.error && (
        <div className="rounded-2xl bg-rose-50 border border-rose-200 p-4 text-sm text-rose-700">
          {t('common.failedToLoad')}
        </div>
      )}
      {subsQ.data && subsQ.data.items.length === 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
          <Package className="w-8 h-8 mx-auto text-slate-300" />
          <p className="mt-2 text-sm text-slate-500">{t('mySubs.empty')}</p>
        </div>
      )}
      {subsQ.data && subsQ.data.items.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {subsQ.data.items.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => goToSkill(s.slug)}
              className="text-left bg-white rounded-2xl border border-slate-200 hover:border-brand-300 hover:shadow-sm transition-shadow p-4"
            >
              <div className="flex items-start justify-between gap-3 mb-1">
                <h3 className="text-base font-semibold truncate">{s.name}</h3>
                {s.version && (
                  <span className="text-xs font-mono text-slate-400 shrink-0">v{s.version}</span>
                )}
              </div>
              <p className="text-sm text-slate-600 line-clamp-3 mb-3">{s.description}</p>
              <div className="flex items-center gap-4 text-xs text-slate-500">
                <span className="flex items-center gap-1">
                  <Users className="w-3.5 h-3.5" />
                  {s.subscriber_count}
                </span>
                <span className="flex items-center gap-1">
                  <Download className="w-3.5 h-3.5" />
                  {s.download_count}
                </span>
                <span className="ml-auto">
                  {t('mySubs.subscribedAt')} {new Date(s.subscribed_at + 'Z').toLocaleDateString()}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
