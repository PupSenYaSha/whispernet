import type { Message } from '../types';
import { useConnection } from '../context';
import { cn, formatTime, getAvatarText } from '../utils';

export function MessageItem({ message, showAvatar = true }: { message: Message; showAvatar?: boolean }) {
  const { state, deleteMessage: deleteMsg, t } = useConnection();
  const isSystem = message.senderId === 'system';
  const isOwn = message.isOwn;

  const fontSizeClass = state.settings.fontSize === 'small' ? 'text-[13px]'
    : state.settings.fontSize === 'large' ? 'text-[17px]'
    : 'text-[15px]';

  if (isSystem) {
    return (
      <div className="flex items-center justify-center py-2">
        <span className="px-4 py-1.5 rounded-full bg-bg-tertiary/60 text-[12px] font-medium text-fg-muted">
          {message.text}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex gap-2.5 px-4 animate-message ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
      {!isOwn && showAvatar && (
        <div className="flex-shrink-0 w-9 h-9 rounded-full bg-accent-primary/15 flex items-center justify-center mt-1">
          <span className="text-[11px] font-bold text-accent-primary">
            {getAvatarText(message.senderNickname)}
          </span>
        </div>
      )}
      {!isOwn && !showAvatar && <div className="w-9" />}

      <div className={`flex flex-col max-w-[78%] ${isOwn ? 'items-end' : 'items-start'}`}>
        {!isOwn && showAvatar && (
          <span className="text-[12px] font-semibold text-accent-primary mb-1 px-1">
            {message.senderNickname}
          </span>
        )}

        <div className={cn(
          'px-3.5 py-2.5 leading-relaxed group relative',
          fontSizeClass,
          isOwn
            ? 'bg-bubble-mine text-bubble-mine-text rounded-2xl rounded-br-sm'
            : 'bg-bubble-other text-bubble-other-text border border-border-default rounded-2xl rounded-bl-sm'
        )}>
          {isOwn && (
            <button onClick={() => deleteMsg(message.id)}
              className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-bg-tertiary border border-border-default flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-status-error/20"
              title={t('delete')}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-fg-muted">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
          {(() => {
            const mediaMatch = message.text.match(/^\[(image|video)\]([\s\S]*?)\[\/\1\]/);
            if (mediaMatch) {
              const [, tag, url] = mediaMatch;
              const safeUrl = /^(https?:\/\/)/i.test(url) ? url : null;
              if (!safeUrl) {
                return <p className="whitespace-pre-wrap break-words text-status-error text-[13px]">Invalid URL</p>;
              }
              if (tag === 'video') {
                const proxyUrl = `/api/media?url=${encodeURIComponent(safeUrl)}`;
                return (
                  <video src={proxyUrl} controls
                    className="rounded-xl max-w-[340px] max-h-[340px] cursor-pointer" />
                );
              }
              return (
                <img src={safeUrl} alt=""
                  className="rounded-xl max-w-[300px] max-h-[300px] object-cover cursor-pointer"
                  onClick={() => { window.open(safeUrl, '_blank', 'noopener,noreferrer'); }} />
              );
            }
            return <p className="whitespace-pre-wrap break-words">{message.text}</p>;
          })()}
        </div>

        <span className="text-[10px] text-fg-subtle mt-1 px-1">
          {formatTime(message.timestamp)}
        </span>
      </div>
    </div>
  );
}
