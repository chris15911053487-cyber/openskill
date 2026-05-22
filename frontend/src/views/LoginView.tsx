import { useState, type FormEvent } from 'react';
import { Sparkles, Languages } from 'lucide-react';
import { useStore, useT } from '../store';
import { ApiClientError } from '../utils/api';

export function LoginView() {
  const t = useT();
  const login = useStore((s) => s.login);
  const setView = useStore((s) => s.setView);
  const lang = useStore((s) => s.lang);
  const setLang = useStore((s) => s.setLang);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError(t('common.networkError'));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-600 flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">OpenSkill</h1>
              <p className="text-xs text-slate-500">{t('auth.signInToAccount')}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
            title={t('nav.language')}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100"
          >
            <Languages className="w-3.5 h-3.5" />
            {lang === 'en' ? '中文' : 'EN'}
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4 shadow-sm"
        >
          <div>
            <label htmlFor="username" className="block text-sm font-medium text-slate-700 mb-1">
              {t('auth.usernameOrEmail')}
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1">
              {t('auth.password')}
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-800"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm font-medium rounded-md py-2 transition-colors"
          >
            {loading ? t('auth.signingIn') : t('auth.signIn')}
          </button>

          <div className="text-center text-xs text-slate-500">
            {t('auth.noAccount')}{' '}
            <button
              type="button"
              onClick={() => setView('register')}
              className="text-brand-600 hover:underline"
            >
              {t('auth.createOne')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
