import { useEffect } from 'react';
import { useStore } from '../store';

export function Toast() {
  const toast = useStore((s) => s.toast);
  const clear = useStore((s) => s.clearToast);

  useEffect(() => {
    if (!toast) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toast, clear]);

  if (!toast) return null;

  const styles =
    toast.kind === 'error'
      ? 'bg-rose-50 border-rose-200 text-rose-800'
      : toast.kind === 'success'
        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
        : 'bg-slate-50 border-slate-200 text-slate-800';

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed top-4 right-4 z-50 max-w-sm rounded-lg border px-4 py-2 shadow-lg ${styles}`}
    >
      <div className="text-sm">{toast.message}</div>
    </div>
  );
}
