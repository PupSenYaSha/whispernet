import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useConnection } from '../context';
import { useEscapeKey } from '../useEscapeKey';
import { cn } from '../utils';
import { stickerUrl } from '../stickers';

export interface StickerPickerProps {
  open: boolean;
  onClose: () => void;
  onSticker: (packId: string, file: string) => void;
}

export function StickerPicker({ open, onClose, onSticker }: StickerPickerProps) {
  const { t } = useConnection();
  const [packs, setPacks] = useState<{ id: string; name: string; emoji: string; stickers: string[] }[]>([]);
  const [selectedPack, setSelectedPack] = useState<string | null>(null);
  const [stickers, setStickers] = useState<string[]>([]);

  useEscapeKey(onClose, open, 85);

  useEffect(() => {
    if (!open) return;
    fetch('/api/sticker/packs')
      .then((r) => r.json())
      .then((data: { packs: { id: string; name: string; emoji: string; stickers: string[] }[] }) => {
        setPacks(data.packs || []);
        if (data.packs?.[0]) {
          setSelectedPack(data.packs[0].id);
          setStickers(data.packs[0].stickers || []);
        }
      })
      .catch(() => { /* packs will stay empty */ });
  }, [open]);

  const selectPack = (pack: { id: string; name: string; emoji: string; stickers: string[] }) => {
    setSelectedPack(pack.id);
    setStickers(pack.stickers);
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[85] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-bg-secondary border border-border-default rounded-2xl shadow-2xl max-w-md w-full max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-4 pb-2 border-b border-border-default flex justify-between items-center">
          <h3 className="text-[15px] font-bold text-fg-primary">{t('stickers')}</h3>
          <button onClick={onClose} className="p-2 rounded-full text-fg-muted hover:bg-bg-tertiary transition-colors" aria-label={t('close')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* пакеты стикеров */}
          <div className="w-20 border-r border-border-default overflow-y-auto">
            {packs.map((pack) => (
              <button
                key={pack.id}
                onClick={() => selectPack(pack)}
                className={cn(
                  'w-full px-2 py-2 text-left transition-colors',
                  selectedPack === pack.id
                    ? 'bg-accent-primary/20 text-accent-primary border-r-2 border-accent-primary'
                    : 'text-fg-muted hover:bg-bg-tertiary',
                )}
              >
                <span className="text-lg">{pack.emoji}</span>
                <span className="text-[11px] block truncate mt-1">{pack.name}</span>
              </button>
            ))}
          </div>

          {/* стикеры выбранного пакета */}
          <div className="flex-1 overflow-y-auto p-2">
            {selectedPack ? (
              <div className="grid grid-cols-4 gap-1">
                {stickers.map((file) => (
                  <button
                    key={file}
                    onClick={() => { onSticker(selectedPack!, file); onClose(); }}
                    className="aspect-square rounded-lg overflow-hidden border border-transparent hover:border-accent-primary transition-colors"
                  >
                    <img
                      src={stickerUrl(selectedPack, file)}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        target.style.display = 'none';
                      }}
                    />
                    <div className="absolute inset-0 bg-black/10 flex items-center justify-center">
                      <span className="text-[10px]">{file.split('.')[0]}</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-fg-muted">
                <p>{t('no_sticker_packs')}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
