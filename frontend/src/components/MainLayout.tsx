import type { ReactNode } from 'react';
import { LogOut, Sparkles, Shield, Languages } from 'lucide-react';
import { useStore, useT } from '../store';
import type { ViewName } from '../types';
import type { TranslationKey } from '../i18n';

interface NavItem {
  id: ViewName;
  labelKey: TranslationKey;
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'catalog', labelKey: 'nav.catalog' },
  { id: 'chat', labelKey: 'nav.chat' },
  { id: 'my-subscriptions', labelKey: 'nav.mySkills' },
  { id: 'upload', labelKey: 'nav.upload' },
  { id: 'my-uploads', labelKey: 'nav.myUploads' },
  { id: 'admin-review', labelKey: 'nav.reviewQueue', adminOnly: true },
  { id: 'admin-categories', labelKey: 'nav.categories', adminOnly: true },
  { id: 'admin-tags', labelKey: 'nav.tags', adminOnly: true },
  { id: 'admin-users', labelKey: 'nav.users', adminOnly: true },
  { id: 'admin-stats', labelKey: 'nav.stats', adminOnly: true },
];

export function MainLayout({ children }: { children: ReactNode }) {
  const t = useT();
  const user = useStore((s) => s.user);
  const currentView = useStore((s) => s.currentView);
  const setView = useStore((s) => s.setView);
  const logout = useStore((s) => s.logout);
  const lang = useStore((s) => s.lang);
  const setLang = useStore((s) => s.setLang);

  const items = NAV_ITEMS.filter((i) => !i.adminOnly || user?.role === 'admin');

  return (
    <div className="min-h-full flex flex-col bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 flex h-14 items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => setView('catalog')}
            className="flex items-center gap-2 text-left"
          >
            <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold">OpenSkill</span>
          </button>

          <nav className="hidden md:flex items-center gap-1 flex-1 justify-center">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setView(item.id)}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                  currentView === item.id ||
                  (item.id === 'catalog' && currentView === 'skill-detail')
                    ? 'bg-brand-50 text-brand-700 font-medium'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            {/* Language switcher */}
            <button
              type="button"
              onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
              title={t('nav.language')}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100"
            >
              <Languages className="w-3.5 h-3.5" />
              {lang === 'en' ? '中文' : 'EN'}
            </button>

            {user && (
              <div className="flex items-center gap-2 text-sm">
                {user.role === 'admin' && (
                  <span
                    title={t('nav.admin')}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-xs"
                  >
                    <Shield className="w-3 h-3" />
                    {t('nav.admin')}
                  </span>
                )}
                <span className="text-slate-700">{user.username}</span>
                <button
                  type="button"
                  onClick={logout}
                  title={t('nav.signOut')}
                  className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Mobile nav */}
        <nav className="md:hidden flex overflow-x-auto px-2 pb-2 gap-1">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
              className={`whitespace-nowrap px-3 py-1.5 text-sm rounded-md ${
                currentView === item.id
                  ? 'bg-brand-50 text-brand-700 font-medium'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </nav>
      </header>

      <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-6">{children}</main>
    </div>
  );
}
