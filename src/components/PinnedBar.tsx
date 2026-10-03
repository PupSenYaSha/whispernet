import { useState } from 'react';
import type { Message } from '../types';
import { useConnection } from '../context';
import { useEscapeKey } from '../useEscapeKey';

/**
 * The pinned messages of the current conversation, in a strip under the header.
 *
 * Held per device rather than on the server: a pin is one reader's way of keeping a line, a link or an
 * address at the top of their own view of a conversation, and a server-side list of those would be a
 * record of what every reader found worth keeping in conversations they are only passing through.
 */
export function PinnedBar({ messages }: { channel: string; messages: Message[] }) {
  const { t, jumpTo } = useConnection();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  useEscapeKey(close, open, 46);
  if (messages.length === 0) return null;

  const top = messages[0];

  return (
    <div className="border-b border-border-default bg-bg-secondary">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 px-4 py-2 text-left hover:bg-bg-tertiary/60 transition-colors"
        aria-expanded={open}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-primary flex-shrink-0 rotate-45" aria-hidden="true">
          <path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-bold text-accent-primary uppercase tracking-wider">
            {messages.length > 1 ? `${messages.length} ${t('pinned')}` : t('pinned')}
          </div>
          <div className="text-[12.5px] text-fg-primary truncate">{top.text || t('encrypted_message')}</div>
        </div>
        {messages.length > 1 && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cnArrow(open)} aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {open && (
        <div className="border-t border-border-default max-h-56 overflow-y-auto">
          {messages.map((m) => (
            <button
              key={m.id}
              onClick={() => { setOpen(false); jumpTo(m.id); }}
              className="w-full text-left px-4 py-2.5 hover:bg-bg-tertiary transition-colors border-b border-border-default/50 last:border-b-0"
            >
              <div className="text-[12px] font-semibold text-accent-primary">@{m.senderNickname}</div>
              <div className="text-[13px] text-fg-primary line-clamp-2 break-words">{m.text || t('encrypted_message')}</div>
            </button>
          ))}
          <div className="px-4 py-2 text-[11px] text-fg-muted">{t('pinned_note')}</div>
        </div>
      )}
    </div>
  );
}

function cnArrow(open: boolean): string {
  return open ? 'rotate-180 transition-transform' : 'transition-transform';
}
