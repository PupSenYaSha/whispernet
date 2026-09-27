import { useEffect, useRef } from 'react';

type Entry = { layer: number; order: number; handleWhileTyping: boolean; run: () => void };

const stack: Entry[] = [];
let seq = 0;
let bound = false;

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || stack.length === 0) return;
  const target = e.target as HTMLElement | null;
  const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  let top = stack[0];
  for (const entry of stack) {
    if (entry.layer >= top.layer) top = entry;
  }
  if (typing && !top.handleWhileTyping) return;
  e.preventDefault();
  e.stopPropagation();
  top.run();
}

function ensureBound(): void {
  if (bound) return;
  bound = true;
  document.addEventListener('keydown', onKeyDown, true);
}

/**
 * Escape-обработчик с приоритетом по слою: срабатывает только самый верхний
 * активный слой (z-index), поэтому вложенные окна не закрывают родительские.
 */
export function useEscapeKey(onEscape: () => void, active = true, layer = 0, handleWhileTyping = true): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!active) return;
    ensureBound();
    const entry: Entry = { layer, order: seq++, handleWhileTyping, run: () => ref.current() };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i !== -1) stack.splice(i, 1);
    };
  }, [active, layer, handleWhileTyping]);
}
