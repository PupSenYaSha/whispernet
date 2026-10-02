import { useRef, useEffect, useState, memo } from 'react';
import type { Message } from '../types';
import { MessageItem } from './MessageItem';

function MessageListImpl({ messages, fontSizeClass, t, hasMore, loadingOlder, onLoadMore }: { messages: Message[]; fontSizeClass: string; t: (key: string) => string; hasMore?: boolean; loadingOlder?: boolean; onLoadMore?: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const prevLengthRef = useRef(0);
  // the empty state used to be a different tree, so on the normal path - connect, empty, messages
  // arrive - the scroll container was not mounted yet and these effects never attached
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setMounted(true);
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 120;
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
      if (isNearBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      } else if (messages.length > prevLengthRef.current + 1) {
        // an older page arrived under the reader: keep what they were looking at in place
        el.scrollTop += el.scrollHeight - prevHeightRef.current;
      }
    }
    prevLengthRef.current = messages.length;
    prevHeightRef.current = el.scrollHeight;
  }, [messages]);

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
    <div ref={containerRef} className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-3 animate-fade-scroll">
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
                    <MessageItem
                      key={msg.id}
                      message={msg}
                      showAvatar={j === 0}
                      fontSizeClass={fontSizeClass}
                      animate={msg.id === newest?.id && Date.now() - msg.timestamp < 15000}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


export const MessageList = memo(MessageListImpl);
