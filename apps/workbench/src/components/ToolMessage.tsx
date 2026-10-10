import { copyText } from '../host';
import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff,
  ArrowUpRight,
  Terminal,
  Users,
  FileText,
} from 'lucide-react';
import type { ToolCall } from '../model/types';
import { useRuntime } from '../app/context';
import { DataBlock, IconButton, Status } from './common';
export function ToolMessage({
  tool,
  expanded,
  onFile,
  onAgent,
}: {
  tool: ToolCall;
  expanded: boolean;
  onFile: (path: string) => void;
  onAgent: (id: string) => void;
}) {
  const [open, setOpen] = useState(expanded);
  const [tab, setTab] = useState<'output' | 'input'>('output');
  const { notify } = useRuntime();
  useEffect(() => setOpen(expanded), [expanded]);
  const Icon =
    tool.name === 'task'
      ? Users
      : tool.name === 'execute'
        ? Terminal
        : tool.before !== undefined
          ? FileDiff
          : FileText;
  return (
    <div className={`tool-call tool-${tool.status}`}>
      <button
        className="tool-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="tool-icon">
          <Icon size={14} />
        </span>
        <code>{tool.name}</code>
        <span className="tool-target">
          {String(
            tool.input.file_path ??
              tool.input.command ??
              tool.input.description ??
              tool.input.query ??
              '',
          )}
        </span>
        <span className="tool-time">{tool.elapsed}</span>
        {tool.status === 'success' ? (
          <Check size={13} />
        ) : (
          <Status value={tool.status} />
        )}
        <span>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {open && (
        <div className="tool-content">
          <div className="tool-toolbar">
            <div className="segmented">
              <button
                className={tab === 'output' ? 'active' : ''}
                onClick={() => setTab('output')}
              >
                output
              </button>
              <button
                className={tab === 'input' ? 'active' : ''}
                onClick={() => setTab('input')}
              >
                input
              </button>
            </div>
            {tool.filePath && (
              <button
                className="text-button"
                onClick={() => onFile(tool.filePath!)}
              >
                open file
                <ArrowUpRight size={12} />
              </button>
            )}
            {tool.agentId && (
              <button
                className="text-button"
                onClick={() => onAgent(tool.agentId!)}
              >
                agent record
                <ArrowUpRight size={12} />
              </button>
            )}
            <IconButton
              label="copy tool output"
              onClick={() =>
                copyText(
                  tab === 'input'
                    ? JSON.stringify(tool.input, null, 2)
                    : tool.output,
                ).then(
                  () => notify('copied'),
                  () => notify('clipboard unavailable'),
                )
              }
            >
              <Copy size={13} />
            </IconButton>
          </div>
          <DataBlock
            title={tab === 'input' ? 'raw input' : 'raw output'}
            value={tab === 'input' ? tool.input : tool.output}
          />
          <div className="tool-meta">{tool.id} · sample record</div>
        </div>
      )}
    </div>
  );
}
