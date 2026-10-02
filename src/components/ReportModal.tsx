import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { AvatarUpdate } from '../types';
import { useConnection } from '../context';
import { Avatar } from './Avatar';
import { cn } from '../utils';
import { useEscapeKey } from '../useEscapeKey';

const REASONS = ['report_reason_scam', 'report_reason_harassment', 'report_reason_inappropriate', 'report_reason_other'] as const;

/** A report has to say what it is about; the comment is optional once a reason is chosen. */
export function canSubmitReport(reason: string): boolean {
  return !!reason;
}

/**
 * Builds the report text a moderator reads: the chosen reason, and the reporter's own words when
 * they added any. Capped to the length the server stores.
 */
export function buildReportText(reason: string, comment: string, translated: Record<string, string>): string {
  const base = reason === 'report_reason_other' ? (comment.trim() || translated.report_reason_other) : translated[reason];
  return (reason === 'report_reason_other' ? base : (comment.trim() ? `${base}: ${comment.trim()}` : base)).slice(0, 500);
}

/** How long to wait for the server before telling the user it did not arrive. */
const SUBMIT_TIMEOUT_MS = 10000;

export function ReportModal({ targetId, targetNickname, avatar, messageId, onClose, onBack }: {
  targetId: string;
  targetNickname: string;
  avatar?: AvatarUpdate | null;
  messageId?: string;
  onClose: () => void;
  onBack?: () => void;
}) {
  const { state, dispatch, t, reportUser, closeReport } = useConnection();
  const [reason, setReason] = useState<string>('');
  const [comment, setComment] = useState('');
  const pendingRef = useRef(false);

  const status = state.reportStatus;
  const done = status === 'sent';
  const failed = status === 'failed';

  // Escape while the comment box has focus must not throw the text away
  useEscapeKey(() => { if (done) closeReport(); else if (onBack) onBack(); else closeReport(); }, true, 91, false);

  // a report opened from a message bubble reuses the shared status, so it has to start clean
  useEffect(() => { dispatch({ type: 'SET_REPORT_STATUS', status: 'idle' }); }, [dispatch, targetId, messageId]);

  // without this the button stayed on "Sending…" for good when the answer never came
  useEffect(() => {
    if (status !== 'pending') { pendingRef.current = false; return; }
    const timer = setTimeout(() => dispatch({ type: 'SET_REPORT_STATUS', status: 'failed' }), SUBMIT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status, dispatch]);

  const submit = () => {
    if (status === 'pending') return;
    if (!canSubmitReport(reason)) return;
    const details = buildReportText(reason, comment, t as unknown as Record<string, string>);
    if (!reportUser(targetId, details, messageId, messageId ? 'message' : 'profile')) {
      dispatch({ type: 'SET_REPORT_STATUS', status: 'failed' });
      return;
    }
    pendingRef.current = true;
    dispatch({ type: 'SET_REPORT_STATUS', status: 'pending' });
  };

  return createPortal(
    <div className="fixed inset-0 z-[91] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" />
      <div
        className="relative bg-bg-secondary border border-border-default rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label={t('report_title')}
        style={{ animation: 'scaleIn 0.2s cubic-bezier(0.22, 1, 0.36, 1)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-5 border-b border-border-default text-center">
          <div className="w-14 h-14 rounded-2xl bg-status-error/15 flex items-center justify-center mx-auto mb-4">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-status-error))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
            </svg>
          </div>
          <h2 className="text-[18px] font-bold text-fg-primary">{t('report_title')}</h2>
          <p className="text-[13px] text-fg-muted mt-1.5 leading-relaxed">{t('report_desc')}</p>
          <div className="mt-3 flex items-center justify-center gap-2">
            <Avatar userId={targetId} nickname={targetNickname} avatar={avatar} className="w-6 h-6 rounded-full" textClassName="text-[9px]" />
            <span className="text-[13px] font-semibold text-fg-primary">@{targetNickname}</span>
          </div>
        </div>

        <div className="px-6 py-5 flex flex-col gap-2.5">
          {done || failed ? (
            <div className="flex flex-col items-center gap-4 py-2">
              <div className={cn('w-12 h-12 rounded-full flex items-center justify-center', failed ? 'bg-status-error/15' : 'bg-status-success/15')}>
                {failed ? (
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-status-error))" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                ) : (
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-status-success))" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </div>
              <p className="text-[14px] text-fg-primary text-center leading-relaxed">{failed ? t('report_failed') : t('report_sent')}</p>
              {failed ? (
                <button onClick={() => { dispatch({ type: 'SET_REPORT_STATUS', status: 'idle' }); setReason(''); }}
                  className="w-full py-3 rounded-2xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:brightness-110 transition-all">
                  {t('try_again')}
                </button>
              ) : null}
              <button onClick={onClose}
                className="w-full py-3 rounded-2xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:brightness-110 transition-all">
                {t('done')}
              </button>
            </div>
          ) : (
            <>
              {REASONS.map(key => (
                    <button key={key} onClick={() => setReason(key)}
                      className={cn('w-full px-4 py-3 rounded-2xl text-left text-[14px] font-medium border transition-all flex items-center gap-3',
                        reason === key
                          ? 'bg-status-error/10 border-status-error text-fg-primary'
                          : 'bg-bg-tertiary border-border-default text-fg-muted hover:border-fg-subtle')}>
                      <span className={cn('w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0',
                        reason === key ? 'border-status-error' : 'border-fg-subtle')}>
                        {reason === key && <span className="w-2 h-2 rounded-full bg-status-error" />}
                      </span>
                      {t(key)}
                    </button>
                  ))}

                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder={t('report_hint')}
                    maxLength={500}
                    rows={3}
                    className="w-full px-3.5 py-3 rounded-2xl bg-bg-tertiary border border-border-default text-[14px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary resize-none"
                  />
              <div className="flex gap-2.5 pt-1">
                {onBack ? (
                  <button onClick={onBack}
                    className="flex-1 py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] font-medium hover:bg-bg-tertiary transition-colors">
                    {t('back')}
                  </button>
                ) : (
                  <button onClick={onClose}
                    className="flex-1 py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] font-medium hover:bg-bg-tertiary transition-colors">
                    {t('cancel')}
                  </button>
                )}
                <button onClick={submit}
                  disabled={status === 'pending' || !canSubmitReport(reason)}
                  className="flex-1 py-3 rounded-2xl bg-status-error text-white text-[15px] font-semibold hover:brightness-110 transition-all disabled:opacity-40">
                  {status === 'pending' ? t('sending') : t('report_send')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
