import { useState } from 'react';
import type { AvatarUpdate } from '../types';
import { cn, avatarUrl, getAvatarText, getAvatarGradient } from '../utils';

export function Avatar({ userId, nickname, avatar, className, textClassName = 'text-[11px]' }: {
  userId: string;
  nickname: string;
  avatar?: AvatarUpdate | null;
  className?: string;
  textClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = avatarUrl(userId, avatar?.ext, avatar?.updatedAt);
  const showImg = !!src && !failed;
  return (
    <div className={cn('overflow-hidden flex items-center justify-center flex-shrink-0', className)}>
      {showImg ? (
        <img
          src={src as string}
          alt=""
          className="w-full h-full object-cover"
          onError={() => setFailed(true)}
          draggable={false}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center"
          style={{ background: getAvatarGradient(nickname) }}>
          <span className={cn('font-bold text-white select-none', textClassName)}>
            {getAvatarText(nickname)}
          </span>
        </div>
      )}
    </div>
  );
}