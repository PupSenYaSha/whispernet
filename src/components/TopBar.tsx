import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useConnection } from '../context';
import { cn } from '../utils';

export function TopBar({ onSettingsClick, isMobile, onBack }: { onSettingsClick: () => void; isMobile?: boolean; onBack?: () => void }) {
  const { state, openGeneral, openDm, t, blockedUsers, blockUser, unblockUser } = useConnection();
  const [showUsers, setShowUsers] = useState(false);
  const [blockModalOpen, setBlockModalOpen] = useState(false);
  const isDm = state.activeChannel !== 'general';
  const dmContact = isDm ? state.contacts.find(c => c.id === state.activeChannel) : null;
  const dmUser = isDm ? state.users.find(u => u.id === state.activeChannel) : null;
  const dmNickname = dmContact?.nickname || dmUser?.nickname || state.dmNames[state.activeChannel];
  const isOnline = isDm ? !!dmUser : false;
  const isBlocked = isDm ? blockedUsers.some(b => b.id === state.activeChannel) : false;

  const toggleBlock = () => {
    if (!isDm) return;
    if (isBlocked) {
      unblockUser(state.activeChannel);
    } else {
      setBlockModalOpen(true);
    }
  };

  const confirmBlock = () => {
    setBlockModalOpen(false);
    blockUser(state.activeChannel);
  };

  return (
    <header className="sticky top-0 z-30 bg-bg-secondary/80 backdrop-blur-xl border-b border-border-default">
      <div className={isMobile ? "px-4" : "px-3"}>
        <div className={cn("flex items-center justify-between", isMobile ? "h-16" : "h-14")}>
          <div className="flex items-center gap-3">
            {isMobile && onBack && (
              <button onClick={onBack} className="p-2 -ml-1 rounded-xl hover:bg-bg-tertiary transition-colors text-fg-muted">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            )}
            {!isMobile && isDm && (
              <button onClick={openGeneral} className="p-2 -ml-1 rounded-xl hover:bg-bg-tertiary transition-colors text-fg-muted">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            )}
            <div className={cn(
              isMobile ? 'w-11 h-11 rounded-2xl' : 'w-10 h-10 rounded-2xl',
              'flex items-center justify-center flex-shrink-0 text-[13px] font-bold',
              isDm ? 'bg-accent-primary/15 text-accent-primary' : 'bg-accent-primary'
            )}>
              {isDm && dmNickname ? (
                <span>{dmNickname.charAt(0).toUpperCase()}</span>
              ) : (
                <svg width={isMobile ? "20" : "18"} height={isMobile ? "20" : "18"} viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-text)" strokeWidth="2.5">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h1 className={cn(isMobile ? "text-[17px]" : "text-[15px]", "font-bold text-fg-primary leading-tight truncate")}>
                {isDm ? `@${dmNickname || '...'}` : t('global_chat')}
              </h1>
              <div className="flex items-center gap-1.5 mt-0.5">
                {isDm ? (
                  <>
                    <span className={cn(isMobile ? 'w-2.5 h-2.5' : 'w-2 h-2', 'rounded-full', isOnline ? 'bg-status-success shadow-[0_0_6px_var(--color-status-success)]' : 'bg-fg-subtle')} />
                    <span className={cn(isMobile ? 'text-[12px]' : 'text-[11px]', 'text-fg-muted')}>{isOnline ? t('online') : t('offline')}</span>
                  </>
                ) : (
                  <>
                    <span className={cn(isMobile ? 'w-2.5 h-2.5' : 'w-2 h-2', 'rounded-full', state.status === 'connected' ? 'bg-status-success shadow-[0_0_6px_var(--color-status-success)]' : state.status === 'disconnected' ? 'bg-status-error' : 'bg-status-warning animate-pulse')} />
                    <span className={cn(isMobile ? 'text-[12px]' : 'text-[11px]', 'text-fg-muted')}>{state.status === 'connected' ? t('status_connected') : state.status === 'disconnected' ? t('status_disconnected') : t('status_connecting')}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-shrink-0">
            {isDm && (
              <button
                onClick={toggleBlock}
                aria-label={isBlocked ? t('unblock') : t('block')}
                title={isBlocked ? t('unblock') : t('block')}
                className={cn(
                  'flex items-center gap-1.5 h-8 px-2.5 rounded-full text-[12px] font-medium transition-colors border',
                  isBlocked
                    ? 'bg-status-error/10 text-status-error border-status-error/30 hover:bg-status-error/20'
                    : 'bg-transparent text-fg-muted border-border-default hover:bg-status-error/10 hover:text-status-error hover:border-status-error/30'
                )}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M4.93 4.93l14.14 14.14" />
                </svg>
                <span>{isBlocked ? t('unblock') : t('block')}</span>
              </button>
            )}

            {!isDm && state.users.length > 0 && (
              <button
                onClick={() => setShowUsers(!showUsers)}
                className="px-3 py-1.5 rounded-xl text-[12px] font-medium text-fg-muted hover:bg-bg-tertiary transition-colors"
              >
                {state.users.length + 1} {t('online_users')}
              </button>
            )}

            {!isMobile && (
              <button
                onClick={onSettingsClick}
                className="p-2 rounded-xl hover:bg-bg-tertiary transition-colors text-fg-muted hover:text-fg-primary"
                aria-label={t('settings')}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {showUsers && !isDm && (
        <div className="border-t border-border-default px-4 py-2.5 bg-bg-secondary">
          <div className="flex flex-wrap gap-1.5">
            <span className="px-2.5 py-1 text-[12px] font-medium bg-accent-primary/10 text-accent-primary rounded-lg">
              @{state.nickname} (you)
            </span>
            {state.users.map(u => (
              <button key={u.id} onClick={() => { setShowUsers(false); openDm(u.id, u.nickname); }}
                className="px-2.5 py-1 text-[12px] font-medium bg-bg-tertiary text-fg-muted rounded-lg hover:bg-accent-primary/10 hover:text-accent-primary transition-colors cursor-pointer">
                @{u.nickname}
              </button>
            ))}
          </div>
        </div>
      )}

      {blockModalOpen && createPortal(
        <>
          <div className="fixed inset-0 bg-black/50 z-[80]" onClick={() => setBlockModalOpen(false)} />
          <div className="fixed inset-0 z-[81] flex items-center justify-center p-4">
            <div className="bg-bg-secondary border border-border-default rounded-3xl shadow-2xl max-w-sm w-full p-6"
              style={{ animation: 'scaleIn 0.2s cubic-bezier(0.22, 1, 0.36, 1)' }}>
              <div className="w-14 h-14 rounded-2xl bg-status-error/15 flex items-center justify-center mx-auto mb-5">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-status-error)" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M4.93 4.93l14.14 14.14" />
                </svg>
              </div>
              <h3 className="text-center text-[17px] font-semibold text-fg-primary mb-2">{t('block_dialog_title')}</h3>
              <p className="text-center text-[14px] text-fg-muted mb-6 leading-relaxed">
                {t('block_dialog_desc')}{dmNickname ? ` @${dmNickname}` : ''}
              </p>
              <div className="flex gap-3">
                <button onClick={() => setBlockModalOpen(false)}
                  className="flex-1 py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] font-medium hover:bg-bg-tertiary transition-colors">
                  {t('cancel')}
                </button>
                <button onClick={confirmBlock}
                  className="flex-1 py-3 rounded-2xl bg-status-error text-white text-[15px] font-semibold hover:brightness-110 transition-all">
                  {t('block')}
                </button>
              </div>
            </div>
          </div>
        </>,
        document.body
      )}
    </header>
  );
}
