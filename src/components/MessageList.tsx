import { useRef, useEffect } from 'react';
import type { Message } from '../types';
import { useConnection } from '../context';
import { MessageItem } from './MessageItem';

export function MessageList({ messages }: { messages: Message[] }) {
  const { t } = useConnection();
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const prevLengthRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 120;
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, []);

  useEffect(() => {
    if (messages.length > prevLengthRef.current) {
      if (isNearBottomRef.current) {
        const el = containerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
    }
    prevLengthRef.current = messages.length;
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

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-fg-muted animate-in">
          <div className="w-16 h-16 rounded-2xl bg-bg-tertiary border border-border-default flex items-center justify-center mx-auto mb-4">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-fg-subtle">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <p className="text-[15px] font-medium text-fg-muted">{t('no_messages')}</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto px-2 py-3 space-y-2" role="log" aria-live="polite">
      {groupedMessages.map((group, i) => (
        <div key={i} className="flex flex-col gap-0.5">
          {group.map((msg, j) => (
            <MessageItem
              key={msg.id}
              message={msg}
              showAvatar={j === 0}
            />
          ))}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
