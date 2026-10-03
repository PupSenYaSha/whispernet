import { useRef, useEffect, useState, useMemo, memo } from 'react';
import type { Message } from '../types';
import { MessageItem } from './MessageItem';
import { cn } from '../utils';

/** Escapes a value for use inside a CSS attribute selector. */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof (CSS as any).escape === 'function') return (CSS as any).escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

function MessageListImpl({ messages, fontSizeClass, t, hasMore, loadingOlder, onLoadMore, jumpToMessageId, pinnedIds, channel }: { messages: Message[]; fontSizeClass: string; t: (key: string) => string; hasMore?: boolean; loadingOlder?: boolean; onLoadMore?: () => void; jumpToMessageId?: string | null; pinnedIds?: string[]; channel?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const prevLengthRef = useRef(0);
  // the empty state used to be a different tree, so on the normal path - connect, empty, messages
  // arrive - the scroll container was not mounted yet and these effects never attached
  const [mounted, setMounted] = useState(false);
  const [missedCount, setMissedCount] = useState(0);
  const [nearBottom, setNearBottom] = useState(true);
  const [flashId, setFlashId] = useState<string | null>(null);
  const pinnedSet = useMemo(() => new Set(pinnedIds || []), [pinnedIds]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setMounted(true);
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const near = scrollHeight - scrollTop - clientHeight < 120;
      isNearBottomRef.current = near;
      // kept as state as well as a ref: the button below has to appear and disappear, which a ref cannot do
      setNearBottom(near);
      if (near) setMissedCount(0);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [mounted]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const scrollToBottom = () => { el.scrollTop = el.scrollHeight; };
    const raf = requestAnimationFrame(scrollToBottom);
    const timeout = window.setTimeout(scrollToBottom, 80);
    return () => { cancelAnimationFrame(raf); clearTimeout(timeout); };
  }, [mounted]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (isNearBottomRef.current) {
        requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mounted]);

  const prevHeightRef = useRef(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (messages.length > prevLengthRef.current) {
      const added = messages.length - prevLengthRef.current;
      if (isNearBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      } else if (added > 1) {
        // an older page arrived under the reader: keep what they were looking at in place
        el.scrollTop += el.scrollHeight - prevHeightRef.current;
      } else if (added === 1) {
        // one message arrived while they were reading something else; remember how far behind they are
        setMissedCount((n) => n + 1);
      }
    }
    prevLengthRef.current = messages.length;
    prevHeightRef.current = el.scrollHeight;
  }, [messages]);

  /**
   * Take the reader to a message they picked out of a search result or a quote.
   *
   * Centred rather than scrolled to the edge, so the line above it is readable too - which is the whole
   * point of arriving there, since the reason they picked it is usually something in the context.
   */
  useEffect(() => {
    if (!jumpToMessageId) return;
    const el = containerRef.current;
    if (!el) return;
    const target = el.querySelector(`[data-message-id="${cssEscape(jumpToMessageId)}"]`);
    if (!target) return;
    const top = (target as HTMLElement).offsetTop - el.clientHeight / 2 + (target as HTMLElement).offsetHeight / 2;
    el.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    setFlashId(jumpToMessageId);
    const timer = setTimeout(() => setFlashId(null), 2000);
    return () => clearTimeout(timer);
  }, [jumpToMessageId, messages]);

  const scrollToBottom = () => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setMissedCount(0);
  };

  const groupedMessages = messages.reduce((acc: Message[][], msg) => {
    const lastGroup = acc[acc.length - 1];
    const lastMsg = lastGroup?.[lastGroup.length - 1];
    if (lastMsg &&
        lastMsg.senderId === msg.senderId &&
        Math.abs(msg.timestamp - lastMsg.timestamp) < 300000) {
      lastGroup.push(msg);
    } else {
      acc.push([msg]);
    }
    return acc;
  }, []);

  const newest = messages[messages.length - 1];

  function formatDateSeparator(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return t('today') || 'Today';
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return t('yesterday') || 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'long' }) + (d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : '');
  }

  const empty = messages.length === 0;

  return (
    <div className="relative flex-1 min-h-0">
    <div ref={containerRef} className="h-full overflow-y-auto overflow-x-hidden px-2 py-3 animate-fade-scroll">
      {empty && (
        <div className="h-full min-h-[60vh] flex items-center justify-center">
          <div className="text-center">
            <div className="w-16 h-16 rounded-2xl bg-bg-tertiary border border-border-default flex items-center justify-center mx-auto mb-4">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-fg-subtle">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <p className="text-[15px] font-medium text-fg-muted">{t('no_messages')}</p>
          </div>
        </div>
      )}
      {!empty && (
        <div className="space-y-2" role="log" aria-live="polite" aria-relevant="additions">
          {onLoadMore && hasMore && (
            <div className="flex justify-center py-2">
              <button
                type="button"
                onClick={onLoadMore}
                disabled={loadingOlder}
                className="px-3 py-1.5 rounded-full bg-bg-tertiary/70 text-[12px] font-medium text-fg-muted hover:bg-bg-tertiary hover:text-fg-primary transition-colors disabled:opacity-50"
              >
                {loadingOlder ? t('load_earlier') + '…' : t('load_earlier')}
              </button>
            </div>
          )}
          {groupedMessages.map((group, i) => {
            const prevGroup = groupedMessages[i - 1];
            const newDay = !prevGroup || new Date(prevGroup[0].timestamp).toDateString() !== new Date(group[0].timestamp).toDateString();
            return (
              <div key={group[0]?.id || i}>
                {newDay && (
                  <div className="flex items-center justify-center py-2">
                    <span className="px-3 py-1 rounded-full bg-bg-tertiary/60 text-[11px] font-medium text-fg-muted">
                      {formatDateSeparator(group[0].timestamp)}
                    </span>
                  </div>
                )}
                <div className="flex flex-col gap-0.5">
                  {group.map((msg, j) => (
                    <div
                      key={msg.id}
                      data-message-id={msg.id}
                      className={cn(
                        flashId === msg.id && 'rounded-xl bg-accent-primary/15 transition-colors duration-1000',
                      )}
                    >
                      <MessageItem
                        message={msg}
                        showAvatar={j === 0}
                        fontSizeClass={fontSizeClass}
                        animate={msg.id === newest?.id && Date.now() - msg.timestamp < 15000}
                        isPinned={pinnedSet.has(msg.id)}
                        channel={channel}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>

      {/* Reappears when the reader has scrolled up and something arrives, so a message is not missed by
          having scrolled back to read something - and it says how many, rather than being a bare arrow. */}
      {!empty && !nearBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-bg-secondary/95 border border-border-default shadow-lg text-fg-primary text-[12px] font-medium hover:bg-bg-tertiary transition-all"
          aria-label={t('scroll_to_bottom')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          {missedCount > 0 && <span className="text-accent-primary">{missedCount}</span>}
        </button>
      )}
    </div>
  );
}


export const MessageList = memo(MessageListImpl);
