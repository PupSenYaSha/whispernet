import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProfileInfo } from '../types';
import { useConnection } from '../context';
import { Avatar } from './Avatar';
import { cn, formatProfileDate } from '../utils';
import { fileToAvatarDataUrl } from '../avatar';
import { useEscapeKey } from '../useEscapeKey';

export function ProfileModal({ profile }: { profile: ProfileInfo }) {
  const { state, t, openDm, blockUser, unblockUser, openReport, closeProfile, setMyAvatar, removeMyAvatar, blockedUsers } = useConnection();
  const fileRef = useRef<HTMLInputElement>(null);
  const [savingAvatar, setSavingAvatar] = useState(false);

  useEscapeKey(closeProfile, true, 86);

  const avatar = state.avatars[profile.id] ?? profile.avatar;
  const isBlocked = profile.isMe ? false : (blockedUsers.some((b: { id: string }) => b.id === profile.id) || !!profile.isBlockedByMe);

  const pickAvatar = async (file: File | null) => {
    if (!file) return;
    setSavingAvatar(true);
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      if (!dataUrl) { alert(t('avatar_upload_failed')); return; }
      await setMyAvatar(dataUrl);
    } catch { alert(t('avatar_upload_failed')); }
    finally { setSavingAvatar(false); }
  };

  return createPortal(
    <div className="fixed inset-0 z-[86] flex items-center justify-center p-4" onClick={closeProfile}>
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" />
      <div
        className="relative bg-bg-secondary border border-border-default rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden flex flex-col max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        aria-label={`@${profile.nickname}`}
        style={{ animation: 'scaleIn 0.2s cubic-bezier(0.22, 1, 0.36, 1)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pt-7 pb-5 px-6 text-center border-b border-border-default relative flex-shrink-0">
          <button onClick={closeProfile} className="absolute top-4 right-4 p-2 rounded-full text-fg-muted hover:bg-bg-tertiary hover:text-fg-primary transition-colors" aria-label={t('close')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
          <Avatar userId={profile.id} nickname={profile.nickname} avatar={avatar}
            className="w-28 h-28 rounded-full mx-auto shadow-lg" textClassName="text-[28px]" />
          <h2 className="mt-4 text-[20px] font-bold text-fg-primary break-all">@{profile.nickname}</h2>
          <div className="mt-1.5 flex items-center justify-center gap-1.5">
            <span className={cn('w-2 h-2 rounded-full', profile.online ? 'bg-status-success shadow-[0_0_6px_rgb(var(--color-status-success))]' : 'bg-fg-subtle')} />
            <span className="text-[12px] text-fg-muted">
              {profile.online ? t('online') : t('offline')}
            </span>
            {isBlocked && (
              <span className="px-2 py-0.5 rounded-full bg-status-error/15 text-status-error text-[11px] font-semibold">{t('blocked_profile')}</span>
            )}
            {profile.isBanned && (
              <span className="px-2 py-0.5 rounded-full bg-status-error/15 text-status-error text-[11px] font-semibold">{t('banned')}</span>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3">
          <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-2xl bg-bg-tertiary border border-border-default">
            <span className="text-[11px] font-medium text-fg-muted uppercase tracking-wider">{t('registered')}</span>
            <span className="text-[14px] font-semibold text-fg-primary">{formatProfileDate(profile.createdAt)}</span>
          </div>

          {profile.isMe ? (
            <div className="flex flex-col gap-2 pt-2">
              <button onClick={() => fileRef.current?.click()} disabled={savingAvatar}
                className="flex items-center justify-center gap-2 py-3 rounded-2xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:brightness-110 transition-all disabled:opacity-40">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" />
                </svg>
                {savingAvatar ? t('avatar_saving') : t('edit_avatar')}
              </button>
              {avatar?.ext && (
                <button onClick={() => { if (confirm(t('change_photo_confirm'))) removeMyAvatar(); }}
                  className="w-full py-3 rounded-2xl border border-border-default text-status-error text-[15px] font-medium hover:bg-status-error/10 transition-colors">
                  {t('remove_avatar')}
                </button>
              )}
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0] || null; if (f) pickAvatar(f); e.target.value = ''; }} />
            </div>
          ) : (
            <div className="flex flex-col gap-2 pt-2">
              <button
                onClick={() => { openDm(profile.id, profile.nickname); closeProfile(); }}
                className="flex items-center justify-center gap-2 py-3 rounded-2xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:brightness-110 transition-all">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                {t('message_user')}
              </button>
              {isBlocked ? (
                <button onClick={() => unblockUser(profile.id)}
                  className="w-full py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] font-medium hover:bg-bg-tertiary transition-colors">
                  {t('unblock_profile')}
                </button>
              ) : (
                <button onClick={() => blockUser(profile.id, profile.nickname)}
                  className="flex items-center justify-center gap-2 w-full py-3 rounded-2xl border border-status-error/40 text-status-error text-[15px] font-medium hover:bg-status-error/10 transition-colors">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" /><path d="M4.93 4.93l14.14 14.14" />
                  </svg>
                  {t('block')}
                </button>
              )}
              <button onClick={() => openReport(profile)}
                className="w-full py-3 rounded-2xl border border-border-default text-fg-muted text-[15px] font-medium hover:bg-bg-tertiary hover:text-fg-primary transition-colors">
                {t('report')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}