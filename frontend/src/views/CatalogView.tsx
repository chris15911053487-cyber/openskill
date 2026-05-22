import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Loader2, Download, Users, Package } from 'lucide-react';
import { api } from '../utils/api';
import { useStore, useT } from '../store';
import type { TranslationKey } from '../i18n';
import type {
  Category,
  SkillListResponse,
  SkillSummary,
  SortKey,
  Tag,
} from '../domain';

const SORT_OPTIONS: { key: SortKey; labelKey: TranslationKey }[] = [
  { key: 'newest', labelKey: 'catalog.sort.newest' },
  { key: 'popular', labelKey: 'catalog.sort.popular' },
  { key: 'downloads', labelKey: 'catalog.sort.downloads' },
  { key: 'name', labelKey: 'catalog.sort.name' },
];

function buildQuery(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export function CatalogView() {
  const t = useT();
  const goToSkill = useStore((s) => s.goToSkill);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');
  const [page, setPage] = useState(1);

  const limit = 20;

  const categoriesQ = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<{ categories: Category[] }>('/categories'),
  });
  const tagsQ = useQuery({
    queryKey: ['tags'],
    queryFn: () => api<{ tags: Tag[] }>('/tags'),
  });
  const skillsQ = useQuery({
    queryKey: ['skills', { q, category, tag, sort, page, limit }],
    queryFn: () =>
      api<SkillListResponse>(
        '/skills' + buildQuery({ q, category, tag, sort, page, limit }),
      ),
  });

  function handleFilterChange(setter: (v: string) => void) {
    return (e: React.ChangeEvent<HTMLSelectElement>) => {
      setter(e.target.value);
      setPage(1);
    };
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Package className="w-5 h-5" />
            {t('catalog.title')}
          </h1>
          <p className="text-sm text-slate-500 mt-1">{t('catalog.subtitle')}</p>
        </div>
      </header>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="md:col-span-2 relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder={t('catalog.searchPlaceholder')}
            className="w-full pl-9 pr-3 py-2 rounded-md border border-slate-300 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>

        <select
          value={category}
          onChange={handleFilterChange(setCategory)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm bg-white focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">{t('catalog.allCategories')}</option>
          {categoriesQ.data?.categories.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name} ({c.skill_count ?? 0})
            </option>
          ))}
        </select>

        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as SortKey);
            setPage(1);
          }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm bg-white focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {t(o.labelKey)}
            </option>
          ))}
        </select>

        {tagsQ.data && tagsQ.data.tags.length > 0 && (
          <div className="md:col-span-4 flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setTag('');
                setPage(1);
              }}
              className={`text-xs px-2.5 py-1 rounded-full border ${
                tag === ''
                  ? 'bg-brand-50 border-brand-300 text-brand-700'
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {t('catalog.allTags')}
            </button>
            {tagsQ.data.tags.map((tg) => (
              <button
                key={tg.slug}
                type="button"
                onClick={() => {
                  setTag(tg.slug === tag ? '' : tg.slug);
                  setPage(1);
                }}
                className={`text-xs px-2.5 py-1 rounded-full border ${
                  tag === tg.slug
                    ? 'bg-brand-50 border-brand-300 text-brand-700'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {tg.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Results */}
      {skillsQ.isLoading && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      )}
      {skillsQ.error && (
        <div className="rounded-2xl bg-rose-50 border border-rose-200 p-4 text-sm text-rose-700">
          {t('catalog.failedToLoad')}
        </div>
      )}
      {skillsQ.data && skillsQ.data.items.length === 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
          <Package className="w-8 h-8 mx-auto text-slate-300" />
          <p className="mt-2 text-sm text-slate-500">{t('catalog.noMatch')}</p>
        </div>
      )}

      {skillsQ.data && skillsQ.data.items.length > 0 && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {skillsQ.data.items.map((s) => (
              <SkillCard key={s.id} skill={s} onOpen={() => goToSkill(s.slug)} />
            ))}
          </div>

          <Pagination
            page={skillsQ.data.page}
            pages={skillsQ.data.pages}
            total={skillsQ.data.total}
            onChange={setPage}
          />
        </>
      )}
    </div>
  );
}

function SkillCard({ skill, onOpen }: { skill: SkillSummary; onOpen: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group text-left bg-white rounded-2xl border border-slate-200 hover:border-brand-300 hover:shadow-sm transition-shadow p-4"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="text-base font-semibold group-hover:text-brand-700 truncate">
          {skill.name}
        </h3>
        {skill.version && (
          <span className="text-xs font-mono text-slate-400 shrink-0">v{skill.version}</span>
        )}
      </div>
      <p className="text-sm text-slate-600 line-clamp-3 mb-3">{skill.description}</p>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {skill.category_slug && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">
            {skill.category_name}
          </span>
        )}
        {skill.tags.slice(0, 3).map((tg) => (
          <span
            key={tg.slug}
            className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700"
          >
            {tg.name}
          </span>
        ))}
        {skill.tags.length > 3 && (
          <span className="text-xs text-slate-400">+{skill.tags.length - 3}</span>
        )}
      </div>

      <div className="flex items-center gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1">
          <Users className="w-3.5 h-3.5" />
          {skill.subscriber_count}
        </span>
        <span className="flex items-center gap-1">
          <Download className="w-3.5 h-3.5" />
          {skill.download_count}
        </span>
        <span className="ml-auto">{t('catalog.by')} {skill.author_username}</span>
      </div>
    </button>
  );
}

function Pagination({
  page,
  pages,
  total,
  onChange,
}: {
  page: number;
  pages: number;
  total: number;
  onChange: (n: number) => void;
}) {
  const t = useT();
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-slate-500">
        {t('catalog.pageInfo', { page, pages, total })}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="px-3 py-1.5 text-sm rounded-md border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40"
        >
          {t('common.previous')}
        </button>
        <button
          type="button"
          onClick={() => onChange(Math.min(pages, page + 1))}
          disabled={page >= pages}
          className="px-3 py-1.5 text-sm rounded-md border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40"
        >
          {t('common.next')}
        </button>
      </div>
    </div>
  );
}
