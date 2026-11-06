/**
 * Модалка со сканером QR-кодов для сверки safety numbers.
 *
 * Запрашивает доступ к камере, показывает видеопоток и декодирует QR-коды в
 * реальном времени. После успешного сканирования вызывает onScanned с текстом
 * из QR-кода (обычно это safety number контакта).
 *
 * Kamera доступ запрашивается только при открытии модалки и освобождается при
 * закрытии — никакой постоянной записи не ведётся.
 *
 * Важно: сканер принимает ТОЛЬКО текст в формате safety number (6 групп по 8
 * hex-символов, разделённых пробелами). Любой другой текст отвергается — это
 * защита от внедрения через поддельный QR-код.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../useEscapeKey';
import { useConnection } from '../context';
import { Html5QrcodeScanner } from 'html5-qrcode';

/** Safety number format: 6 groups of 8 hex digits separated by spaces. */
const SAFETY_NUMBER_RE = /^[0-9A-F]{8}( [0-9A-F]{8}){5}$/;

interface QRScannerModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Called with the decoded safety number when it passes validation.
   * @param safetyNumber - the decoded number in Signal format
   */
  onScanned: (safetyNumber: string) => void;
  /**
   * Called with an error message when scanned text fails validation.
   */
  onInvalid?: (reason: string) => void;
}

export function QRScannerModal({ open, onClose, onScanned, onInvalid }: QRScannerModalProps) {
  const { t } = useConnection();
  const scannerRef = useRef<Html5QrcodeScanner | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const scannerId = `qr-scanner-${Date.now()}`;

  const startScanner = useCallback(() => {
    if (!containerRef.current) return;
    setError(null);
    try {
      const scanner = new Html5QrcodeScanner(scannerId, {
        fps: 10,
        qrbox: 250,
        rememberLastUsedCamera: true,
        showFlipCameraButtonIfSupported: true,
        showTorchButtonIfSupported: true,
        disableContinuousScanning: false,
      });
      scannerRef.current = scanner;
      scanner.render(
        (decodedText: string) => {
          // Validate: only accept safety number format, reject anything else
          const trimmed = decodedText.trim();
          if (!SAFETY_NUMBER_RE.test(trimmed)) {
            onInvalid?.('QR code does not contain a valid safety number');
            return;
          }
          onScanned(trimmed);
        },
        (_errorMessage: string) => {
          // errors during continuous scanning are expected and ignored
        }
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start scanner');
    }
  }, [scannerId, onScanned, onInvalid]);

  const stopScanner = useCallback(async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.clear();
      } catch { /* ignore */ }
      scannerRef.current = null;
    }
  }, []);

  // open/close
  useEffect(() => {
    if (open) {
      startScanner();
    } else {
      stopScanner();
    }
    return () => {
      void stopScanner();
    };
  }, [open, startScanner, stopScanner]);

  useEscapeKey(onClose, open, 91);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative bg-bg-secondary border border-border-default rounded-3xl shadow-2xl w-full max-w-sm max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border-default flex items-center justify-between">
          <h2 className="text-lg font-semibold text-fg-primary">{t('qr_scan_title')}</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-full text-fg-muted hover:bg-bg-tertiary hover:text-fg-primary transition-colors"
            aria-label={t('close')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 flex items-center justify-center p-6 min-h-[300px]">
          {error ? (
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="w-12 h-12 rounded-full bg-status-error/15 flex items-center justify-center">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-status-error))" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
                </svg>
              </div>
              <div className="text-[13px] text-status-error text-center">{error}</div>
              <button
                onClick={startScanner}
                className="w-full py-2.5 rounded-xl bg-bg-tertiary border border-border-default text-fg-primary text-[13px] font-medium hover:bg-bg-hover transition-colors"
              >
                {t('qr_retry')}
              </button>
            </div>
          ) : (
            <div ref={containerRef} id={scannerId} className="w-full max-w-xs aspect-square" />
          )}
        </div>

        <div className="px-6 py-4 border-t border-border-default">
          <p className="text-[12px] text-fg-muted text-center">{t('qr_scan_hint')}</p>
        </div>
      </div>
    </div>,
    document.body
  );
}
