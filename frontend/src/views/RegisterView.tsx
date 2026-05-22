import { useState, type FormEvent } from 'react';
import { Sparkles, Languages } from 'lucide-react';
import { useStore, useT } from '../store';
import { ApiClientError } from '../utils/api';

interface FieldIssue {
  path: string;
  message: string;
}

export function RegisterView() {
  const t = useT();
  const register = useStore((s) => s.register);
  const setView = useStore((s) => s.setView);
  const lang = useStore((s) => s.lang);
  const setLang = useStore((s) => s.setLang);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIssues({});
    setLoading(true);
    try {
      await register(username.trim(), email.trim(), password);
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === 'INVALID_INPUT' && Array.isArray(err.detail)) {
          const map: Record<string, string> = {};
          for (const it of err.detail as FieldIssue[]) map[it.path] = it.message;
          setIssues(map);
        } else {
          setError(err.message);
        }
      } else {
        setError(t('common.networkError'));
      }
    } finally {
      setLoading(false);
    }
  }

  function fieldError(name: string) {
    return issues[name] ? (
      <p className="mt-1 text-xs text-rose-600">{issues[name]}</p>
    ) : null;
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
              <h1 className="text-xl font-semibold">{t('auth.createYourAccount')}</h1>
              <p className="text-xs text-slate-500">{t('auth.joinTagline')}</p>
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
              {t('auth.username')}
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
            {fieldError('username') ?? (
              <p className="mt-1 text-xs text-slate-500">{t('auth.usernameHint')}</p>
            )}
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1">
              {t('auth.email')}
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            {fieldError('email')}
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1">
              {t('auth.password')}
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            {fieldError('password') ?? (
              <p className="mt-1 text-xs text-slate-500">{t('auth.passwordHint')}</p>
            )}
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
            {loading ? t('auth.creatingAccount') : t('auth.createAccount')}
          </button>

          <div className="text-center text-xs text-slate-500">
            {t('auth.haveAccount')}{' '}
            <button
              type="button"
              onClick={() => setView('login')}
              className="text-brand-600 hover:underline"
            >
              {t('auth.signIn')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
