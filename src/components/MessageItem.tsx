import type { Message } from '../types';
import { useState, useRef, useEffect, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { useConnection } from '../context';
import { cn, formatTime, getAvatarText, getAvatarGradient } from '../utils';

function MessageItemImpl({ message, showAvatar = true, fontSizeClass = 'text-[15px]' }: { message: Message; showAvatar?: boolean; fontSizeClass?: string }) {
  const { state, deleteMessage: deleteMsg, addReaction, removeReaction, setEditing, decryptMedia, setReply, reportUser, t } = useConnection();
  const isSystem = message.senderId === 'system';
  const isOwn = message.isOwn;

  const [showReactions, setShowReactions] = useState(false);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [reportCustom, setReportCustom] = useState('');
  const [reportDone, setReportDone] = useState(false);
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

  const reactionEntries = Object.entries(message.reactions || {})
    .map(([emoji, users]) => ({
    emoji,
    count: users.length,
    hasOwn: users.includes(state.userId || '')
    }))
    .filter(e => e.count > 0);

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
    <>
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
            'px-3.5 py-2.5 leading-relaxed relative',
            fontSizeClass,
            isOwn
              ? 'bg-bubble-mine text-bubble-mine-text rounded-2xl rounded-br-sm'
              : 'bg-bubble-other text-bubble-other-text border border-border-default rounded-2xl rounded-bl-sm'
          )}>
            {message.quotedMessageText && (
              <div className="mb-2 p-2 rounded-xl bg-black/70 border border-white/15 flex items-start gap-2">
                <span className="text-[14px] text-accent-primary leading-tight flex-shrink-0">↩</span>
                <div className="min-w-0">
                  <div className="text-[11px] font-bold text-accent-primary truncate">@{message.quotedMessageSender || '?'}</div>
                  <div className="text-[13px] text-white truncate">{message.quotedMessageText}</div>
                </div>
              </div>
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

          <div className="flex items-center gap-0.5 mt-1.5 px-1">
            <button
              onClick={() => {
                const mediaMatch = message.text.match(/^\[(image|video)\]([\s\S]*?)\[\/\1\]/);
                const quoteText = mediaMatch
                  ? (mediaMatch[1] === 'video' ? '🎥 Video' : '📷 Photo')
                  : message.text.trim().slice(0, 140);
                setReply({ id: message.id, senderNickname: message.senderNickname, text: quoteText });
              }}
              className="p-1.5 -ml-1.5 rounded-full text-fg-subtle hover:text-fg-primary hover:bg-bg-tertiary transition-colors"
              title={t('reply')} aria-label={t('reply')}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19l-7-7 7-7" /><path d="M19 12H5" />
              </svg>
            </button>
            <button
              onClick={() => setShowReactions(!showReactions)}
              className="p-1.5 rounded-full text-fg-subtle hover:text-fg-primary hover:bg-bg-tertiary transition-colors"
              title="Reactions" aria-label="Reactions">
              😊
            </button>
            {isOwn && !isMedia && (
              <button
                onClick={() => setEditing(message)}
                className="p-1.5 rounded-full text-fg-subtle hover:text-fg-primary hover:bg-bg-tertiary transition-colors"
                title={t('edit_message')} aria-label={t('edit_message')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
            )}
            {isOwn && (
              <button
                onClick={() => deleteMsg(message.id)}
                className="p-1.5 rounded-full text-fg-subtle hover:text-status-error hover:bg-status-error/10 transition-colors"
                title={t('delete')} aria-label={t('delete')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            )}
            {!isOwn && (
              <button
                onClick={() => { setReportOpen(true); setReportDone(false); setReportReason(''); setReportCustom(''); }}
                className="p-1.5 rounded-full text-fg-subtle hover:text-status-error hover:bg-status-error/10 transition-colors"
                title={t('report')} aria-label={t('report')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
                </svg>
              </button>
            )}
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
    {reportOpen && createPortal(
        <>
          <div className="fixed inset-0 bg-black/50 z-[90]" onClick={() => setReportOpen(false)} />
          <div className="fixed inset-0 z-[91] flex items-center justify-center p-4">
            <div className="bg-bg-secondary border border-border-default rounded-3xl shadow-2xl w-full max-w-sm p-6"
              style={{ animation: 'scaleIn 0.2s cubic-bezier(0.22, 1, 0.36, 1)' }}>
              {reportDone ? (
                <>
                  <div className="w-14 h-14 rounded-2xl bg-accent-primary/15 flex items-center justify-center mx-auto mb-5">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  </div>
                  <p className="text-center text-[15px] text-fg-primary leading-relaxed">{t('report_sent')}</p>
                  <button onClick={() => setReportOpen(false)}
                    className="mt-6 w-full py-3 rounded-2xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:opacity-90 transition-opacity">
                    OK
                  </button>
                </>
              ) : (
                <>
                  <div className="w-14 h-14 rounded-2xl bg-status-error/15 flex items-center justify-center mx-auto mb-5">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-status-error)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
                    </svg>
                  </div>
                  <h3 className="text-center text-[17px] font-semibold text-fg-primary mb-1.5">{t('report_title')}</h3>
                  <p className="text-center text-[13px] text-fg-muted mb-5 leading-relaxed">{t('report_desc')}</p>
                  <div className="flex flex-col gap-2 mb-4">
                    {['report_reason_scam', 'report_reason_harassment', 'report_reason_inappropriate', 'report_reason_other'].map(key => (
                      <button key={key}
                        onClick={() => setReportReason(key)}
                        className={`px-4 py-2.5 rounded-xl text-left text-[14px] border transition-colors ${
                          reportReason === key
                            ? 'bg-status-error/15 border-status-error text-fg-primary'
                            : 'bg-bg-tertiary border-border-default text-fg-muted hover:text-fg-primary'
                        }`}>
                        {t(key)}
                      </button>
                    ))}
                  </div>
                  <textarea
                    value={reportCustom}
                    onChange={(e) => setReportCustom(e.target.value)}
                    placeholder={t('report_hint')}
                    maxLength={500}
                    rows={2}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-bg-tertiary border border-border-default text-[14px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary resize-none mb-5" />
                  <div className="flex gap-3">
                    <button onClick={() => setReportOpen(false)}
                      className="flex-1 py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] font-medium hover:bg-bg-tertiary transition-colors">
                      {t('cancel')}
                    </button>
                    <button
                      onClick={() => {
                        const reason = reportReason === 'report_reason_other'
                          ? (reportCustom.trim() || t('report_reason_other'))
                          : t(reportReason || 'report_reason_scam');
                        reportUser(message.senderId, reason, message.id);
                        setReportDone(true);
                      }}
                      disabled={!reportReason}
                      className="flex-1 py-3 rounded-2xl bg-status-error text-white text-[15px] font-semibold hover:brightness-110 transition-all disabled:opacity-40">
                      {t('report_send')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  );
}

export const MessageItem = memo(MessageItemImpl);