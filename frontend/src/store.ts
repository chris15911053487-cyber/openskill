import { create } from 'zustand';
import type { AuthResponse, User, ViewName } from './types';
import { api, getToken, setToken, setOnUnauthorized } from './utils/api';
import { getStoredLang, setStoredLang, translate, type Lang, type TranslationKey } from './i18n';

interface AuthSlice {
  user: User | null;
  /** True until the initial /auth/me call completes (or fails). */
  bootstrapping: boolean;
  /** Hydrate auth state on app start: if token exists, fetch /auth/me. */
  hydrate: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => void;
}

interface ViewSlice {
  currentView: ViewName;
  /** Selected skill slug when currentView === 'skill-detail'. */
  selectedSkillSlug: string | null;
  setView: (v: ViewName) => void;
  goToSkill: (slug: string) => void;
}

interface ToastSlice {
  toast: { kind: 'info' | 'success' | 'error'; message: string } | null;
  showToast: (message: string, kind?: 'info' | 'success' | 'error') => void;
  clearToast: () => void;
}

interface I18nSlice {
  lang: Lang;
  setLang: (l: Lang) => void;
}

type Store = AuthSlice & ViewSlice & ToastSlice & I18nSlice;

export const useStore = create<Store>((set, get) => ({
  // ---- Auth ----
  user: null,
  bootstrapping: true,

  hydrate: async () => {
    const tok = getToken();
    if (!tok) {
      set({ bootstrapping: false });
      return;
    }
    try {
      const r = await api<{ user: User }>('/auth/me');
      set({ user: r.user, bootstrapping: false });
    } catch {
      // 401 will already have invoked our onUnauthorized handler below
      set({ bootstrapping: false });
    }
  },

  login: async (username, password) => {
    const r = await api<AuthResponse>('/auth/login', {
      method: 'POST',
      body: { username, password },
      auth: false,
    });
    setToken(r.token);
    set({ user: r.user, currentView: r.user.role === 'admin' ? 'catalog' : 'catalog' });
  },

  register: async (username, email, password) => {
    const r = await api<AuthResponse>('/auth/register', {
      method: 'POST',
      body: { username, email, password },
      auth: false,
    });
    setToken(r.token);
    set({ user: r.user, currentView: 'catalog' });
  },

  logout: () => {
    setToken(null);
    set({ user: null, currentView: 'login' });
  },

  // ---- Views ----
  currentView: 'login',
  selectedSkillSlug: null,
  setView: (v) => set({ currentView: v }),
  goToSkill: (slug) => set({ currentView: 'skill-detail', selectedSkillSlug: slug }),

  // ---- Toast ----
  toast: null,
  showToast: (message, kind = 'info') => {
    set({ toast: { message, kind } });
    // auto-dismiss after 3 seconds
    setTimeout(() => {
      const cur = get().toast;
      if (cur && cur.message === message) set({ toast: null });
    }, 3000);
  },
  clearToast: () => set({ toast: null }),

  // ---- I18n ----
  lang: getStoredLang(),
  setLang: (l) => {
    setStoredLang(l);
    set({ lang: l });
  },
}));

/**
 * Hook returning a `t` function that re-renders when the language changes.
 */
export function useT(): (key: TranslationKey, vars?: Record<string, string | number>) => string {
  const lang = useStore((s) => s.lang);
  return (key, vars) => translate(lang, key, vars);
}

// Connect 401 handler -> auto-logout
setOnUnauthorized(() => {
  useStore.getState().logout();
});
