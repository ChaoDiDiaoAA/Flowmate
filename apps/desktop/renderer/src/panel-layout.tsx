import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

export const DEFAULT_PANEL_WIDTHS = { sidebar: 240, assistant: 380 };
const MINIMUM = { sidebar: 200, assistant: 300 };
const CENTER_MINIMUM = 360, STORAGE_KEY = 'flowmate.panel-widths';
export type PanelPresentation = 'main' | 'sidebar';

type Widths = typeof DEFAULT_PANEL_WIDTHS;
type Side = keyof Widths;

export function parsePanelWidths(text: string | null): Widths {
  try {
    const value = JSON.parse(text ?? 'null');
    if (value && Number.isSafeInteger(value.sidebar) && value.sidebar >= MINIMUM.sidebar
      && Number.isSafeInteger(value.assistant) && value.assistant >= MINIMUM.assistant)
      return { sidebar: value.sidebar, assistant: value.assistant };
  } catch { /* An optional UI preference must not block startup. */ }
  return { ...DEFAULT_PANEL_WIDTHS };
}

export function fitPanelWidths(preferred: Widths, width: number, collapsed: boolean, presentation: PanelPresentation = 'sidebar'): Widths {
  if (presentation === 'main') return { sidebar: width < 1200 ? 64 : Math.min(preferred.sidebar, width - CENTER_MINIMUM), assistant: 0 };
  if (width < 1080) return { sidebar: 64, assistant: Math.min(380, Math.max(0, width - 64)) };
  let sidebar = width < 1200 ? 64 : preferred.sidebar;
  const assistant = collapsed ? 44 : Math.max(MINIMUM.assistant, Math.min(preferred.assistant, width - sidebar - CENTER_MINIMUM));
  sidebar = Math.min(sidebar, width - assistant - CENTER_MINIMUM);
  return { sidebar, assistant };
}

export function usePanelLayout(collapsed: boolean, presentation: PanelPresentation = 'sidebar') {
  const shellRef = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState(() => {
    try { return parsePanelWidths(localStorage.getItem(STORAGE_KEY)); }
    catch { return { ...DEFAULT_PANEL_WIDTHS }; }
  });
  const [width, setWidth] = useState(() => window.innerWidth), [dragging, setDragging] = useState(false);
  const latest = useRef(preferred);
  const drag = useRef<{ side: Side; x: number; initial: number; pointerId: number; element: HTMLDivElement } | null>(null);
  const fitted = fitPanelWidths(preferred, width, collapsed, presentation);
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(latest.current)); } catch { /* Keep the current layout when storage is unavailable. */ } }
  function release() {
    const current = drag.current; drag.current = null;
    if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  }
  function finish() { if (!drag.current) return; release(); setDragging(false); save(); }
  function finishPointer(event: PointerEvent<HTMLDivElement>) { if (drag.current?.pointerId === event.pointerId) finish(); }
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(Math.floor(entries[0]!.contentRect.width)));
    if (shellRef.current) observer.observe(shellRef.current);
    return () => { observer.disconnect(); release(); };
  }, []);
  useEffect(() => {
    if (drag.current && (width < 1080 || drag.current.side === 'sidebar' && width < 1200 || drag.current.side === 'assistant' && (collapsed || presentation === 'main'))) finish();
  }, [width, collapsed, presentation]);
  function change(side: Side, value: number, persist: boolean) {
    const maximum = Math.max(MINIMUM[side], width - CENTER_MINIMUM - fitted[side === 'sidebar' ? 'assistant' : 'sidebar']);
    // An explicit resize keeps the other visible pane still; hidden widths remain preferences.
    const next = { ...latest.current, ...(side === 'sidebar' && !collapsed && presentation === 'sidebar' ? { assistant: fitted.assistant } : {}),
      ...(side === 'assistant' && width >= 1200 ? { sidebar: fitted.sidebar } : {}),
      [side]: Math.round(Math.max(MINIMUM[side], Math.min(value, maximum))) };
    latest.current = next; setPreferred(next); if (persist) save();
  }
  function start(side: Side, event: PointerEvent<HTMLDivElement>) {
    if (drag.current || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { side, x: event.clientX, initial: fitted[side], pointerId: event.pointerId, element: event.currentTarget };
    setDragging(true);
  }
  function separator(side: Side) {
    return <div key={side} role="separator" tabIndex={0} aria-label={side === 'sidebar' ? 'Resize navigation' : 'Resize Assistant'}
      aria-orientation="vertical" aria-valuemin={MINIMUM[side]} aria-valuemax={width - CENTER_MINIMUM - fitted[side === 'sidebar' ? 'assistant' : 'sidebar']}
      aria-valuenow={fitted[side]} aria-valuetext={`${fitted[side]} pixels`} className={`panel-resizer ${side}`}
      onPointerDown={event => start(side, event)} onPointerMove={event => {
        const current = drag.current;
        if (current?.pointerId === event.pointerId) change(current.side, current.initial + (event.clientX - current.x) * (current.side === 'sidebar' ? 1 : -1), false);
      }} onPointerUp={finishPointer} onPointerCancel={finishPointer} onLostPointerCapture={finishPointer}
      onDoubleClick={() => change(side, DEFAULT_PANEL_WIDTHS[side], true)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
        event.preventDefault();
        change(side, event.key === 'Home' ? DEFAULT_PANEL_WIDTHS[side] : fitted[side] + (event.shiftKey ? 50 : 10)
          * (event.key === 'ArrowRight' ? 1 : -1) * (side === 'sidebar' ? 1 : -1), true);
      }} />;
  }
  return { shellRef, dragging, style: { '--sidebar-width': `${fitted.sidebar}px`, '--assistant-width': `${fitted.assistant}px` } as CSSProperties,
    separators: <>{width >= 1200 && separator('sidebar')}{presentation === 'sidebar' && width >= 1080 && !collapsed && separator('assistant')}</> };
}
