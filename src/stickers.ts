/**
 * Система стикеров WhisperNet.
 *
 * Стикеры хранятся локально на устройстве и передаются в чаты как URL на
 * встроенный эндпоинт `/api/sticker/<pack>/<file>`. Сервер отдаёт файл как
 * статический ассет — шифрование не требуется, потому что стикер — это
 * публичный образ, а не личное сообщение.
 *
 * Пачка стикеров — это директория в `DATA_DIR/stickers/<pack>/` с PNG-файлами
 * и файлом `manifest.json`:
 *   {
 *     "name": "Пакет названия",
 *     "emoji": "😀",
 *     "stickers": ["file1.png", "file2.png"]
 *   }
 */

import path from 'path';
import fs from 'fs';

export interface StickerPack {
  id: string;
  name: string;
  emoji: string;
  stickers: string[];
}

const DEFAULT_PACKS: StickerPack[] = [
  {
    id: 'classic',
    name: 'Classic',
    emoji: '😀',
    stickers: [
      'smile.png', 'laugh.png', 'love.png', 'wow.png',
      'sad.png', 'angry.png', 'cool.png', 'party.png',
    ],
  },
  {
    id: 'reactions',
    name: 'Reactions',
    emoji: '👍',
    stickers: [
      'thumbsup.png', 'thumbsdown.png', 'clap.png', 'fire.png',
      'heart.png', 'laugh.png', 'surprised.png', 'sad.png',
    ],
  },
];

let stickersDir: string | null = null;

export function setStickersDir(dir: string): void {
  stickersDir = dir;
}

export function getStickersDir(): string | null {
  return stickersDir;
}

export function getStickerPacks(): StickerPack[] {
  if (!stickersDir) return DEFAULT_PACKS;
  const packs: StickerPack[] = [];
  try {
    for (const entry of fs.readdirSync(stickersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(stickersDir, entry.name, 'manifest.json');
      try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<StickerPack> & { id?: string };
        packs.push({
          id: parsed.id || entry.name,
          name: parsed.name || entry.name,
          emoji: parsed.emoji || '📦',
          stickers: Array.isArray(parsed.stickers) ? parsed.stickers : [],
        });
      } catch {
        // пакет без манифеста пропускается
      }
    }
  } catch {
    // директории нет — отдаём дефолт
  }
  return packs.length > 0 ? packs : DEFAULT_PACKS;
}

export function stickerUrl(packId: string, file: string): string {
  return `/api/sticker/${packId}/${encodeURIComponent(file)}`;
}
