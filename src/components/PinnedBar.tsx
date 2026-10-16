import { useMemo, useState } from 'react';
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
export function PinnedBar({ channel, messages }: { channel: string; messages: Message[] }) {
  const { state, t, jumpTo } = useConnection();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  useEscapeKey(close, open, 46);

  /**
   * Who to name for a pin, given that a pin says who sent nothing.
   *
   * `pins.ts` stores an id and nothing else - a pin of a private conversation must not become a second
   * readable copy of it - so every pin read back from storage has no sender, no text and no timestamp.
   * The name therefore has to come from somewhere live: the message itself if it is loaded, and the
   * conversation's name if it is not. Rendered at all only when there is one, because the alternative
   * was an `@undefined` on every pinned message after a reload.
   *
   * The conversation is only a fair answer for a private chat, where the other end is the only person it
   * could be. In the global chat it is not: there the fallback would name the reader for a message
   * somebody else wrote, so nothing is shown rather than the wrong thing.
   */
  const live = useMemo(() => {
    const byId = new Map<string, Message>();
    for (const m of state.messages) byId.set(m.id, m);
    for (const list of Object.values(state.dmMessages)) for (const m of list) byId.set(m.id, m);
    return byId;
  }, [state.messages, state.dmMessages]);
  const conversation = channel === 'general' ? '' : state.dmNames[channel] || '';
  const nameOf = (m: Message): string => m.senderNickname || live.get(m.id)?.senderNickname || conversation || '';

  // A pin is an id, so whether it can say anything at all depends on the message being loaded right now.
  //
  // Held ids survive a reload and outlive the message windows (which are capped), so after a while most pins
  // name a message this device no longer holds - and those rows rendered as empty, clickable buttons whose
  // `jumpTo` resolved to no element and returned silently. Pressing one did nothing, with nothing to say
  // why, which reads as a broken control rather than as a message that is not loaded. They are marked
  // instead, and clicking one is not offered.
  const resolvable = messages.filter((m) => live.has(m.id));
  const hiddenCount = messages.length - resolvable.length;

  // after every hook: this component is mounted and unmounted as pins come and go, and an early return
  // above a `useMemo` changes how many hooks run between renders
  if (messages.length === 0) return null;

  const top = resolvable[0];
  const topName = top ? nameOf(top) : '';

  return (
    <div className="border-b border-border-default bg-bg-secondary">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 px-4 py-2 text-left hover:bg-bg-tertiary/60 transition-colors"
        aria-expanded={open}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-primary flex-shrink-0 rotate-45" aria-hidden="true">
          <path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a1 1 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-bold text-accent-primary uppercase tracking-wider">
            {messages.length > 1 ? `${messages.length} ${t('pinned')}` : t('pinned')}
          </div>
          {/* No preview text: a pin stores a reference, not a copy, so a private message has nothing to
              show here. Saying "encrypted" would be the wrong kind of wrong - the message reads perfectly
              well, there is simply deliberately no second copy of its words on this device. */}
          {topName && <div className="text-[12.5px] text-fg-muted truncate">{topName}</div>}
        </div>
        {messages.length > 1 && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cnArrow(open)} aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {open && (
        <div className="border-t border-border-default max-h-56 overflow-y-auto">
          {resolvable.map((m) => {
            const name = nameOf(m);
            return (
              <button
                key={m.id}
                onClick={() => { setOpen(false); jumpTo(m.id); }}
                className="w-full text-left px-4 py-2.5 hover:bg-bg-tertiary transition-colors border-b border-border-default/50 last:border-b-0"
              >
                {name && <div className="text-[12px] font-semibold text-accent-primary">@{name}</div>}
                {m.text && <div className="text-[13px] text-fg-primary line-clamp-2 break-words">{m.text}</div>}
              </button>
            );
          })}
          {/* The pins whose message is not loaded, counted rather than drawn: a pin stores only an id, so
              there is nothing to show for one until its message is back in a loaded window. */}
          {hiddenCount > 0 && (
            <div className="px-4 py-2 text-[11px] text-fg-muted border-b border-border-default/50">
              {hiddenCount} {hiddenCount === 1 ? t('pin_not_loaded') : t('pins_not_loaded')}
            </div>
          )}
          <div className="px-4 py-2 text-[11px] text-fg-muted">{t('pinned_note')}</div>
        </div>
      )}
    </div>
  );
}


function cnArrow(open: boolean): string {
  return open ? 'rotate-180 transition-transform' : 'transition-transform';
}
