import type { Message } from '../types';
import { useState, useRef, useEffect, useMemo, memo } from 'react';
import { useConnection } from '../context';
import { cn, formatTime, getAvatarText, getAvatarGradient } from '../utils';

function MessageItemImpl({ message, showAvatar = true, fontSizeClass = 'text-[15px]' }: { message: Message; showAvatar?: boolean; fontSizeClass?: string }) {
  const { state, deleteMessage: deleteMsg, addReaction, removeReaction, editMessage, decryptMedia, t } = useConnection();
  const isSystem = message.senderId === 'system';
  const isOwn = message.isOwn;

  const [showReactions, setShowReactions] = useState(false);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const reactionPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (reactionPickerRef.current && !reactionPickerRef.current.contains(e.target as Node)) {
        setShowReactions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const isMedia = /^\[(image|video)\][\s\S]*?\[\/\1\]/.test(message.text);

  useEffect(() => {
    let cancelled = false;
    setMediaFailed(false);
    if (isMedia && message.fileKey) {
      decryptMedia(message).then((url) => {
        if (cancelled) return;
        if (url) setMediaUrl(url);
        else setMediaFailed(true);
      });
    } else {
      setMediaUrl(null);
    }
    return () => { cancelled = true; };
  }, [message.id, message.text, message.fileKey, isMedia, decryptMedia]);

  if (isSystem) {
    return (
      <div className="flex items-center justify-center py-2">
        <span className="px-4 py-1.5 rounded-full bg-bg-tertiary/60 text-[12px] font-medium text-fg-muted">
          {message.text}
        </span>
      </div>
    );
  }

  const reactionEntries = Object.entries(message.reactions || {}).map(([emoji, users]) => ({
    emoji,
    count: users.length,
    hasOwn: users.includes(state.userId || '')
  }));

  const expiresIn = useMemo(() => {
    if (!message.expiresAt) return null;
    const remaining = message.expiresAt - Date.now();
    if (remaining <= 0) return 'expired';
    const hours = Math.floor(remaining / 3600000);
    const minutes = Math.floor((remaining % 3600000) / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }, [message.expiresAt]);

  return (
    <div className={`flex gap-2.5 px-4 animate-message ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
      {!isOwn && showAvatar && (
        <div className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center mt-1 shadow-sm"
          style={{ background: getAvatarGradient(message.senderNickname) }}>
          <span className="text-[11px] font-bold text-white">
            {getAvatarText(message.senderNickname)}
          </span>
        </div>
      )}
      {!isOwn && !showAvatar && <div className="w-9" />}

      <div className={`flex flex-col max-w-[78%] ${isOwn ? 'items-end' : 'items-start'}`}>
        {!isOwn && showAvatar && (
          <span className="text-[12px] font-semibold text-accent-primary mb-1 px-1">
            {message.senderNickname}
          </span>
        )}

        <div className="relative">
          <div className={cn(
            'px-3.5 py-2.5 leading-relaxed group relative',
            fontSizeClass,
            isOwn
              ? 'bg-bubble-mine text-bubble-mine-text rounded-2xl rounded-br-sm'
              : 'bg-bubble-other text-bubble-other-text border border-border-default rounded-2xl rounded-bl-sm'
          )}>
            {isOwn && (
              <button onClick={() => deleteMsg(message.id)}
                className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-bg-tertiary border border-border-default flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-status-error/20"
                title={t('delete')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-fg-muted">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            )}
            {(() => {
              const mediaMatch = message.text.match(/^\[(image|video)\]([\s\S]*?)\[\/\1\]/);
              if (mediaMatch) {
                const [, tag] = mediaMatch;
                if (message.fileKey) {
                  if (mediaFailed) {
                    return <p className="whitespace-pre-wrap break-words text-status-error text-[13px]">{t('media_decrypt_error')}</p>;
                  }
                  if (!mediaUrl) {
                    return (
                      <div className="w-[240px] h-[160px] rounded-xl bg-bg-tertiary flex items-center justify-center">
                        <svg className="animate-spin h-6 w-6 text-fg-muted" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      </div>
                    );
                  }
                  if (tag === 'video') {
                    return (
                      <video src={mediaUrl} controls
                        className="rounded-xl max-w-[340px] max-h-[340px]" />
                    );
                  }
                  return (
                    <img src={mediaUrl} alt=""
                      className="rounded-xl max-w-[300px] max-h-[300px] object-cover cursor-pointer"
                      onClick={() => { window.open(mediaUrl, '_blank', 'noopener,noreferrer'); }} />
                  );
                }
                const [, , url] = mediaMatch;
                const safeUrl = /^(https?:\/\/)/i.test(url) ? url : null;
                if (!safeUrl) {
                  return <p className="whitespace-pre-wrap break-words text-status-error text-[13px]">Invalid URL</p>;
                }
                if (tag === 'video') {
                  const proxyUrl = `/api/media?url=${encodeURIComponent(safeUrl)}`;
                  return (
                    <video src={proxyUrl} controls
                      className="rounded-xl max-w-[340px] max-h-[340px] cursor-pointer" />
                  );
                }
                return (
                  <img src={safeUrl} alt=""
                    className="rounded-xl max-w-[300px] max-h-[300px] object-cover cursor-pointer"
                    onClick={() => { window.open(safeUrl, '_blank', 'noopener,noreferrer'); }} />
                );
              }
              return <p className="whitespace-pre-wrap break-words">{message.text}</p>;
            })()}
            {message.quotedMessageText && (
              <div className="mt-2 p-2 rounded-xl bg-bg-tertiary/50 border border-border-default text-xs text-fg-muted">
                <div className="font-medium text-fg-primary">{message.quotedMessageSender}</div>
                <div className="truncate">{message.quotedMessageText}</div>
              </div>
            )}
          </div>

          <div className="absolute right-2 bottom-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => setShowReactions(!showReactions)}
              className="p-1.5 rounded-full hover:bg-bg-tertiary text-fg-muted hover:text-fg-primary transition-colors"
              aria-label="Reactions">
            😊
            </button>
            {isOwn && !isMedia && (
              <button
                onClick={() => {
                  const newText = prompt(t('edit_message_prompt'), message.text);
                  if (newText && newText.trim() && newText !== message.text) {
                    editMessage(message.id, newText.trim());
                  }
                }}
                className="p-1.5 rounded-full hover:bg-bg-tertiary text-fg-muted hover:text-fg-primary transition-colors"
                aria-label="Edit">
              ✏️
            </button>
            )}
          </div>

          {showReactions && (
            <div
              ref={reactionPickerRef}
              className="absolute bottom-full right-0 mb-2 p-2 bg-bg-secondary rounded-xl border border-border-default shadow-lg flex gap-1 z-10"
              role="dialog"
            >
              {['👍', '👎', '❤️', '😂', '😮', '😢', '🎉', '🔥'].map(emoji => (
                <button
                  key={emoji}
                  onClick={() => {
                    const reactions = message.reactions || {};
                    const hasReacted = (reactions[emoji] || []).includes(state.userId || '');
                    if (hasReacted) removeReaction(message.id, emoji);
                    else addReaction(message.id, emoji);
                    setShowReactions(false);
                  }}
                  className={`p-1.5 rounded-full text-xl transition-transform hover:scale-110 ${
                    (message.reactions?.[emoji] || []).includes(state.userId || '') ? 'ring-2 ring-accent-primary' : ''
                  }`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1 mt-1.5 px-1">
            {reactionEntries.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                {reactionEntries.map(({ emoji, count, hasOwn }) => (
                  <span
                    key={emoji}
                    className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[11px] transition-colors ${
                      hasOwn ? 'bg-accent-primary/20 text-accent-primary' : 'bg-bg-tertiary text-fg-muted'
                    }`}
                  >
                    <span>{emoji}</span>
                    <span>{count}</span>
                  </span>
                ))}
              </div>
            )}
            <span className="text-[10px] text-fg-subtle ml-auto">
              {formatTime(message.timestamp)}
              {message.editedAt && (
                <span className="ml-1.5 text-fg-subtle/70">• edited</span>
              )}
              {expiresIn && (
                <span className={`ml-1.5 text-[10px] font-mono ${expiresIn === 'expired' ? 'text-status-error' : 'text-accent-primary'}`}>
                  ⏳ {expiresIn}
                </span>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export const MessageItem = memo(MessageItemImpl);