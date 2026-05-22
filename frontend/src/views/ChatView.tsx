import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type FormEvent,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  MessageSquare,
  Send,
  Plus,
  Trash2,
  Loader2,
  Sparkles,
  X as XIcon,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, getToken } from '../utils/api';
import { useT } from '../store';
import type { SkillListResponse, SkillSummary } from '../domain';

interface Conversation {
  id: number;
  user_id: number;
  skill_id: number | null;
  skill_name: string | null;
  skill_slug: string | null;
  title: string;
  created_at: string;
  updated_at: string;
}

interface Message {
  id: number;
  conversation_id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export function ChatView() {
  const t = useT();
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState<number | null>(null);

  const convsQ = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api<{ items: Conversation[] }>('/chat/conversations'),
  });

  // Auto-select most recent conversation when loaded
  useEffect(() => {
    if (activeId === null && convsQ.data && convsQ.data.items.length > 0) {
      setActiveId(convsQ.data.items[0].id);
    }
  }, [activeId, convsQ.data]);

  const createMut = useMutation({
    mutationFn: () => api<Conversation>('/chat/conversations', { method: 'POST', body: {} }),
    onSuccess: (conv) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      setActiveId(conv.id);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api(`/chat/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      if (activeId === id) setActiveId(null);
    },
  });

  const activeConv = convsQ.data?.items.find((c) => c.id === activeId) ?? null;

  return (
    <div className="flex flex-col md:flex-row gap-4 h-[calc(100vh-8rem)]">
      {/* Sidebar */}
      <aside className="md:w-64 shrink-0 flex flex-col bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="p-3 border-b border-slate-200">
          <button
            type="button"
            onClick={() => createMut.mutate()}
            disabled={createMut.isPending}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            {t('chat.newChat')}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {convsQ.isLoading && (
            <div className="p-4 text-center">
              <Loader2 className="w-4 h-4 animate-spin mx-auto text-slate-400" />
            </div>
          )}
          {convsQ.data?.items.length === 0 && (
            <p className="p-4 text-xs text-slate-400 text-center">{t('chat.empty')}</p>
          )}
          {convsQ.data?.items.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center px-3 py-2 cursor-pointer ${
                c.id === activeId ? 'bg-brand-50' : 'hover:bg-slate-50'
              }`}
              onClick={() => setActiveId(c.id)}
            >
              <div className="flex-1 min-w-0">
                <p
                  className={`text-sm truncate ${
                    c.id === activeId ? 'font-medium text-brand-700' : 'text-slate-700'
                  }`}
                >
                  {c.title || t('chat.untitled')}
                </p>
                <p className="text-xs text-slate-400 truncate flex items-center gap-1">
                  {c.skill_name && (
                    <>
                      <Sparkles className="w-3 h-3" />
                      <span className="truncate">{c.skill_name}</span>
                    </>
                  )}
                  {!c.skill_name && new Date(c.updated_at + 'Z').toLocaleDateString()}
                </p>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(t('chat.deleteConfirm'))) deleteMut.mutate(c.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-rose-600 rounded"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* Main panel */}
      <main className="flex-1 flex flex-col bg-white rounded-2xl border border-slate-200 overflow-hidden min-w-0">
        {activeConv ? (
          <ChatPanel conversation={activeConv} />
        ) : (
          <EmptyState onNew={() => createMut.mutate()} pending={createMut.isPending} />
        )}
      </main>
    </div>
  );
}

function EmptyState({ onNew, pending }: { onNew: () => void; pending: boolean }) {
  const t = useT();
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
      <MessageSquare className="w-12 h-12 text-slate-300" />
      <h2 className="mt-4 text-lg font-semibold">{t('chat.welcomeTitle')}</h2>
      <p className="mt-1 text-sm text-slate-500 max-w-sm">{t('chat.welcomeHint')}</p>
      <button
        type="button"
        onClick={onNew}
        disabled={pending}
        className="mt-6 inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
      >
        {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
        {t('chat.newChat')}
      </button>
    </div>
  );
}

function ChatPanel({ conversation }: { conversation: Conversation }) {
  const t = useT();
  const qc = useQueryClient();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load messages for this conversation
  const messagesQ = useQuery({
    queryKey: ['messages', conversation.id],
    queryFn: () => api<{ items: Message[] }>(`/chat/conversations/${conversation.id}/messages`),
  });

  useEffect(() => {
    if (messagesQ.data) setMessages(messagesQ.data.items);
  }, [messagesQ.data]);

  // Reset state when switching conversations
  useEffect(() => {
    setInput('');
    setStreamContent('');
    setStreaming(false);
  }, [conversation.id]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(scrollToBottom, [messages, streamContent, scrollToBottom]);

  // Skill picker state — opens when input starts with "/"
  const slashMatch = input.startsWith('/') ? input.slice(1).toLowerCase() : null;
  const pickerOpen = slashMatch !== null;

  // Mutation: attach/detach skill on this conversation
  const setSkillMut = useMutation({
    mutationFn: (skill_id: number | null) =>
      api<Conversation>(`/chat/conversations/${conversation.id}`, {
        method: 'PATCH',
        body: { skill_id },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const handlePickSkill = (skill: SkillSummary) => {
    setSkillMut.mutate(skill.id);
    setInput('');
    inputRef.current?.focus();
  };

  const handleDetachSkill = () => {
    setSkillMut.mutate(null);
  };

  const sendMessage = async () => {
    const content = input.trim();
    if (!content || streaming || pickerOpen) return;

    const userMsg: Message = {
      id: Date.now(),
      conversation_id: conversation.id,
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setStreaming(true);
    setStreamContent('');

    try {
      const token = getToken();
      const res = await fetch(`/api/chat/conversations/${conversation.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ content }),
      });

      if (!res.ok) {
        const err = await res.text();
        setStreamContent(`${t('chat.error')}: ${err}`);
        setStreaming(false);
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let full = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.content) {
              full += parsed.content;
              setStreamContent(full);
            }
          } catch {
            /* skip */
          }
        }
      }

      if (full) {
        const assistantMsg: Message = {
          id: Date.now() + 1,
          conversation_id: conversation.id,
          role: 'assistant',
          content: full,
          created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
      }
      qc.invalidateQueries({ queryKey: ['conversations'] });
    } catch (err) {
      setStreamContent(`${t('chat.error')}: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setStreaming(false);
      setStreamContent('');
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!pickerOpen) sendMessage();
    } else if (e.key === 'Escape' && pickerOpen) {
      setInput('');
    }
  };

  const handleInputChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
  };

  return (
    <>
      {/* Header: active skill chip */}
      <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
        <h2 className="text-sm font-medium truncate flex-1">{conversation.title}</h2>
        {conversation.skill_name && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-brand-50 border border-brand-200 text-xs text-brand-700">
            <Sparkles className="w-3 h-3" />
            {t('chat.skillAttached')}: <span className="font-medium">{conversation.skill_name}</span>
            <button
              type="button"
              onClick={handleDetachSkill}
              title={t('chat.detachSkill')}
              className="ml-1 hover:text-brand-900"
            >
              <XIcon className="w-3 h-3" />
            </button>
          </span>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messagesQ.isLoading && (
          <Loader2 className="w-5 h-5 animate-spin mx-auto text-slate-400" />
        )}
        {messages.length === 0 && !messagesQ.isLoading && !streaming && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <MessageSquare className="w-10 h-10 text-slate-300" />
            <h3 className="mt-3 text-sm font-medium text-slate-700">{t('chat.welcomeTitle')}</h3>
            <p className="mt-1 text-xs text-slate-500 max-w-xs">{t('chat.welcomeHint')}</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm ${
                m.role === 'user'
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-50 border border-slate-200 prose prose-sm max-w-none'
              }`}
            >
              {m.role === 'assistant' ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
              ) : (
                <span className="whitespace-pre-wrap">{m.content}</span>
              )}
            </div>
          </div>
        ))}
        {streaming && streamContent && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl px-4 py-2.5 text-sm bg-slate-50 border border-slate-200 prose prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamContent}</ReactMarkdown>
            </div>
          </div>
        )}
        {streaming && !streamContent && (
          <div className="flex justify-start">
            <div className="rounded-2xl px-4 py-2.5 bg-slate-50 border border-slate-200">
              <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area with slash-command picker */}
      <div className="border-t border-slate-200 p-3 relative">
        {pickerOpen && <SkillPicker query={slashMatch!} onPick={handlePickSkill} />}
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            sendMessage();
          }}
          className="flex gap-2 items-end"
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={t('chat.placeholder')}
            disabled={streaming}
            className="flex-1 resize-none rounded-xl border border-slate-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 disabled:opacity-50 max-h-32"
            style={{ minHeight: '44px' }}
          />
          <button
            type="submit"
            disabled={!input.trim() || streaming || pickerOpen}
            className="px-4 py-2.5 bg-brand-600 text-white rounded-xl hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </>
  );
}

function SkillPicker({
  query,
  onPick,
}: {
  query: string;
  onPick: (skill: SkillSummary) => void;
}) {
  const t = useT();
  const skillsQ = useQuery({
    queryKey: ['chat-skills'],
    queryFn: () => api<SkillListResponse>('/skills?status=published&limit=200'),
    staleTime: 60_000,
  });

  const filtered = useMemo(() => {
    const items = skillsQ.data?.items ?? [];
    if (!query) return items.slice(0, 8);
    const q = query.toLowerCase();
    return items
      .filter((s) => s.name.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q))
      .slice(0, 8);
  }, [skillsQ.data, query]);

  return (
    <div className="absolute bottom-full left-3 right-3 mb-2 bg-white rounded-xl border border-slate-200 shadow-lg max-h-72 overflow-y-auto z-10">
      {skillsQ.isLoading && (
        <div className="p-4 text-center">
          <Loader2 className="w-4 h-4 animate-spin mx-auto text-slate-400" />
        </div>
      )}
      {!skillsQ.isLoading && filtered.length === 0 && (
        <div className="p-3 text-sm text-slate-400 text-center">{t('chat.noSkillsFound')}</div>
      )}
      {filtered.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onPick(s)}
          className="w-full text-left px-3 py-2 hover:bg-brand-50 border-b border-slate-100 last:border-b-0"
        >
          <div className="flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-brand-600 shrink-0" />
            <span className="text-sm font-medium truncate">{s.name}</span>
            <span className="text-xs text-slate-400 truncate">/{s.slug}</span>
          </div>
          <p className="text-xs text-slate-500 line-clamp-1 mt-0.5">{s.description}</p>
        </button>
      ))}
    </div>
  );
}
