import { useEffect, useRef, useState, type RefObject } from 'react';
import type { InputCommandItem } from '@flowmate/contracts';
import { skillIntroduction } from './skill-introductions.ts';

const introduction = (item: InputCommandItem) => item.group === 'Skills' ? skillIntroduction(item.description) : item.description;

export function InputCommands({ input, onChange, onSend, composerRef, sessionId, ready, busy }: {
  input: string; onChange(text: string): void; onSend(): void; composerRef: RefObject<HTMLTextAreaElement | null>;
  sessionId: number | null; ready: boolean; busy: boolean;
}) {
  const [items, setItems] = useState<readonly InputCommandItem[]>([]), [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false), [error, setError] = useState<string | null>(null);
  const reads = useRef(0), alive = useRef(true), composing = useRef(false);
  const query = input.startsWith('/') && !/\s/.test(input) ? input.slice(1).toLowerCase() : null;
  const matches = query === null ? [] : items.filter(item => item.text.toLowerCase().includes(query));
  const open = matches.length > 0 && !dismissed;
  useEffect(() => { alive.current = true; return () => { alive.current = false; reads.current++; }; }, []);
  useEffect(() => { setDismissed(false); setSelected(0); }, [input]);
  useEffect(() => {
    const token = ++reads.current; setItems([]); setError(null);
    if (query === null || !ready) return;
    void window.flowmate.listInputCommands(sessionId ? { sessionId } : {}).then(result => {
      if (!alive.current || reads.current !== token) return;
      if (result.ok) setItems(result.data); else setError(result.error.message);
    }).catch(() => { if (alive.current && reads.current === token) setError('Input commands are unavailable. Your draft is retained.'); });
  }, [query !== null, sessionId, ready]);
  function choose(item: InputCommandItem) {
    if (!item.available || busy && item.group !== 'Skills') return;
    onChange(item.text); setDismissed(true); composerRef.current?.focus();
  }
  return <><label className="sr-only" htmlFor="agent-chat-input">Message to model</label>
    <textarea ref={composerRef} id="agent-chat-input" aria-label="Message to model" value={input}
      aria-expanded={open} aria-controls={open ? 'input-command-list' : undefined}
      aria-activedescendant={open ? `input-command-${selected}` : undefined}
      onChange={event => onChange(event.target.value)} onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing) return;
        if (open && ['ArrowDown', 'ArrowUp', 'Escape', 'Enter'].includes(event.key) && !event.shiftKey) {
          event.preventDefault(); event.stopPropagation();
          if (event.key === 'Escape') setDismissed(true);
          else if (event.key === 'Enter') { if (matches[selected]) choose(matches[selected]!); }
          else setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
        } else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend(); }
      }} placeholder="Write a message…" rows={3} />
    {error && <p role="alert">{error}</p>}
    {open && <div id="input-command-list" role="listbox" aria-label="Input commands" className="input-command-list">
      {matches.map((item, index) => <div key={item.group+item.name}>
        {(index === 0 || matches[index-1]?.group !== item.group) && <h4>{item.group}</h4>}
        <button id={`input-command-${index}`} type="button" role="option" aria-selected={selected === index}
          aria-disabled={!item.available || busy && item.group !== 'Skills'} onClick={() => choose(item)}
          className={selected === index ? 'selected' : ''} title={[introduction(item), item.reason].filter(Boolean).join('\n')}>
          <strong>{item.text}</strong><span>{introduction(item)}</span>
          <small>{!item.available ? item.reason : busy && item.group !== 'Skills' ? 'Wait for this Run to stop.'
            : item.assembled ? 'Registered in this session' : 'Configured · verified on send'}</small>
        </button></div>)}
    </div>}
  </>;
}
