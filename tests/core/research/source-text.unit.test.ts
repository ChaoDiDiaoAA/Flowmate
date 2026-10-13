import { expect, test } from 'bun:test';
import { researchExcerpt } from '../../../packages/core/src/research/source-text.ts';

test('research excerpts fit the UTF-16 limit and never split a surrogate pair', () => {
    const text = 'a'.repeat(3999) + '😀tail';
    const first = researchExcerpt(text, 0, 4000);
    expect(first).toMatchObject({ ok: true, data: { excerpt: { start: 0, end: 3999, quote: 'a'.repeat(3999) }, nextOffset: 3999 } });
    const next = researchExcerpt(text, 3999, 4000);
    expect(next).toMatchObject({ ok: true, data: { excerpt: { start: 3999, end: text.length, quote: '😀tail' }, nextOffset: null } });
    if (first.ok && next.ok) expect(first.data.excerpt.quote + next.data.excerpt.quote).toBe(text);
    expect(researchExcerpt(text, 4000, 4000)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(researchExcerpt(text, 3999, 1)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(researchExcerpt(text, 3999, 2)).toMatchObject({ ok: true, data: { excerpt: { quote: '😀', end: 4001 }, nextOffset: 4001 } });
    expect(researchExcerpt(text, text.length, 4000)).toMatchObject({ ok: false });
});
