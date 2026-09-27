import { useEffect, useRef } from 'react';
import { pushEscapeLayer, topEscapeLayer, isTypingTarget } from './escapeStack';

let bound = false;

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  const top = topEscapeLayer();
  if (!top) return;
  if (isTypingTarget(e.target) && !top.handleWhileTyping) return;
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
    return pushEscapeLayer({ layer, handleWhileTyping, run: () => ref.current() });
  }, [active, layer, handleWhileTyping]);
}
