import { useQuery } from '@tanstack/react-query';
import {
  Loader2,
  Users,
  Package,
  Download,
  Star,
  Folder,
  Tag,
  ShieldCheck,
  Inbox,
  XCircle,
  BarChart3,
  Clock,
} from 'lucide-react';
import { api } from '../utils/api';
import { useStore, useT } from '../store';
import type { TranslationKey } from '../i18n';

interface StatsResponse {
  totals: {
    users: number;
    admins: number;
    skills_total: number;
    skills_published: number;
    skills_pending: number;
    skills_rejected: number;
    total_downloads: number;
    total_subscriptions: number;
    categories: number;
    tags: number;
  };
  topSubscribed: Array<{
    slug: string;
    name: string;
    subscriber_count: number;
    download_count: number;
  }>;
  topDownloaded: Array<{
    slug: string;
    name: string;
    subscriber_count: number;
    download_count: number;
  }>;
  recentUploads: Array<{
    slug: string;
    name: string;
    status: 'published' | 'pending' | 'rejected';
    created_at: string;
    author_username: string;
  }>;
}

const STATUS_KEYS: Record<'published' | 'pending' | 'rejected', TranslationKey> = {
  published: 'skill.status.published',
  pending: 'skill.status.pending',
  rejected: 'skill.status.rejected',
};

export function StatsView() {
  const t = useT();
  const goToSkill = useStore((s) => s.goToSkill);
  const statsQ = useQuery({
    queryKey: ['admin-stats'],
    queryFn: () => api<StatsResponse>('/admin/stats'),
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <BarChart3 className="w-5 h-5" />
          {t('stats.title')}
        </h1>
        <p className="text-sm text-slate-500 mt-1">{t('stats.subtitle')}</p>
      </header>

      {statsQ.isLoading && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      )}
      {statsQ.error && (
        <div className="rounded-2xl bg-rose-50 border border-rose-200 p-4 text-sm text-rose-700">
          {t('stats.failedToLoad')}
        </div>
      )}

      {statsQ.data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
            <StatCard
              icon={<Users className="w-4 h-4" />}
              label={t('stats.users')}
              value={statsQ.data.totals.users}
              hint={t(
                statsQ.data.totals.admins === 1 ? 'stats.adminsHint' : 'stats.adminsHintPlural',
                { count: statsQ.data.totals.admins },
              )}
            />
            <StatCard
              icon={<Package className="w-4 h-4" />}
              label={t('stats.skills')}
              value={statsQ.data.totals.skills_total}
              hint={t('stats.publishedHint', { count: statsQ.data.totals.skills_published })}
            />
            <StatCard
              icon={<Download className="w-4 h-4" />}
              label={t('stats.downloads')}
              value={statsQ.data.totals.total_downloads}
            />
            <StatCard
              icon={<Star className="w-4 h-4" />}
              label={t('stats.subscriptions')}
              value={statsQ.data.totals.total_subscriptions}
            />
            <StatCard
              icon={<Inbox className="w-4 h-4" />}
              label={t('stats.pending')}
              value={statsQ.data.totals.skills_pending}
              tone={statsQ.data.totals.skills_pending > 0 ? 'amber' : 'default'}
            />
            <StatCard
              icon={<XCircle className="w-4 h-4" />}
              label={t('stats.rejected')}
              value={statsQ.data.totals.skills_rejected}
              tone={statsQ.data.totals.skills_rejected > 0 ? 'rose' : 'default'}
            />
            <StatCard
              icon={<ShieldCheck className="w-4 h-4" />}
              label={t('stats.published')}
              value={statsQ.data.totals.skills_published}
              tone="emerald"
            />
            <StatCard
              icon={<Folder className="w-4 h-4" />}
              label={t('stats.categories')}
              value={statsQ.data.totals.categories}
            />
            <StatCard
              icon={<Tag className="w-4 h-4" />}
              label={t('stats.tags')}
              value={statsQ.data.totals.tags}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TopList
              title={t('stats.topSubscribed')}
              icon={<Star className="w-4 h-4 text-amber-500" />}
              metric="subscriber_count"
              metricLabel={t('stats.subsAbbrev')}
              items={statsQ.data.topSubscribed}
              onPick={goToSkill}
            />
            <TopList
              title={t('stats.topDownloaded')}
              icon={<Download className="w-4 h-4 text-brand-600" />}
              metric="download_count"
              metricLabel={t('stats.dlAbbrev')}
              items={statsQ.data.topDownloaded}
              onPick={goToSkill}
            />
          </div>

          <div className="bg-white rounded-2xl border border-slate-200">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
              <Clock className="w-4 h-4 text-slate-500" />
              <h3 className="text-sm font-semibold">{t('stats.recentSkills')}</h3>
            </div>
            {statsQ.data.recentUploads.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-400">{t('stats.noUploads')}</div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {statsQ.data.recentUploads.map((s) => (
                  <li key={s.slug} className="px-4 py-2 flex items-center gap-3 text-sm">
                    <button
                      type="button"
                      onClick={() => goToSkill(s.slug)}
                      className="text-left flex-1 min-w-0"
                    >
                      <div className="font-medium truncate">{s.name}</div>
                      <div className="text-xs text-slate-500 truncate">
                        {t('stats.by')} {s.author_username} · {new Date(s.created_at + 'Z').toLocaleString()}
                      </div>
                    </button>
                    <StatusPill status={s.status} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
  tone = 'default',
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  hint?: string;
  tone?: 'default' | 'emerald' | 'amber' | 'rose';
}) {
  const toneClasses = {
    default: 'bg-white border-slate-200',
    emerald: 'bg-emerald-50 border-emerald-200',
    amber: 'bg-amber-50 border-amber-200',
    rose: 'bg-rose-50 border-rose-200',
  } as const;
  return (
    <div className={`rounded-2xl border p-4 ${toneClasses[tone]}`}>
      <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-1">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</div>
      {hint && <div className="text-xs text-slate-500 mt-0.5">{hint}</div>}
    </div>
  );
}

function TopList({
  title,
  icon,
  items,
  metric,
  metricLabel,
  onPick,
}: {
  title: string;
  icon: React.ReactNode;
  items: Array<{ slug: string; name: string; subscriber_count: number; download_count: number }>;
  metric: 'subscriber_count' | 'download_count';
  metricLabel: string;
  onPick: (slug: string) => void;
}) {
  const t = useT();
  return (
    <div className="bg-white rounded-2xl border border-slate-200">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {items.length === 0 ? (
        <div className="p-8 text-center text-sm text-slate-400">{t('stats.empty')}</div>
      ) : (
        <ol className="divide-y divide-slate-100">
          {items.map((s, i) => (
            <li key={s.slug} className="px-4 py-2 flex items-center gap-3 text-sm">
              <span className="w-5 text-slate-400 tabular-nums text-right">{i + 1}</span>
              <button
                type="button"
                onClick={() => onPick(s.slug)}
                className="text-left flex-1 truncate hover:underline"
              >
                {s.name}
              </button>
              <span className="text-slate-700 tabular-nums">
                {s[metric].toLocaleString()}
                <span className="text-slate-400 text-xs ml-1">{metricLabel}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: 'published' | 'pending' | 'rejected' }) {
  const t = useT();
  const styles = {
    published: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    rejected: 'bg-rose-50 text-rose-700 border-rose-200',
  } as const;
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border ${styles[status]}`}>
      {t(STATUS_KEYS[status])}
    </span>
  );
}
