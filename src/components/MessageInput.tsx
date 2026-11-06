import { useState, useEffect, useRef, useCallback } from 'react';
import { useConnection } from '../context';
import { mediaErrorKey, isAbortError, MAX_UPLOAD_BYTES } from '../upload';
import { MAX_MESSAGE_CHARS } from '../limits';
import { getDraft, setDraft, subscribeDrafts } from '../drafts';
import { StickerPicker } from './StickerPicker';
import { AudioPlayer } from './AudioPlayer';

/**
 * Where the half-typed message for a conversation is kept.
 *
 * Per conversation, on this device, and encrypted — see `../drafts` for why a draft is not simply a
 * `localStorage` entry: the app has a passcode lock, and a draft in the clear next to it undoes that
 * promise for the one conversation somebody was in the middle of thinking about.
 */
const draftKey = (channel: string) => channel || 'general';

export function MessageInput() {
  const { state, sendMessage, sendDm, sendImage, sendDmImage, sendAudio, sendDmAudio, blockedUsers, unblockUser, setReply, editingTarget, setEditing, editMessage, notifyTyping, t } = useConnection();
  const [hasText, setHasText] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const isConnected = state.status === 'connected';
  const isDm = state.activeChannel !== 'general';
  const dmTarget = isDm ? state.activeChannel : null;
  const isBlockedChat = isDm && !!dmTarget && blockedUsers.some(b => b.id === dmTarget);
  const blockedNick = isBlockedChat ? (state.dmNames[dmTarget] || '') : '';
  const replyTo = state.replyTo;
  const isEditing = !!editingTarget;

  // voice recording state
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

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
    setDraft(draftKey(dmTarget || 'general'), '');
  }, [setReply, setEditing, dmTarget]);

  const toggleVoiceRecording = async () => {
    if (isRecording) {
      const rec = mediaRecorderRef.current;
      if (rec && rec.state !== 'inactive') rec.stop();
      setIsRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        setAudioBlobUrl(url);
        setIsRecording(false);
      };
      rec.onerror = () => {
        stream.getTracks().forEach(t => t.stop());
        setIsRecording(false);
        setError(t('voice_record_failed'));
      };
      mediaRecorderRef.current = rec;
      rec.start();
      setIsRecording(true);
    } catch {
      setError(t('voice_record_failed'));
    }
  };

  const sendRecordedAudio = async () => {
    if (!audioBlobUrl) return;
    try {
      const res = await fetch(audioBlobUrl);
      const blob = await res.blob();
      const file = new File([blob], 'voice.webm', { type: 'audio/webm' });
      URL.revokeObjectURL(audioBlobUrl);
      setAudioBlobUrl(null);
      if (isDm && dmTarget) {
        await sendDmAudio(dmTarget, file);
      } else {
        await sendAudio(file);
      }
    } catch (e) {
      setError(t(mediaErrorKey(e)));
    }
  };

  const cancelRecording = () => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
    rec?.stream?.getTracks?.().forEach(t => t.stop());
    if (audioBlobUrl) { URL.revokeObjectURL(audioBlobUrl); setAudioBlobUrl(null); }
    setIsRecording(false);
  };

  // the composer is an uncontrolled textarea, so React reuses the same node when the channel
  // changes: without this a half typed message would follow the user into the next chat
  const channelRef = useRef(dmTarget || 'general');

  /**
   * Puts a saved draft back in the box, if there is one and nothing has been typed since.
   *
   * Called twice over: once when the conversation changes, and once when the encrypted box finishes
   * opening. The second call is the one that used to not exist - `hydrate` is behind a 600,000-iteration
   * derivation, so switching to a chat during it found an empty tab, showed an empty composer, and the
   * next keystroke wrote over the draft on disk without it ever having been shown.
   */
  const restoreDraft = useCallback((next: string) => {
    const restored = getDraft(next);
    if (!restored) return;
    const ta = textareaRef.current;
    // something has been typed and not sent: that is newer than anything in storage, and overwriting it
    // would lose what the user believes is still there
    if (!ta || ta.value.trim()) return;
    ta.value = restored;
    setHasText(restored.trim().length > 0);
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }, []);

  useEffect(() => {
    const next = dmTarget || 'general';
    if (channelRef.current === next) return;
    // the outgoing draft is kept, and the incoming one put back in the box
    setDraft(draftKey(channelRef.current), textareaRef.current?.value || '');
    channelRef.current = next;
    clearComposer();
    restoreDraft(next);
  }, [dmTarget, clearComposer, restoreDraft]);

  // the draft for a conversation already open arrives after this composer mounted, so it needs a nudge
  useEffect(() => subscribeDrafts(() => restoreDraft(channelRef.current)), [restoreDraft]);

  // the draft follows what is typed, and is dropped when the message actually goes
  const onComposerChange = (value: string) => {
    setHasText(value.trim().length > 0);
    setDraft(draftKey(dmTarget || 'general'), value);
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
      // The correction is what they typed, so an unchanged box has nothing to send: just stop editing.
      if (val === editingTarget.text) { clearComposer(); return; }
      // the same guard the send path has, because a correction waits on the peer's key and on the ratchet
      // exactly as a send does
      setSending(true);
      setError(null);
      try {
        // and the composer is only emptied once the correction is actually out. It used to clear itself
        // unconditionally over a fire-and-forget send, so a lost edit looked exactly like a sent one.
        if (await editMessage(editingTarget.id, val)) clearComposer();
        else setError(t('edit_failed'));
      } finally {
        setSending(false);
      }
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
      // a cancelled upload is not a failure: the user stopped it, or signing out did, and being told
      // "upload failed" about something they abandoned themselves is noise that trains them to ignore the
      // message that actually matters
      if (!isAbortError(e)) setError(t(mediaErrorKey(e)));
    }
    setUploading(false);
  };

  const sendSticker = (packId: string, file: string) => {
    if (!isConnected) return;
    const stickerText = `[sticker:${packId}:${file}]`;
    if (isDm && dmTarget) {
      void sendDm(dmTarget, stickerText);
    } else {
      void sendMessage(stickerText);
    }
    setStickerPickerOpen(false);
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
        <button type="button" disabled={!isConnected || uploading || isRecording}
          onClick={() => fileRef.current?.click()}
          className="flex-shrink-0 w-11 h-11 rounded-2xl bg-bg-tertiary border border-border-default text-fg-muted flex items-center justify-center hover:bg-bg-hover hover:text-fg-primary disabled:opacity-30 transition-all"
          aria-label={t('attach_file')}>
          {uploading ? (
            <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></svg>
          )}
        </button>
        <button type="button" disabled={!isConnected || uploading || isRecording}
          onClick={toggleVoiceRecording}
          className={`flex-shrink-0 w-11 h-11 rounded-2xl ${isRecording ? 'bg-status-error text-status-error' : 'bg-bg-tertiary border border-border-default text-fg-muted flex items-center justify-center hover:bg-bg-hover hover:text-fg-primary'} disabled:opacity-30 transition-all`}
          aria-label={isRecording ? t('stop_recording') : t('voice_message')}>
          {isRecording ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8" /></svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M8.5 12.5a1 1 0 0 1 1-1h3a1 1 0 1 1 0 2h-3a1 1 0 0 1-1-1" /></svg>
          )}
        </button>
        {audioBlobUrl && (
          <div className="flex items-center gap-2 min-w-[140px]">
            <AudioPlayer url={audioBlobUrl} onError={() => setError(t('voice_playback_failed'))} />
            <button type="button" onClick={sendRecordedAudio}
              className="w-8 h-8 rounded-full bg-accent-primary text-accent-text flex items-center justify-center hover:brightness-110 transition-colors"
              aria-label={t('send_voice')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
            <button type="button" onClick={cancelRecording}
              className="w-8 h-8 rounded-full text-status-error flex items-center justify-center hover:bg-status-error/10 transition-colors"
              aria-label={t('cancel')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
        )}
        <button type="button" disabled={!isConnected || uploading || isRecording}
          onClick={() => setStickerPickerOpen(true)}
          className="flex-shrink-0 w-11 h-11 rounded-2xl bg-bg-tertiary border border-border-default text-fg-muted flex items-center justify-center hover:bg-bg-hover hover:text-fg-primary disabled:opacity-30 transition-all"
          aria-label={t('stickers')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" /></svg>
        </button>
        <textarea
          data-testid="composer"
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
      {stickerPickerOpen && (
        <StickerPicker
          open={stickerPickerOpen}
          onClose={() => setStickerPickerOpen(false)}
          onSticker={sendSticker}
        />
      )}
    </form>
  );
}
