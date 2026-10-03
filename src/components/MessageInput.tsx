import { useState, useEffect, useRef, useCallback } from 'react';
import { useConnection } from '../context';
import { mediaErrorKey, MAX_UPLOAD_BYTES } from '../upload';
import { MAX_MESSAGE_CHARS } from '../limits';

/**
 * Where the half-typed message for a conversation is kept.
 *
 * Per conversation and on this device only. A draft is the one thing a person types that they have not
 * decided to send, and it belongs to nobody but them: putting it anywhere the account can reach would
 * mean a half-finished thought sitting in a server's database, and putting it in the message store would
 * mean it travelled to the other person before it was ready.
 */
const draftKey = (channel: string) => `wn_draft_${channel === 'general' ? 'general' : channel}`;

function readDraft(channel: string): string {
  try { return localStorage.getItem(draftKey(channel)) || ''; } catch { return ''; }
}

function writeDraft(channel: string, text: string): void {
  try {
    if (text.trim()) localStorage.setItem(draftKey(channel), text);
    else localStorage.removeItem(draftKey(channel));
  } catch { /* private mode: the draft simply will not survive a reload */ }
}

export function MessageInput() {
  const { state, sendMessage, sendDm, sendImage, sendDmImage, blockedUsers, unblockUser, setReply, editingTarget, setEditing, editMessage, notifyTyping, t } = useConnection();
  const [hasText, setHasText] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const isConnected = state.status === 'connected';
  const isDm = state.activeChannel !== 'general';
  const dmTarget = isDm ? state.activeChannel : null;
  const isBlockedChat = isDm && !!dmTarget && blockedUsers.some(b => b.id === dmTarget);
  const blockedNick = isBlockedChat ? (state.dmNames[dmTarget] || '') : '';
  const replyTo = state.replyTo;
  const isEditing = !!editingTarget;

  const autoResize = () => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    }
  };

  useEffect(() => { autoResize(); }, [hasText]);

  useEffect(() => { if (replyTo && !editingTarget) textareaRef.current?.focus(); }, [replyTo, editingTarget]);

  useEffect(() => {
    if (editingTarget && textareaRef.current) {
      textareaRef.current.value = editingTarget.text;
      setHasText(editingTarget.text.trim().length > 0);
      textareaRef.current.focus();
      autoResize();
    }
  }, [editingTarget]);

  const clearComposer = useCallback(() => {
    setReply(null);
    setEditing(null);
    const ta = textareaRef.current;
    if (ta) { ta.value = ''; ta.style.height = 'auto'; }
    setHasText(false);
    setError(null);
    writeDraft(dmTarget || 'general', '');
  }, [setReply, setEditing, dmTarget]);

  // the composer is an uncontrolled textarea, so React reuses the same node when the channel
  // changes: without this a half typed message would follow the user into the next chat
  const channelRef = useRef(dmTarget || 'general');
  useEffect(() => {
    const next = dmTarget || 'general';
    if (channelRef.current === next) return;
    // the outgoing draft is kept, and the incoming one put back in the box
    writeDraft(channelRef.current, textareaRef.current?.value || '');
    channelRef.current = next;
    clearComposer();
    const restored = readDraft(next);
    if (restored && textareaRef.current) {
      textareaRef.current.value = restored;
      setHasText(restored.trim().length > 0);
      autoResize();
    }
  }, [dmTarget, clearComposer]);

  // the draft follows what is typed, and is dropped when the message actually goes
  const onComposerChange = (value: string) => {
    setHasText(value.trim().length > 0);
    writeDraft(dmTarget || 'general', value);
    if (value.length > 0) notifyTyping(dmTarget || 'general');
  };

  // Abandoning an edit used to leave the old text sitting in the box, and the next Enter sent it
  // as a brand new message.
  useEffect(() => {
    if (editingTarget) return;
    const ta = textareaRef.current;
    if (ta && ta.value) { ta.value = ''; ta.style.height = 'auto'; setHasText(false); }
  }, [editingTarget]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // sending a direct message waits for the recipient key and for the crypto, so without a guard
    // a second Enter sends the same text twice
    if (sending) return;
    const ta = textareaRef.current;
    const val = ta?.value?.trim();
    if (!val || !isConnected) return;
    if (val.length > MAX_MESSAGE_CHARS) { setError(t('message_too_long')); return; }
    if (isEditing && editingTarget) {
      if (val !== editingTarget.text) editMessage(editingTarget.id, val);
      clearComposer();
      return;
    }
    setSending(true);
    setError(null);
    try {
      if (isDm && dmTarget) {
        await sendDm(dmTarget, val, replyTo || undefined);
      } else {
        await sendMessage(val, replyTo || undefined);
      }
      clearComposer();
    } catch (e) {
      setError(t(mediaErrorKey(e)));
    } finally {
      setSending(false);
    }
  };


  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) { setError(t('upload_unsupported')); return; }
    if (file.size === 0) { setError(t('upload_failed')); return; }
    // encrypted attachments are streamed rather than held whole, so the private chat now carries the
    // same ceiling as the global one and there is only one rule left to state
    if (file.size > MAX_UPLOAD_BYTES) { setError(t('upload_too_large')); return; }

    setError(null);
    setUploading(true);
    try {
      if (isDm && dmTarget) {
        await sendDmImage(dmTarget, file);
      } else {
        await sendImage(file);
      }
    } catch (e) {
      setError(t(mediaErrorKey(e)));
    }
    setUploading(false);
  };

  return isBlockedChat ? (
    <div className="px-3 pt-3 pb-safe border-t border-border-default bg-bg-secondary/60">
      <div className="flex items-center justify-between gap-3 rounded-2xl px-4 py-3 border border-border-default bg-bg-tertiary/50">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-full bg-status-error/15 flex items-center justify-center flex-shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-status-error))" strokeWidth="2">
              <circle cx="12" cy="12" r="10" /><path d="M4.93 4.93l14.14 14.14" />
            </svg>
          </div>
          <span className="text-[13px] text-fg-muted truncate">
            {t('blocked_chat_hint')}{blockedNick ? ` @${blockedNick}` : ''}
          </span>
        </div>
        <button
          onClick={() => unblockUser(dmTarget)}
          className="flex-shrink-0 px-3.5 h-9 rounded-full border border-border-default text-[13px] font-medium text-fg-primary hover:bg-bg-tertiary transition-colors"
        >
          {t('unblock')}
        </button>
      </div>
    </div>
  ) : (
    <form onSubmit={handleSubmit} className="px-3 pt-2.5 pb-safe">
      <input ref={fileRef} type="file" hidden accept="image/*,video/*"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
      {editingTarget && (
        <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-xl bg-accent-primary/10 border border-accent-primary/30 animate-step-in">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-accent-primary))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </svg>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold text-accent-primary">{t('editing_message')}</div>
            <div className="text-[12px] text-fg-muted truncate">{editingTarget.text}</div>
          </div>
          <button type="button" onClick={() => setEditing(null)} aria-label={t('cancel')}
            className="flex-shrink-0 p-1 rounded-full text-fg-muted hover:text-fg-primary hover:bg-bg-hover transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-xl bg-status-error/10 border border-status-error/30 animate-step-in">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-status-error))" strokeWidth="2" strokeLinecap="round" className="flex-shrink-0">
            <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
          </svg>
          <span className="text-[12px] text-status-error flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label={t('cancel')}
            className="flex-shrink-0 p-1 rounded-full text-status-error hover:bg-bg-hover transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      )}
      {replyTo && !editingTarget && (
        <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-xl bg-bg-tertiary border border-border-default animate-step-in">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-accent-primary))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
            <path d="M12 19l-7-7 7-7" /><path d="M19 12H5" />
          </svg>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold text-accent-primary truncate">@{replyTo.senderNickname}</div>
            <div className="text-[12px] text-fg-muted truncate">{replyTo.text}</div>
          </div>
          <button type="button" onClick={() => setReply(null)} aria-label={t('cancel')}
            className="flex-shrink-0 p-1 rounded-full text-fg-muted hover:text-fg-primary hover:bg-bg-hover transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <button type="button" disabled={!isConnected || uploading}
          onClick={() => fileRef.current?.click()}
          className="flex-shrink-0 w-11 h-11 rounded-2xl bg-bg-tertiary border border-border-default text-fg-muted flex items-center justify-center hover:bg-bg-hover hover:text-fg-primary disabled:opacity-30 transition-all"
          aria-label={t('attach_file')}>
          {uploading ? (
            <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></svg>
          )}
        </button>
        <textarea
          ref={textareaRef}
          onChange={(e) => onComposerChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isConnected ? t('type_message') : t('not_connected')}
          disabled={!isConnected}
          className="flex-1 px-4 py-2.5 rounded-2xl bg-bg-tertiary border border-border-default text-fg-primary text-[15px] placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary focus:border-transparent transition-[border-color,background-color,box-shadow] duration-200 resize-none"
          style={{ minHeight: '44px', maxHeight: '120px', overflow: 'hidden' }}
          rows={1}
          maxLength={MAX_MESSAGE_CHARS}
          aria-label={t('send_message')}
        />
        <button
          type="submit"
          disabled={!isConnected || !hasText || sending}
          className="flex-shrink-0 w-11 h-11 rounded-2xl bg-accent-primary text-accent-text flex items-center justify-center hover:brightness-110 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          aria-label={t('send_message')}
        >
          {sending ? (
            <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a12 12 0 0 1 12-12V0C5.373 0 0 5.373 0 12h4z" /></svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          )}
        </button>

      </div>
    </form>
  );
}
