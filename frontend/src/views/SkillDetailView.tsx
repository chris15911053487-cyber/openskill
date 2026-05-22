import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Loader2,
  Download,
  Star,
  StarOff,
  Calendar,
  User,
  Folder,
  Hash,
  AlertCircle,
  Check,
  Copy,
  FileCode,
  Eye,
  Files,
  Info,
  Play,
} from 'lucide-react';
import { api, ApiClientError, downloadFile, postAndDownload } from '../utils/api';
import { useStore, useT } from '../store';
import type { TranslationKey } from '../i18n';
import { SkillMarkdown } from '../components/SkillMarkdown';
import { FileTree, type FileTreeEntry } from '../components/FileTree';
import type { SkillDetail } from '../domain';

interface DetailResponse {
  skill: SkillDetail;
}

interface PreviewResponse {
  slug: string;
  skill_md: string | null;
  frontmatter: Record<string, unknown> | null;
  manifest: Record<string, unknown> | null;
  file_tree: FileTreeEntry[];
}

type Tab = 'overview' | 'preview' | 'files' | 'manifest' | 'run';

const STATUS_KEYS: Record<SkillDetail['status'], TranslationKey> = {
  published: 'skill.status.published',
  pending: 'skill.status.pending',
  rejected: 'skill.status.rejected',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ status }: { status: SkillDetail['status'] }) {
  const t = useT();
  const styles = {
    published: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    rejected: 'bg-rose-50 text-rose-700 border-rose-200',
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs ${styles[status]}`}
    >
      {t(STATUS_KEYS[status])}
    </span>
  );
}

export function SkillDetailView() {
  const t = useT();
  const slug = useStore((s) => s.selectedSkillSlug);
  const setView = useStore((s) => s.setView);
  const user = useStore((s) => s.user);
  const [tab, setTab] = useState<Tab>('overview');

  const skillQ = useQuery({
    queryKey: ['skill', slug],
    queryFn: () => api<DetailResponse>(`/skills/${slug}`),
    enabled: !!slug,
  });

  const previewQ = useQuery({
    queryKey: ['skill-preview', slug],
    queryFn: () => api<PreviewResponse>(`/skills/${slug}/preview`),
    // Load preview eagerly so we can determine whether the skill is runnable
    // (and decide whether to show the Run tab) without waiting for a click.
    enabled: !!slug,
  });

  if (!slug) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-500">
        {t('skill.notFound')}
      </div>
    );
  }

  const skill = skillQ.data?.skill;
  const canViewAuthorTools =
    !!skill && (user?.id === skill.author_id || user?.role === 'admin');

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => setView('catalog')}
        className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
      >
        <ArrowLeft className="w-4 h-4" />
        {t('skill.backToCatalog')}
      </button>

      {skillQ.isLoading && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      )}

      {skillQ.error && (
        <div className="rounded-2xl bg-rose-50 border border-rose-200 p-4 text-sm text-rose-700">
          {t('skill.notFoundOrNoAccess')}
        </div>
      )}

      {skill && (
        <>
          <SkillHeader skill={skill} canViewAuthorTools={canViewAuthorTools} />

          {/* Tabs */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="flex border-b border-slate-200 overflow-x-auto">
              <TabButton active={tab === 'overview'} onClick={() => setTab('overview')} icon={<Info className="w-4 h-4" />}>
                {t('skill.tab.overview')}
              </TabButton>
              <TabButton active={tab === 'preview'} onClick={() => setTab('preview')} icon={<Eye className="w-4 h-4" />}>
                {t('skill.tab.preview')}
              </TabButton>
              <TabButton active={tab === 'files'} onClick={() => setTab('files')} icon={<Files className="w-4 h-4" />}>
                {t('skill.tab.files')}
              </TabButton>
              <TabButton active={tab === 'manifest'} onClick={() => setTab('manifest')} icon={<FileCode className="w-4 h-4" />}>
                {t('skill.tab.manifest')}
              </TabButton>
              {isSkillRunnable(previewQ.data) && (
                <TabButton active={tab === 'run'} onClick={() => setTab('run')} icon={<Play className="w-4 h-4" />}>
                  {t('skill.tab.run')}
                </TabButton>
              )}
            </div>
            <div className="p-6">
              {tab === 'overview' && <OverviewTab skill={skill} />}
              {tab === 'preview' && <PreviewTab previewQ={previewQ} />}
              {tab === 'files' && <FilesTab previewQ={previewQ} />}
              {tab === 'manifest' && <ManifestTab previewQ={previewQ} />}
              {tab === 'run' && <RunTab skill={skill} previewQ={previewQ} />}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
        active
          ? 'text-brand-700 border-b-2 border-brand-600 bg-brand-50/40'
          : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function SkillHeader({
  skill,
  canViewAuthorTools,
}: {
  skill: SkillDetail;
  canViewAuthorTools: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const showToast = useStore((s) => s.showToast);
  const user = useStore((s) => s.user);

  const subQ = useQuery({
    queryKey: ['skill-sub', skill.slug],
    queryFn: () => api<{ subscribed: boolean }>(`/skills/${skill.slug}/subscription`),
    enabled: !!user && skill.status === 'published',
  });

  const subscribe = useMutation({
    mutationFn: () =>
      api<{ subscribed: boolean }>(`/skills/${skill.slug}/subscribe`, { method: 'POST' }),
    onSuccess: () => {
      showToast(t('skill.subscribedToast', { name: skill.name }), 'success');
      qc.invalidateQueries({ queryKey: ['skill-sub', skill.slug] });
      qc.invalidateQueries({ queryKey: ['skill', skill.slug] });
      qc.invalidateQueries({ queryKey: ['skills'] });
      qc.invalidateQueries({ queryKey: ['my-subscriptions'] });
    },
    onError: (err) => {
      const msg = err instanceof ApiClientError ? err.message : t('skill.subscribeFailed');
      showToast(msg, 'error');
    },
  });

  const unsubscribe = useMutation({
    mutationFn: () =>
      api<void>(`/skills/${skill.slug}/subscribe`, { method: 'DELETE' }),
    onSuccess: () => {
      showToast(t('skill.unsubscribedToast', { name: skill.name }), 'info');
      qc.invalidateQueries({ queryKey: ['skill-sub', skill.slug] });
      qc.invalidateQueries({ queryKey: ['skill', skill.slug] });
      qc.invalidateQueries({ queryKey: ['skills'] });
      qc.invalidateQueries({ queryKey: ['my-subscriptions'] });
    },
    onError: (err) => {
      const msg = err instanceof ApiClientError ? err.message : t('skill.unsubscribeFailed');
      showToast(msg, 'error');
    },
  });

  const [downloading, setDownloading] = useState(false);
  async function handleDownload() {
    if (!user) {
      showToast(t('skill.signInPrompt'), 'error');
      return;
    }
    setDownloading(true);
    try {
      await downloadFile(`/skills/${skill.slug}/download`, `${skill.slug}.zip`);
      qc.invalidateQueries({ queryKey: ['skill', skill.slug] });
      qc.invalidateQueries({ queryKey: ['skills'] });
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : t('skill.downloadFailed');
      showToast(msg, 'error');
    } finally {
      setDownloading(false);
    }
  }

  const subscribed = subQ.data?.subscribed ?? false;
  const subBusy = subscribe.isPending || unsubscribe.isPending;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h1 className="text-xl font-semibold">{skill.name}</h1>
            <StatusBadge status={skill.status} />
            {skill.version && (
              <span className="text-xs font-mono text-slate-500">v{skill.version}</span>
            )}
          </div>
          <p className="text-sm text-slate-600">{skill.description}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          {user && skill.status === 'published' && (
            <button
              type="button"
              onClick={() => (subscribed ? unsubscribe.mutate() : subscribe.mutate())}
              disabled={subBusy || subQ.isLoading}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border transition-colors ${
                subscribed
                  ? 'bg-amber-50 border-amber-300 text-amber-800 hover:bg-amber-100'
                  : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
              } disabled:opacity-60`}
            >
              {subBusy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Star className={`w-4 h-4 ${subscribed ? 'fill-amber-500 text-amber-500' : ''}`} />
              )}
              {subscribed ? t('skill.subscribed') : t('skill.subscribe')}
            </button>
          )}
          <button
            type="button"
            onClick={handleDownload}
            disabled={downloading || !user}
            title={!user ? t('skill.signInToDownload') : t('skill.downloadTitle')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100 disabled:opacity-60"
          >
            {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {t('skill.download')}
          </button>
        </div>
      </div>

      {skill.status === 'rejected' && canViewAuthorTools && skill.rejection_reason && (
        <div className="mt-3 rounded-md bg-rose-50 border border-rose-200 p-3 flex gap-2 items-start">
          <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          <div className="text-sm">
            <div className="font-medium text-rose-800">{t('skill.rejected')}</div>
            <div className="text-rose-700 mt-0.5">{skill.rejection_reason}</div>
          </div>
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
        <MetaItem icon={<User className="w-4 h-4" />} label={t('skill.author')}>
          {skill.author_username}
        </MetaItem>
        {skill.category_name && (
          <MetaItem icon={<Folder className="w-4 h-4" />} label={t('skill.category')}>
            {skill.category_name}
          </MetaItem>
        )}
        <MetaItem icon={<Calendar className="w-4 h-4" />} label={t('skill.updated')}>
          {new Date(skill.updated_at + 'Z').toLocaleDateString()}
        </MetaItem>
        <MetaItem icon={<StarOff className="w-4 h-4" />} label={t('skill.subscribers')}>
          {skill.subscriber_count}
        </MetaItem>
        <MetaItem icon={<Download className="w-4 h-4" />} label={t('skill.downloads')}>
          {skill.download_count}
        </MetaItem>
        <MetaItem icon={<Hash className="w-4 h-4" />} label={t('skill.size')}>
          {formatBytes(skill.file_size)}
        </MetaItem>
      </dl>

      {skill.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {skill.tags.map((tg) => (
            <span
              key={tg.slug}
              className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700"
            >
              {tg.name}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 text-xs text-slate-400 font-mono break-all">
        sha256: {skill.sha256}
      </div>
    </div>
  );
}

function OverviewTab({ skill }: { skill: SkillDetail }) {
  const t = useT();
  return (
    <div className="space-y-6">
      <InstallCommands slug={skill.slug} />
      {skill.readme_excerpt && (
        <div>
          <h2 className="text-sm font-semibold text-slate-700 mb-2">{t('skill.readmeExcerpt')}</h2>
          <div className="text-sm text-slate-600 whitespace-pre-wrap">
            {skill.readme_excerpt}
          </div>
          <p className="text-xs text-slate-400 mt-2">{t('skill.fullPreviewHint')}</p>
        </div>
      )}
    </div>
  );
}

function InstallCommands({ slug }: { slug: string }) {
  const t = useT();
  const [copied, setCopied] = useState<string | null>(null);

  const userInstall = `mkdir -p ~/.claude/skills/${slug} && unzip -o ${slug}.zip -d ~/.claude/skills/${slug}`;
  const projectInstall = `mkdir -p .claude/skills/${slug} && unzip -o ${slug}.zip -d .claude/skills/${slug}`;

  function copy(label: string, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-700 mb-2">{t('skill.installHeader')}</h2>
      <p className="text-xs text-slate-500 mb-3">{t('skill.installHint')}</p>
      <div className="space-y-2">
        <CommandLine
          label={t('skill.userWide')}
          command={userInstall}
          isCopied={copied === 'user'}
          onCopy={() => copy('user', userInstall)}
        />
        <CommandLine
          label={t('skill.projectLocal')}
          command={projectInstall}
          isCopied={copied === 'project'}
          onCopy={() => copy('project', projectInstall)}
        />
      </div>
    </div>
  );
}

function CommandLine({
  label,
  command,
  isCopied,
  onCopy,
}: {
  label: string;
  command: string;
  isCopied: boolean;
  onCopy: () => void;
}) {
  const t = useT();
  return (
    <div>
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 px-3 py-2 rounded-md bg-slate-900 text-slate-100 text-xs font-mono overflow-x-auto whitespace-nowrap">
          {command}
        </code>
        <button
          type="button"
          onClick={onCopy}
          title={t('skill.copyToClipboard')}
          className="inline-flex items-center gap-1 px-3 rounded-md border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 text-xs"
        >
          {isCopied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
          {isCopied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
    </div>
  );
}

function PreviewTab({
  previewQ,
}: {
  previewQ: ReturnType<typeof useQuery<PreviewResponse, Error>>;
}) {
  const t = useT();
  if (previewQ.isLoading)
    return <Loader2 className="w-5 h-5 animate-spin text-slate-400 mx-auto" />;
  if (previewQ.error)
    return <div className="text-sm text-rose-600">{t('skill.previewUnavailable')}</div>;
  const md = previewQ.data?.skill_md;
  if (!md) return <div className="text-sm text-slate-500">{t('skill.skillMdEmpty')}</div>;
  return <SkillMarkdown>{md}</SkillMarkdown>;
}

function FilesTab({
  previewQ,
}: {
  previewQ: ReturnType<typeof useQuery<PreviewResponse, Error>>;
}) {
  const t = useT();
  if (previewQ.isLoading)
    return <Loader2 className="w-5 h-5 animate-spin text-slate-400 mx-auto" />;
  if (previewQ.error)
    return <div className="text-sm text-rose-600">{t('skill.filesUnavailable')}</div>;
  const tree = previewQ.data?.file_tree ?? [];
  return <FileTree entries={tree} />;
}
/**
 * Read manifest.run.* config (from cached preview data) and decide whether
 * the skill can be executed by the server-side runner. Mirrors the logic in
 * server/src/skill-runner.js#detectExecutionMode.
 *
 * "Runnable" here means the Run tab is shown (Node OR Python entry script
 * exists). Agent-mode skills (no entry, just SKILL.md) are NOT considered
 * runnable from the detail view — they only surface through the Chat tab,
 * where the LLM uses `run_python_code` to execute against the bundle.
 */
function isSkillRunnable(preview: PreviewResponse | undefined): boolean {
  if (!preview) return false;
  const manifest = preview.manifest as Record<string, unknown> | null;
  const runCfg = (manifest?.run ?? null) as Record<string, unknown> | null;

  const declaredEntry =
    runCfg && typeof runCfg.entry === 'string' ? runCfg.entry : null;
  const declaredRuntime =
    runCfg && typeof runCfg.runtime === 'string' ? runCfg.runtime : null;

  // Reject runtimes we don't support.
  if (
    declaredRuntime &&
    declaredRuntime !== 'node' &&
    declaredRuntime !== 'python'
  ) {
    return false;
  }

  const hasFile = (p: string) =>
    preview.file_tree.some((f) => f.type === 'file' && f.path === p);

  if (declaredEntry) {
    if (declaredEntry.endsWith('.js') || declaredEntry.endsWith('.py')) {
      return hasFile(declaredEntry);
    }
    return false;
  }

  // No explicit entry → check default file presence.
  return hasFile('scripts/run.js') || hasFile('scripts/run.py');
}

function RunTab({
  skill,
  previewQ,
}: {
  skill: SkillDetail;
  previewQ: ReturnType<typeof useQuery<PreviewResponse, Error>>;
}) {
  const t = useT();
  const showToast = useStore((s) => s.showToast);

  const preview = previewQ.data;
  const manifest = (preview?.manifest ?? null) as Record<string, unknown> | null;
  const runCfg = (manifest?.run ?? null) as Record<string, unknown> | null;
  const declaredEntry =
    runCfg && typeof runCfg.entry === 'string' ? runCfg.entry : null;
  // If the manifest doesn't declare an entry, infer from file tree —
  // scripts/run.js wins over scripts/run.py for back-compat.
  const fileTree = preview?.file_tree ?? [];
  const inferredEntry =
    fileTree.some((f) => f.type === 'file' && f.path === 'scripts/run.js')
      ? 'scripts/run.js'
      : fileTree.some((f) => f.type === 'file' && f.path === 'scripts/run.py')
        ? 'scripts/run.py'
        : 'scripts/run.js';
  const entry = declaredEntry || inferredEntry;
  const timeoutMs =
    runCfg && Number.isFinite(runCfg.timeout_ms as number)
      ? (runCfg.timeout_ms as number)
      : 60_000;
  const inputExample = runCfg ? runCfg.input_example : undefined;

  const [inputText, setInputText] = useState<string>(() =>
    inputExample !== undefined ? JSON.stringify(inputExample, null, 2) : '{}',
  );
  // If the preview loads after the component mounts (StrictMode etc.), pull
  // the example into the textarea once it becomes available.
  useEffect(() => {
    if (inputExample !== undefined && inputText === '{}') {
      setInputText(JSON.stringify(inputExample, null, 2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(inputExample)]);

  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<{
    filename: string;
    durationMs: number | null;
  } | null>(null);
  const [error, setError] = useState<{
    code: string;
    message: string;
    detail?: { stderr?: string; stdout?: string; exitCode?: number };
  } | null>(null);
  const [stderrOpen, setStderrOpen] = useState(false);

  if (previewQ.isLoading) {
    return <Loader2 className="w-5 h-5 animate-spin text-slate-400 mx-auto" />;
  }
  if (previewQ.error || !preview) {
    return <div className="text-sm text-rose-600">{t('skill.previewUnavailable')}</div>;
  }
  if (!isSkillRunnable(preview)) {
    return (
      <div className="rounded-md bg-slate-50 border border-slate-200 p-4">
        <div className="font-medium text-slate-700 mb-1">
          {t('skill.run.notRunnableTitle')}
        </div>
        <div className="text-sm text-slate-600">{t('skill.run.notRunnableHint')}</div>
      </div>
    );
  }

  // Validate JSON input
  let parsedInput: unknown = undefined;
  let inputError: string | null = null;
  if (inputText.trim() === '') {
    parsedInput = {};
  } else {
    try {
      parsedInput = JSON.parse(inputText);
    } catch (e) {
      inputError =
        e instanceof Error ? e.message : t('skill.run.inputInvalid');
    }
  }
  // 1 MB hard cap (server enforces, we surface early)
  const inputBytes = new Blob([inputText]).size;
  const tooLarge = inputBytes > 1024 * 1024;

  async function handleRun() {
    if (inputError || tooLarge) return;
    setRunning(true);
    setError(null);
    setLastResult(null);
    setStderrOpen(false);
    try {
      const result = await postAndDownload(
        `/skills/${skill.slug}/run`,
        { input: parsedInput },
        skill.slug,
      );
      setLastResult({ filename: result.filename, durationMs: result.durationMs });
      showToast(
        t('skill.run.success', {
          ms: String(result.durationMs ?? '-'),
          name: result.filename,
        }),
        'success',
      );
    } catch (err) {
      if (err instanceof ApiClientError) {
        const d = err.detail as
          | { stderr?: string; stdout?: string; exitCode?: number }
          | null
          | undefined;
        setError({
          code: err.code,
          message: err.message,
          detail: d ?? undefined,
        });
      } else {
        setError({
          code: 'UNKNOWN',
          message: err instanceof Error ? err.message : t('skill.run.failed'),
        });
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-700">{t('skill.run.title')}</h3>
        <p className="text-xs text-slate-500 mt-1">{t('skill.run.intro')}</p>
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
          <span>{t('skill.run.entryHint', { entry })}</span>
          <span>·</span>
          <span>
            {t('skill.run.timeoutHint', { seconds: Math.round(timeoutMs / 1000) })}
          </span>
          <span>·</span>
          <span>{t('skill.run.docsAvailable')}</span>
        </div>
      </div>

      <div>
        <label
          htmlFor="run-input"
          className="block text-xs font-medium text-slate-600 mb-1"
        >
          {t('skill.run.inputLabel')}
        </label>
        <textarea
          id="run-input"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={t('skill.run.inputPlaceholder')}
          spellCheck={false}
          rows={10}
          className={`w-full rounded-md border bg-slate-900 text-slate-100 text-xs font-mono p-3 outline-none ${
            inputError || tooLarge
              ? 'border-rose-400 focus:ring-2 focus:ring-rose-300'
              : 'border-slate-700 focus:ring-2 focus:ring-brand-300'
          }`}
        />
        <div className="mt-1 flex items-center justify-between text-xs">
          <div className="text-rose-600">
            {inputError && t('skill.run.inputInvalid')}
            {!inputError && tooLarge && t('skill.run.inputTooLarge')}
          </div>
          <div className="text-slate-400">
            {(inputBytes / 1024).toFixed(1)} KB / 1024 KB
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleRun}
          disabled={running || !!inputError || tooLarge}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm rounded-md border border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100 disabled:opacity-60"
        >
          {running ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('skill.run.running')}
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              {t('skill.run.button')}
            </>
          )}
        </button>
        {lastResult && (
          <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700">
            <Check className="w-4 h-4" />
            {t('skill.run.success', {
              ms: String(lastResult.durationMs ?? '-'),
              name: lastResult.filename,
            })}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-rose-50 border border-rose-200 p-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-rose-800">
                {error.code === 'RUN_BUSY'
                  ? t('skill.run.busy')
                  : error.code === 'TIMEOUT'
                    ? t('skill.run.timeout')
                    : error.code === 'SCRIPT_FAILED'
                      ? t('skill.run.scriptFailed')
                      : t('skill.run.failed')}
              </div>
              <div className="text-xs text-rose-700 mt-0.5 break-words">
                <code>{error.code}</code>: {error.message}
              </div>
              {error.detail?.stderr && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setStderrOpen((v) => !v)}
                    className="text-xs underline text-rose-700"
                  >
                    {stderrOpen ? t('skill.run.hideStderr') : t('skill.run.viewStderr')}
                  </button>
                  {stderrOpen && (
                    <pre className="mt-1 text-xs bg-slate-900 text-slate-100 rounded-md p-3 overflow-x-auto font-mono whitespace-pre-wrap">
                      {error.detail.stderr}
                    </pre>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ManifestTab({
  previewQ,
}: {
  previewQ: ReturnType<typeof useQuery<PreviewResponse, Error>>;
}) {
  const t = useT();
  if (previewQ.isLoading)
    return <Loader2 className="w-5 h-5 animate-spin text-slate-400 mx-auto" />;
  if (previewQ.error)
    return <div className="text-sm text-rose-600">{t('skill.manifestUnavailable')}</div>;
  const fm = previewQ.data?.frontmatter;
  const manifest = previewQ.data?.manifest;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">{t('skill.frontmatterTitle')}</h3>
        {fm ? (
          <pre className="text-xs bg-slate-900 text-slate-100 rounded-md p-3 overflow-x-auto font-mono">
            {JSON.stringify(fm, null, 2)}
          </pre>
        ) : (
          <div className="text-sm text-slate-400">{t('skill.noFrontmatter')}</div>
        )}
      </div>
      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">{t('skill.manifestTitle')}</h3>
        {manifest ? (
          <pre className="text-xs bg-slate-900 text-slate-100 rounded-md p-3 overflow-x-auto font-mono">
            {JSON.stringify(manifest, null, 2)}
          </pre>
        ) : (
          <div className="text-sm text-slate-400">{t('skill.noManifest')}</div>
        )}
      </div>
    </div>
  );
}

function MetaItem({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-xs text-slate-500">
        {icon}
        {label}
      </dt>
      <dd className="text-slate-900 mt-0.5">{children}</dd>
    </div>
  );
}
