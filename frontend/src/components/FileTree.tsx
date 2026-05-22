import { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Folder, FileText } from 'lucide-react';

export interface FileTreeEntry {
  path: string;
  size: number;
  type: 'file' | 'dir';
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  children: Map<string, TreeNode>;
}

function buildTree(entries: FileTreeEntry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isDir: true, size: 0, children: new Map() };
  for (const e of entries) {
    if (!e.path) continue;
    const parts = e.path.split('/').filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;
      const fullPath = parts.slice(0, i + 1).join('/');
      if (!cur.children.has(name)) {
        cur.children.set(name, {
          name,
          path: fullPath,
          isDir: isLast ? e.type === 'dir' : true,
          size: isLast ? e.size : 0,
          children: new Map(),
        });
      }
      cur = cur.children.get(name)!;
    }
  }
  return root;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function NodeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  if (node.isDir) {
    const children = Array.from(node.children.values()).sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 w-full text-left py-0.5 hover:bg-slate-50 rounded px-1"
          style={{ paddingLeft: depth * 12 + 4 }}
        >
          {open ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          )}
          <Folder className="w-3.5 h-3.5 text-amber-500" />
          <span className="text-sm font-medium">{node.name || '.'}</span>
          <span className="ml-auto text-xs text-slate-400 pr-2">
            {children.length} item{children.length === 1 ? '' : 's'}
          </span>
        </button>
        {open &&
          children.map((c) => (
            <NodeRow key={c.path || c.name} node={c} depth={depth + 1} />
          ))}
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-1.5 py-0.5 px-1 text-sm"
      style={{ paddingLeft: depth * 12 + 22 }}
    >
      <FileText className="w-3.5 h-3.5 text-slate-400" />
      <span className="text-slate-700">{node.name}</span>
      <span className="ml-auto text-xs text-slate-400 pr-2">{formatSize(node.size)}</span>
    </div>
  );
}

export function FileTree({ entries }: { entries: FileTreeEntry[] }) {
  const root = useMemo(() => buildTree(entries), [entries]);
  const top = Array.from(root.children.values()).sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  if (top.length === 0) {
    return <div className="text-sm text-slate-400 p-4">No files.</div>;
  }
  return (
    <div className="font-sans">
      {top.map((c) => (
        <NodeRow key={c.path || c.name} node={c} depth={0} />
      ))}
    </div>
  );
}
