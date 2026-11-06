import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useConnection } from '../context';
import { useEscapeKey } from '../useEscapeKey';

export interface GroupCreateModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (groupId: string) => void;
}

export function GroupCreateModal({ open, onClose, onCreated }: GroupCreateModalProps) {
  const { createGroup, t } = useConnection();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [isChannel, setIsChannel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEscapeKey(onClose, open, 75);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      setError(null);
      setName('');
      setDescription('');
      setIsPrivate(true);
      setIsChannel(false);
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) {
      setError(t('group_name_required'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      createGroup(name.trim(), description.trim() || undefined, isPrivate, isChannel);
      setBusy(false);
      onClose();
      onCreated?.(name.trim()); // groupId comes from server async
    } catch {
      setBusy(false);
      setError(t('group_create_failed'));
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-bg-secondary border border-border-default rounded-2xl shadow-2xl max-w-sm w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-14 h-14 rounded-2xl bg-accent-primary/15 flex items-center justify-center mx-auto mb-5">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-accent-primary))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </div>
        <h3 className="text-center text-[17px] font-semibold text-fg-primary mb-1">{t('create_group')}</h3>
        <p className="text-center text-[12px] text-fg-muted leading-relaxed mb-4">{t('create_group_desc')}</p>

        <input
          ref={inputRef}
          type="text"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 64))}
          placeholder={t('group_name')}
          aria-label={t('group_name')}
          className="w-full px-4 py-3 rounded-xl bg-bg-tertiary border border-border-default text-[15px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary mb-2"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 200))}
          placeholder={t('group_description')}
          aria-label={t('group_description')}
          rows={2}
          className="w-full px-4 py-2.5 rounded-xl bg-bg-tertiary border border-border-default text-[15px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary mb-3 resize-none"
        />
        <div className="flex items-center gap-2 mb-2">
          <input
            id="group-private"
            type="checkbox"
            checked={isPrivate}
            onChange={() => setIsPrivate(!isPrivate)}
            className="rounded bg-bg-tertiary border-border-default text-accent-primary focus:ring-accent-primary"
          />
          <label htmlFor="group-private" className="text-[13px] text-fg-primary cursor-pointer select-none">
            {t('group_private')}
          </label>
        </div>
        <div className="flex items-center gap-2 mb-3">
          <input
            id="group-channel"
            type="checkbox"
            checked={isChannel}
            onChange={() => setIsChannel(!isChannel)}
            className="rounded bg-bg-tertiary border-border-default text-accent-primary focus:ring-accent-primary"
          />
          <label htmlFor="group-channel" className="text-[13px] text-fg-primary cursor-pointer select-none">
            {t('channel')}
          </label>
        </div>

        {error && <p className="text-[12px] text-status-error mb-3 text-center leading-relaxed">{error}</p>}

        <div className="flex gap-3">
          <button
            onClick={onClose}
            disabled={busy}
            className="flex-1 py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] font-medium hover:bg-bg-tertiary transition-colors disabled:opacity-40"
          >
            {t('cancel')}
          </button>
          <button
            data-testid="group-create-submit"
            onClick={submit}
            disabled={busy || !name.trim()}
            className="flex-1 py-3 rounded-2xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:opacity-90 transition-colors disabled:opacity-40"
          >
            {busy ? t('loading') : t('create_group')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
