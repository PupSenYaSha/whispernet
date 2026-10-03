import { useEffect, useState } from 'react';
import { safetyNumber } from '../dmCrypto';
import { cn } from '../utils';
import { useConnection } from '../context';

/**
 * The number two people read aloud to be sure they are talking to each other.
 *
 * Everything else in a private message is checked by the server on the way past: it hands out the keys,
 * it routes the bodies, it stores them. This is the one check that does not depend on the server being
 * honest, which is why it is here and not buried in settings - if the number on both screens matches, the
 * keys in play are the ones they expect, and no server in between can have quietly swapped them.
 *
 * It is shown rather than demanded. Comparing a 60-digit number over voice is not always practical, and a
 * check nobody performs protects nobody.
 */
export function SafetyNumberRow({ peerId, peerIdentityKey }: { peerId: string; peerIdentityKey?: string | null }) {
  const { t } = useConnection();
  const [number, setNumber] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setNumber(null);
    setUnavailable(false);
    void (async () => {
      try {
        const n = await safetyNumber(peerIdentityKey);
        if (cancelled) return;
        if (n) setNumber(n);
        else setUnavailable(true);
      } catch {
        if (!cancelled) setUnavailable(true);
      }
    })();
    return () => { cancelled = true; };
  }, [peerId, peerIdentityKey]);

  if (unavailable) {
    return (
      <div className="px-4 py-3 rounded-2xl bg-bg-tertiary border border-border-default">
        <div className="text-[11px] font-medium text-fg-muted uppercase tracking-wider">{t('safety_number')}</div>
        <div className="text-[13px] text-fg-muted mt-1">{t('safety_number_unavailable')}</div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 rounded-2xl bg-bg-tertiary border border-border-default">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between gap-3 text-left"
        aria-expanded={open}
      >
        <span className="text-[11px] font-medium text-fg-muted uppercase tracking-wider">{t('safety_number')}</span>
        <span className={cn('text-[12px] font-medium', open ? 'text-accent-primary' : 'text-fg-muted')}>
          {open ? t('safety_number_hide') : t('safety_number_show')}
        </span>
      </button>

      {open && (
        <div className="mt-2.5">
          {number ? (
            <>
              <div className="font-mono text-[13px] leading-relaxed text-fg-primary break-all tracking-wide">
                {number}
              </div>
              <p className="text-[12px] text-fg-muted mt-2 leading-relaxed">{t('safety_number_hint')}</p>
            </>
          ) : (
            <div className="text-[13px] text-fg-muted">{t('loading')}</div>
          )}
        </div>
      )}
    </div>
  );
}