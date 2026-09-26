import { useCallback, useEffect, useState } from 'react';
import { useConnection } from '../context';
import { generateX3dhSafetyNumber } from '../crypto';
import QRCode from 'qrcode';
import { useEscapeKey } from '../useEscapeKey';

const safetyQrCache = new Map<string, string>();
const QR_OPTS = { margin: 1, width: 192, errorCorrectionLevel: 'L' } as const;

export function SafetyNumberButton() {
  const { state, getMyIdentityKeyB64, getPeerIdentityKeyB64, identityWarning, t } = useConnection();
  const [showSafety, setShowSafety] = useState(false);
  const [safetyNum, setSafetyNum] = useState('');
  const [qrCode, setQrCode] = useState<string>('');
  const [copyOk, setCopyOk] = useState(false);

  const closeSafety = useCallback(() => setShowSafety(false), []);
  useEscapeKey(closeSafety, showSafety, 61);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const myId = getMyIdentityKeyB64();
        if (!myId) {
          if (!cancelled) { setSafetyNum('IDENTITY NOT FOUND -- re-login required'); setQrCode(''); }
          return;
        }
        const peerId = state.activeChannel !== 'general' ? getPeerIdentityKeyB64(state.activeChannel) : null;
        const num = await generateX3dhSafetyNumber(myId, peerId);
        if (cancelled) return;
        setSafetyNum(num);
        const cached = safetyQrCache.get(num);
        if (cached) { setQrCode(cached); return; }
        setQrCode('');
        const qr = await QRCode.toDataURL(num, QR_OPTS);
        if (cancelled) return;
        safetyQrCache.set(num, qr);
        setQrCode(qr);
      } catch (e: any) {
        if (!cancelled) setSafetyNum('ERROR: ' + (e.message || 'unknown'));
      }
    })();
    return () => { cancelled = true; };
  }, [state.activeChannel, getMyIdentityKeyB64, getPeerIdentityKeyB64]);

  const showNumber = () => {
    setShowSafety(true);
    if (safetyNum && !qrCode) {
      const cached = safetyQrCache.get(safetyNum);
      if (cached) { setQrCode(cached); return; }
      void QRCode.toDataURL(safetyNum, QR_OPTS).then(qr => {
        safetyQrCache.set(safetyNum, qr);
        setQrCode(qr);
      }).catch(() => {});
    }
  };

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(safetyNum);
      } else {
        const ta = document.createElement('textarea');
        ta.value = safetyNum;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 2000);
    } catch {}
  };

  return (
    <>
      <button onClick={showNumber}
        className="px-3 py-1.5 rounded-xl text-[13px] font-medium bg-bg-tertiary text-fg-muted hover:text-fg-primary transition-colors">
        {t('safety_number')}
      </button>
      {showSafety && (
        <div className="fixed inset-0 bg-black/55 flex items-center justify-center z-[61] p-4" onClick={closeSafety}>
          <div className="bg-bg-secondary border border-border-default rounded-2xl w-full max-w-sm p-6 space-y-4 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[17px] font-semibold text-fg-primary">{t('safety_yours')}</h3>
            <p className="text-[13px] text-fg-muted">{t('safety_number_desc')}</p>
            {qrCode ? (
              <div className="flex justify-center mb-4">
                <img src={qrCode} alt="Safety Number QR" width={192} height={192} decoding="async" className="w-48 h-48" />
              </div>
            ) : safetyNum ? (
              <div className="w-48 h-48 mx-auto mb-4 rounded-xl bg-bg-tertiary animate-pulse" />
            ) : null}
            <div className="p-4 rounded-xl bg-bg-tertiary font-mono text-[13px] text-fg-primary break-all text-center leading-relaxed">
              {safetyNum}
            </div>
            {identityWarning && identityWarning.userId === state.activeChannel && (
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-[12px] text-red-400 text-center leading-relaxed">
                Identity key changed for this contact. Verify the new safety number with them out-of-band before trusting messages.
              </div>
            )}
            <button onClick={handleCopy}
              className="w-full py-3 rounded-xl border border-border-default text-fg-primary text-[15px] hover:bg-bg-tertiary transition-colors font-medium">
              {copyOk ? 'OK Copied' : t('copy')}
            </button>
            <button onClick={closeSafety}
              className="w-full py-3 rounded-xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:opacity-90 transition-opacity">
              {t('done')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
