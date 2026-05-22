import { useQuery } from '@tanstack/react-query';
import { Loader2, Users, Shield } from 'lucide-react';
import { api } from '../utils/api';
import { useT } from '../store';

interface UsersResponse {
  users: Array<{
    id: number;
    username: string;
    email: string;
    role: 'admin' | 'user';
    created_at: string;
    skill_count: number;
  }>;
}

export function UsersAdminView() {
  const t = useT();
  const usersQ = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api<UsersResponse>('/admin/users'),
  });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Users className="w-5 h-5" />
          {t('users.title')}
        </h1>
        <p className="text-sm text-slate-500 mt-1">{t('users.subtitle')}</p>
      </header>

      {usersQ.isLoading && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      )}
      {usersQ.error && (
        <div className="rounded-2xl bg-rose-50 border border-rose-200 p-4 text-sm text-rose-700">
          {t('users.failedToLoad')}
        </div>
      )}
      {usersQ.data && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2 font-medium">{t('users.username')}</th>
                <th className="text-left px-4 py-2 font-medium">{t('users.email')}</th>
                <th className="text-left px-4 py-2 font-medium">{t('users.role')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('users.skills')}</th>
                <th className="text-left px-4 py-2 font-medium">{t('users.joined')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {usersQ.data.users.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-2 font-medium">{u.username}</td>
                  <td className="px-4 py-2 text-slate-600">{u.email}</td>
                  <td className="px-4 py-2">
                    {u.role === 'admin' ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-xs">
                        <Shield className="w-3 h-3" />
                        {t('users.adminRole')}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-500">{t('users.userRole')}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{u.skill_count}</td>
                  <td className="px-4 py-2 text-slate-500 text-xs">
                    {new Date(u.created_at + 'Z').toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {usersQ.data.users.length === 0 && (
            <div className="p-8 text-center text-sm text-slate-400">{t('users.empty')}</div>
          )}
        </div>
      )}
    </div>
  );
}
