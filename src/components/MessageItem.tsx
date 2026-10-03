import type { Message } from '../types';
import { useState, useRef, useEffect, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { useConnection } from '../context';
import { cn, formatTime, messageControls } from '../utils';
import { Avatar } from './Avatar';
import { ReportModal } from './ReportModal';
import { useEscapeKey } from '../useEscapeKey';
import { parseMediaTag } from '../media-crypto';
import { hasReadUpTo } from '../presence';
import { EMOJI_GROUPS, QUICK_EMOJI } from '../emojis';
import { mediaProxyUrl } from '../upload';

function MessageItemImpl({ message, showAvatar = true, fontSizeClass = 'text-[15px]', animate = false, isPinned = false, channel }: { message: Message; showAvatar?: boolean; fontSizeClass?: string; animate?: boolean; isPinned?: boolean; channel?: string }) {
  const { state, deleteMessage: deleteMsg, addReaction, removeReaction, setEditing, decryptMedia, retainMedia, releaseMedia, setReply, openProfile, copyMessageText, forwardMessage, togglePin, jumpTo, t } = useConnection();
  const isSystem = message.senderId === 'system';
  const isOwn = message.isOwn;

  const [showReactions, setShowReactions] = useState(false);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [lightbox, setLightbox] = useState<{ url: string; isVideo: boolean } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiGroup, setEmojiGroup] = useState(EMOJI_GROUPS[0].key);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [forwardNotice, setForwardNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const reactionPickerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeChannel = channel || message.channel || 'general';

  const flash = (text: string) => {
    setToast(text);
    setTimeout(() => setToast((cur) => (cur === text ? null : cur)), 1600);
  };

  // one clock for every bubble: each of them computed its countdown from its own render, so a
  // "24h" label froze at whatever it showed when the message arrived
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!message.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [message.expiresAt]);

  useEscapeKey(() => setLightbox(null), !!lightbox, 100);

  const resolvedQuoteText = useMemo(() => {
    if (message.quotedMessageText) return message.quotedMessageText;
    if (!message.quotedMessageId) return null;
    const found = state.messages.find((m) => m.id === message.quotedMessageId)
      || Object.values(state.dmMessages).flat().find((m) => m.id === message.quotedMessageId);
    const text = found?.text;
    if (!text) return '[encrypted]';
    const mm = parseMediaTag(text);
    if (mm) return mm.kind === 'video' ? `🎥 ${t('video_att')}` : `📷 ${t('photo_att')}`;
    return text;
  }, [message.quotedMessageText, message.quotedMessageId, state.messages, state.dmMessages, t]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (reactionPickerRef.current && !reactionPickerRef.current.contains(e.target as Node)) {
        setShowReactions(false);
      }
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!lightbox) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [lightbox]);

  const mediaTag = parseMediaTag(message.text);
  const isMedia = mediaTag !== null;
  // authorship decides the controls; sealed sender only decides where a correction is kept
  const controls = messageControls(message, isMedia);
  // How far the other end has said it has read. The server keeps no record of this, so it is exactly
  // what it told us: one of their devices looked.
  const readByPeer = isOwn && !!message.channel && hasReadUpTo(state.readUpTo, message.channel, message.timestamp);

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
  }, [message, isMedia, decryptMedia]);

  // hold the decrypted object URL for as long as this bubble shows it, otherwise the cache is
  // allowed to revoke an image that is still on screen
  useEffect(() => {
    if (!mediaUrl) return;
    retainMedia(message.id);
    return () => releaseMedia(message.id);
  }, [mediaUrl, message.id, retainMedia, releaseMedia]);

  const expiresIn = useMemo(() => {
    if (!message.expiresAt) return null;
    const remaining = message.expiresAt - now;
    if (remaining <= 0) return 'expired';
    const hours = Math.floor(remaining / 3600000);
    const minutes = Math.floor((remaining % 3600000) / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }, [message.expiresAt, now]);

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

  return (
    <>
      <div className={`flex gap-2.5 px-4 max-w-full ${isOwn ? 'flex-row-reverse' : 'flex-row'}${animate ? ' animate-message' : ''}`}>
      {!isOwn && showAvatar && (
        <button onClick={() => openProfile(message.senderId)}
          className="flex-shrink-0 w-9 h-9 rounded-full overflow-hidden mt-1 shadow-sm p-0 border-0 bg-transparent appearance-none"
          aria-label={t('profile')}>
          <Avatar userId={message.senderId} nickname={message.senderNickname} avatar={state.avatars[message.senderId]}
            className="w-full h-full rounded-full" textClassName="text-[11px]" />
        </button>
      )}
      {!isOwn && !showAvatar && <div className="w-9" />}

      <div className={`flex flex-col max-w-[78%] ${isOwn ? 'items-end' : 'items-start'}`}>
        {!isOwn && showAvatar && (
          <button onClick={() => openProfile(message.senderId)}
            className="text-[12px] font-semibold text-accent-primary mb-1 px-1 hover:underline cursor-pointer bg-transparent border-0 p-0 appearance-none">
            {message.senderNickname}
          </button>
        )}

        <div className="relative">
          <div className={cn(
            'px-3.5 py-2.5 leading-relaxed relative',
            fontSizeClass,
            isOwn
              ? 'bg-bubble-mine text-bubble-mine-text rounded-2xl rounded-br-sm'
              : 'bg-bubble-other text-bubble-other-text border border-border-default rounded-2xl rounded-bl-sm'
          )}>
            {(message.quotedMessageText || (message.quotedMessageId && resolvedQuoteText)) && (
              <div className="mb-2 p-2 rounded-xl bg-black/10 border border-black/5 dark:bg-white/5 dark:border-white/10 flex items-start gap-2">
                <span className={`text-[14px] leading-tight flex-shrink-0 ${isOwn ? 'text-bubble-mine-text/80' : 'text-accent-primary'}`}>↩</span>
                <div className="min-w-0">
                  <div className={`text-[11px] font-bold truncate ${isOwn ? 'text-bubble-mine-text/80' : 'text-accent-primary'}`}>@{message.quotedMessageSender || '?'}</div>
                  <div className="text-[13px] truncate">{resolvedQuoteText}</div>
                </div>
              </div>
            )}
            {(() => {
              if (mediaTag) {
                const tag = mediaTag.kind;
                if (message.fileKey) {
                  if (mediaFailed) {
                    return <p className="whitespace-pre-wrap break-words text-status-error text-[13px]">{t('media_decrypt_error')}</p>;
                  }
                  if (!mediaUrl) {
                    return (
                      <div className="w-[240px] h-[160px] rounded-xl bg-bg-tertiary flex items-center justify-center">
                        <svg className="animate-spin h-6 w-6 text-fg-muted" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a12 12 0 0 1 12-12V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      </div>
                    );
                  }
                  if (tag === 'video') {
                    return (
                      <video src={mediaUrl} controls
                        className="rounded-xl w-full max-w-[340px] max-h-[340px]" />
                    );
                  }
                  return (
                    <img src={mediaUrl} alt=""
                      className="rounded-xl w-full max-w-[300px] max-h-[300px] object-cover cursor-pointer"
                      onClick={() => { setLightbox({ url: mediaUrl, isVideo: false }); }} />
                  );
                }
                const safeUrl = /^(https?:\/\/)/i.test(mediaTag.url) ? mediaTag.url : null;

                if (!safeUrl) {
                  return <p className="whitespace-pre-wrap break-words text-status-error text-[13px]">{t('invalid_url')}</p>;
                }
                const proxyUrl = mediaProxyUrl(safeUrl);
                if (tag === 'video') {
                  return (
                    <video src={proxyUrl} controls
                      className="rounded-xl w-full max-w-[340px] max-h-[340px] cursor-pointer" />
                  );
                }
                return (
                  <img src={proxyUrl} alt=""
                    className="rounded-xl w-full max-w-[300px] max-h-[300px] object-cover cursor-pointer"
                    onClick={() => { setLightbox({ url: proxyUrl, isVideo: false }); }} />
                );
              }
              return <p className="whitespace-pre-wrap break-words">{message.text}</p>;
            })()}
          </div>

          {menuOpen && (
            <div
              className="absolute top-full mt-1 z-20 min-w-[190px] rounded-xl bg-bg-secondary border border-border-default shadow-lg py-1 overflow-hidden"
              role="menu"
            >
              <MenuItem
                label={t('copy_text')}
                onClick={async () => { setMenuOpen(false); flash(await copyMessageText(message.text) ? t('copied') : t('copy_failed')); }}
              />
              <MenuItem
                label={t('forward')}
                onClick={() => { setMenuOpen(false); setForwardOpen(true); }}
              />
              <MenuItem
                label={isPinned ? t('unpin') : t('pin')}
                onClick={() => { setMenuOpen(false); togglePin(message.id, activeChannel); }}
              />
              {controls.edit && (
                <MenuItem label={t('edit_message')} onClick={() => { setMenuOpen(false); setEditing(message); }} />
              )}
              {controls.remove && (
                <MenuItem label={t('delete')} danger onClick={() => { setMenuOpen(false); deleteMsg(message.id); }} />
              )}
            </div>
          )}

          {toast && (
            <span className="absolute top-full right-0 mt-1 z-20 px-2.5 py-1 rounded-lg bg-fg-primary text-bg-primary text-[11px] font-medium shadow-lg">
              {toast}
            </span>
          )}

          {showReactions && (
            <div
              ref={reactionPickerRef}
              className={cn('absolute bottom-full mb-2 z-30 rounded-2xl bg-bg-secondary border border-border-default shadow-lg', isOwn ? 'right-0' : 'left-0')}
              role="dialog"
              aria-label={t('reactions')}
            >
              {/* the quick strip: a single tap reacts without opening anything */}
              <div className="flex gap-0.5 p-1.5">
                {QUICK_EMOJI.map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => {
                      const already = (message.reactions?.[emoji] || []).includes(state.userId || '');
                      if (already) removeReaction(message.id, emoji);
                      else addReaction(message.id, emoji);
                      setShowReactions(false);
                    }}
                    className={cn(
                      'p-1.5 rounded-full text-xl transition-transform hover:scale-110',
                      (message.reactions?.[emoji] || []).includes(state.userId || '') && 'ring-2 ring-accent-primary',
                    )}
                  >
                    {emoji}
                  </button>
                ))}
                <span className="w-px bg-border-default mx-0.5 my-1 flex-shrink-0" />
                <button
                  onClick={() => setEmojiOpen((v) => !v)}
                  className={cn('p-1.5 rounded-full text-lg transition-colors hover:bg-bg-tertiary', emojiOpen && 'bg-accent-primary/15 text-accent-primary')}
                  aria-label={t('emoji_more')}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="12" cy="12" r="9" /><path d="M8.5 14.5s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8" /><circle cx="9" cy="10" r=".8" fill="currentColor" /><circle cx="15" cy="10" r=".8" fill="currentColor" />
                  </svg>
                </button>
              </div>

              {emojiOpen && (
                <div className="w-[248px] border-t border-border-default">
                  <div className="flex gap-1 px-2 pt-2 pb-1 overflow-x-auto">
                    {EMOJI_GROUPS.map((g) => (
                      <button
                        key={g.key}
                        onClick={() => setEmojiGroup(g.key)}
                        className={cn('px-1.5 py-0.5 rounded-md text-[10px] font-bold whitespace-nowrap transition-colors',
                          emojiGroup === g.key ? 'bg-accent-primary/15 text-accent-primary' : 'text-fg-muted hover:bg-bg-tertiary')}
                      >
                        {t(g.labelKey)}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-8 gap-0.5 p-2 max-h-[168px] overflow-y-auto">
                    {(EMOJI_GROUPS.find((g) => g.key === emojiGroup) || EMOJI_GROUPS[0]).emojis.map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => { addReaction(message.id, emoji); setShowReactions(false); setEmojiOpen(false); }}
                        className="p-1 rounded-lg text-xl hover:bg-bg-tertiary transition-transform hover:scale-110"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-0.5 mt-1.5 px-1" ref={menuRef}>
            {isPinned && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-primary flex-shrink-0 -ml-0.5" aria-label={t('pinned')}>
                <path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </svg>
            )}
            {message.quotedMessageId && (
              <button
                onClick={() => jumpTo(message.quotedMessageId!)}
                className="p-1.5 -ml-1.5 rounded-full text-fg-muted hover:text-fg-primary hover:bg-bg-tertiary transition-colors"
                title={t('jump_to_quoted')} aria-label={t('jump_to_quoted')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 0 1-4 4H4" />
                </svg>
              </button>
            )}
            <button
              onClick={() => {
                const quoteText = mediaTag
                  ? (mediaTag.kind === 'video' ? `🎥 ${t('video_att')}` : `📷 ${t('photo_att')}`)
                  : message.text.trim().slice(0, 140);
                setReply({ id: message.id, senderNickname: message.senderNickname, text: quoteText });
              }}
              className="p-1.5 -ml-1.5 rounded-full text-fg-muted hover:text-fg-primary hover:bg-bg-tertiary transition-colors"
              title={t('reply')} aria-label={t('reply')}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19l-7-7 7-7" /><path d="M19 12H5" />
              </svg>
            </button>
            <button
              onClick={() => setShowReactions(!showReactions)}
              className="p-1.5 rounded-full text-fg-muted hover:text-fg-primary hover:bg-bg-tertiary transition-colors"
              title={t('reactions')} aria-label={t('reactions')}>
              😊
            </button>
            {/* Authorship decides who may correct or remove a message, never the sealed flag.
                Gating on the flag gave the reader of an anonymous message the pencil and the bin, and
                left the person who had actually written it able to do nothing but delete. The sealed
                flag only decides *where* a correction is kept: in a private chat the server never held
                anything but ciphertext, so the new text is written on this device. */}
            {controls.edit && (
              <button
                onClick={() => setEditing(message)}
                className="p-1.5 rounded-full text-fg-muted hover:text-fg-primary hover:bg-bg-hover transition-colors"
                title={t('edit_message')} aria-label={t('edit_message')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
            )}
            {controls.remove && (
              <button
                onClick={() => deleteMsg(message.id)}
                className="p-1.5 rounded-full text-fg-muted hover:text-status-error hover:bg-status-error/10 transition-colors"
                title={t('delete')} aria-label={t('delete')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            )}
            {controls.report && (
              <button
                onClick={() => { setReportOpen(true); }}
                className="p-1.5 rounded-full text-fg-muted hover:text-status-error hover:bg-status-error/10 transition-colors"
                title={t('report')} aria-label={t('report')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
                </svg>
              </button>
            )}
            {!isMedia && (
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="p-1.5 rounded-full text-fg-muted hover:text-fg-primary hover:bg-bg-tertiary transition-colors"
                title={t('more_actions')} aria-label={t('more_actions')} aria-haspopup="menu" aria-expanded={menuOpen}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
                </svg>
              </button>
            )}
            <span className="text-[11px] text-fg-muted ml-auto">
              {formatTime(message.timestamp)}
              {message.editedAt && (
                <span className="ml-1.5 text-fg-muted/80">• {t('edited')}</span>
              )}
              {isOwn && message.channel && message.channel !== 'general' && (
                <span
                  className={cn('ml-1 inline-flex items-center', readByPeer ? 'text-accent-primary' : 'text-fg-muted/70')}
                  title={readByPeer ? t('read') : t('delivered')}
                  aria-label={readByPeer ? t('read') : t('delivered')}
                >
                  {readByPeer ? (
                    <svg width="15" height="11" viewBox="0 0 20 12" fill="none" aria-hidden="true">
                      <path d="M1 6.5l3.2 3.2L10 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M8 6.5l3.2 3.2L19 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <svg width="13" height="11" viewBox="0 0 14 12" fill="none" aria-hidden="true">
                      <path d="M1 6.5l3.2 3.2L12 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
              )}
              {expiresIn && (
                <span className={`ml-1.5 text-[10px] font-mono ${expiresIn === 'expired' ? 'text-status-error' : 'text-accent-primary'}`}>
                  ⏳ {expiresIn}
                </span>
              )}
            </span>
          </div>
          {reactionEntries.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mt-0.5 px-1 self-start max-w-[240px]">
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
        </div>
      </div>
    </div>
    {reportOpen && (
      <ReportModal
        targetId={message.senderId}
        targetNickname={message.senderNickname}
        avatar={state.avatars[message.senderId]}
        messageId={message.id}
        onClose={() => setReportOpen(false)}
      />
    )}
    {forwardNotice && (
      <div className="px-3 py-2 rounded-xl bg-status-warning/10 border border-status-warning/30 text-status-warning text-[12px] leading-relaxed">
        {forwardNotice}
      </div>
    )}
    {forwardOpen && (
      <ForwardPicker
        onClose={() => { setForwardOpen(false); setForwardNotice(null); }}
        onPick={async (to) => {
          setForwardOpen(false);
          try {
            await forwardMessage(message.id, to);
          } catch (e) {
            // An attachment cannot be forwarded as it stands - its key stayed in the conversation it was
            // sent to. Saying so beats a message that arrives as an image nobody can open.
            if ((e as Error)?.message === 'forward_media_unsupported') setForwardNotice(t('forward_media_unsupported'));
          }
        }}
      />
    )}
    {lightbox && createPortal(
      <div className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4" onClick={() => setLightbox(null)} role="dialog" aria-modal="true"
        style={{ animation: 'fadeIn 0.15s ease-out' }}>
        <button
          onClick={() => setLightbox(null)}
          className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 text-white text-[20px] flex items-center justify-center hover:bg-white/25 transition-colors z-10"
          aria-label={t('close')}>✕</button>
        {lightbox.isVideo ? (
          <video src={lightbox.url} controls autoPlay
            className="max-h-[90vh] max-w-[92vw] rounded-xl" onClick={(e) => e.stopPropagation()} />
        ) : (
          <img src={lightbox.url} alt=""
            className="max-h-[90vh] max-w-[92vw] object-contain rounded-xl" onClick={(e) => e.stopPropagation()} />
        )}
      </div>,
      document.body
    )}
    </>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      role="menuitem"
      className={cn(
        'w-full text-left px-3 py-2 text-[13px] transition-colors',
        danger ? 'text-status-error hover:bg-status-error/10' : 'text-fg-primary hover:bg-bg-tertiary',
      )}
    >
      {label}
    </button>
  );
}

/**
 * Where to forward to.
 *
 * The conversations this account already has, plus the public chat. Forwarding is a new message under the
 * sender's own name rather than a pointer to the original, which is what it has to be once the original
 * can be deleted by somebody else - so it goes through the ordinary send path and is encrypted like any
 * other message of its own.
 */
function ForwardPicker({ onClose, onPick }: { onClose: () => void; onPick: (to: string) => void }) {
  const { state, t } = useConnection();
  const [query, setQuery] = useState('');
  const contacts = state.contacts.filter((c) =>
    !query.trim() || c.nickname.toLowerCase().includes(query.trim().toLowerCase())
  );

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('forward')}>
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" />
      <div
        className="relative bg-bg-secondary border border-border-default rounded-2xl shadow-2xl w-full max-w-sm max-h-[70vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: 'scaleIn 0.2s cubic-bezier(0.22, 1, 0.36, 1)' }}
      >
        <div className="px-4 py-3 border-b border-border-default flex items-center gap-3">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-fg-muted flex-shrink-0">
            <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('forward_to')}
            className="flex-1 bg-transparent text-[14px] text-fg-primary placeholder:text-fg-muted focus:outline-none"
            aria-label={t('forward_to')}
          />
        </div>
        <div className="overflow-y-auto py-1">
          <button
            onClick={() => onPick('general')}
            className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-[14px] text-fg-primary hover:bg-bg-tertiary transition-colors"
          >
            <div className="w-8 h-8 rounded-xl bg-accent-primary/20 flex items-center justify-center flex-shrink-0">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-accent-primary))" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            {t('global_chat')}
          </button>
          {contacts.map((c) => (
            <button
              key={c.id}
              onClick={() => onPick(c.id)}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-[14px] text-fg-primary hover:bg-bg-tertiary transition-colors"
            >
              <Avatar userId={c.id} nickname={c.nickname} avatar={state.avatars[c.id]} className="w-8 h-8 rounded-xl" textClassName="text-[11px]" />
              <span className="truncate">@{c.nickname}</span>
            </button>
          ))}
          {contacts.length === 0 && (
            <p className="px-4 py-4 text-center text-[13px] text-fg-muted">{t('no_chats')}</p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export const MessageItem = memo(MessageItemImpl);