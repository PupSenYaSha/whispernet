import { useState, useEffect, useRef } from 'react';
import { useConnection } from '../context';

export function MessageInput() {
  const { state, sendMessage, sendDm, sendImage, sendDmImage, t } = useConnection();
  const [hasText, setHasText] = useState(false);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isConnected = state.status === 'connected';
  const isDm = state.activeChannel !== 'general';
  const dmTarget = isDm ? state.activeChannel : null;

  const autoResize = () => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    }
  };

  useEffect(() => { autoResize(); }, [hasText]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const ta = textareaRef.current;
    const val = ta?.value?.trim();
    if (!val || !isConnected) return;
    if (isDm && dmTarget) {
      sendDm(dmTarget, val);
    } else {
      sendMessage(val);
    }
    if (ta) {
      ta.value = '';
      ta.style.height = 'auto';
    }
    setHasText(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return;
    if (file.size > 1000 * 1024 * 1024) return;
    setUploading(true);
    try {
      if (isDm && dmTarget) {
        await sendDmImage(dmTarget, file);
      } else {
        await sendImage(file);
      }
    } catch (e) { console.error('Upload failed:', e); }
    setUploading(false);
  };

  return (
    <form onSubmit={handleSubmit} className="px-3 py-2.5">
      <input ref={fileRef} type="file" hidden accept="image/*,video/*"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
      <div className="flex items-end gap-2">
        <button type="button" disabled={!isConnected || uploading}
          onClick={() => fileRef.current?.click()}
          className="flex-shrink-0 w-11 h-11 rounded-2xl bg-bg-tertiary border border-border-default text-fg-muted flex items-center justify-center hover:bg-bg-hover hover:text-fg-primary disabled:opacity-30 transition-all"
          aria-label="Attach file">
          {uploading ? (
            <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></svg>
          )}
        </button>
        <textarea
          ref={textareaRef}
          onChange={(e) => setHasText(e.target.value.trim().length > 0)}
          onKeyDown={handleKeyDown}
          placeholder={isConnected ? t('type_message') : t('not_connected')}
          disabled={!isConnected}
          className="flex-1 px-4 py-2.5 rounded-2xl bg-bg-tertiary border border-border-default text-fg-primary text-[15px] placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary focus:border-transparent transition-all duration-200 resize-none"
          style={{ minHeight: '44px', maxHeight: '120px', overflow: 'hidden' }}
          rows={1}
          maxLength={4096}
          aria-label={t('send_message')}
        />
        <button
          type="submit"
          disabled={!isConnected || !hasText}
          className="flex-shrink-0 w-11 h-11 rounded-2xl bg-accent-primary text-accent-text flex items-center justify-center hover:brightness-110 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          aria-label={t('send_message')}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </form>
  );
}
