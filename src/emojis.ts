/**
 * The emoji a reaction offers.
 *
 * Eight was not enough to be worth opening a picker for, so this is grouped the way a picker usually is:
 * the ones people actually reach for first, then faces, then gestures, then the things that turn up in
 * conversation more than anybody expects.
 *
 * Kept as data rather than as buttons in a component so the composer and the message menu stay in step -
 * they used to carry separate lists, and a reaction that appeared in one and not the other read as a bug.
 */
export interface EmojiGroup {
  key: string;
  labelKey: string;
  emojis: string[];
}

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    key: 'frequent',
    labelKey: 'emoji_frequent',
    emojis: ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '🙏', '👌', '✅', '💯', '👀'],
  },
  {
    key: 'smileys',
    labelKey: 'emoji_smileys',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊',
      '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋', '😛', '😜',
      '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶',
      '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒',
      '🤕', '🤢', '🤮', '🥵', '🥶', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '🧐',
    ],
  },
  {
    key: 'gestures',
    labelKey: 'emoji_gestures',
    emojis: [
      '👋', '🤚', '🖐', '✋', '🖖', '👌', '🤌', '🤏', '✌', '🤞', '🤟', '🤘',
      '🤙', '👈', '👉', '👆', '👇', '☝', '👍', '👎', '✊', '👊', '🤛', '🤜',
      '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍', '💅', '🤳', '💪', '🦾', '✋',
    ],
  },
  {
    key: 'hearts',
    labelKey: 'emoji_hearts',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝'],
  },
  {
    key: 'symbols',
    labelKey: 'emoji_symbols',
    emojis: ['✅', '❌', '❗', '❓', '⚠️', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪', '🔺', '🔻', '♻️', '🔁', '🔂', '➕', '➖', '🔗', '💯', '✨', '⭐', '🌟'],
  },
  {
    key: 'objects',
    labelKey: 'emoji_objects',
    emojis: ['🎉', '🎊', '🎈', '🎁', '🏆', '🥇', '⭐', '🔥', '💧', '⚡', '🌈', '☀️', '🌙', '💡', '📌', '📎', '🔒', '🔑', '🛡', '⏰', '📅', '💻', '📱', '☕', '🍕', '🍻', '🌍', '🚀'],
  },
];

/** Everything, flattened, for the quick strip above the groups. */
export const ALL_EMOJI: string[] = Array.from(new Set(EMOJI_GROUPS.flatMap((g) => g.emojis)));

/** The eight offered without opening anything, which is what a single tap reacts with. */
export const QUICK_EMOJI: string[] = EMOJI_GROUPS[0].emojis.slice(0, 8);

export function groupEmoji(emoji: string): EmojiGroup | null {
  return EMOJI_GROUPS.find((g) => g.emojis.includes(emoji)) || null;
}
