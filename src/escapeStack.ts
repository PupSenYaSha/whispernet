export interface EscapeEntry {
  layer: number;
  handleWhileTyping: boolean;
  run: () => void;
}

const stack: EscapeEntry[] = [];

/** Регистрирует слой и возвращает функцию снятия регистрации. */
export function pushEscapeLayer(entry: EscapeEntry): () => void {
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i !== -1) stack.splice(i, 1);
  };
}

/** Самый верхний активный слой (наибольший layer, при равенстве — последний). */
export function topEscapeLayer(): EscapeEntry | null {
  if (stack.length === 0) return null;
  let top = stack[0];
  for (const entry of stack) {
    if (entry.layer >= top.layer) top = entry;
  }
  return top;
}

export function escapeStackSize(): number {
  return stack.length;
}

export function clearEscapeStack(): void {
  stack.length = 0;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el !== 'object') return false;
  const tag = (el as HTMLElement).tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || !!(el as HTMLElement).isContentEditable;
}
