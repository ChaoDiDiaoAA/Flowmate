import { appError, fail, ok } from '@flowmate/contracts';

export function researchExcerpt(text: string, offset: number, limit: number) {
    const splitsPair = (at: number) => at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= text.length || splitsPair(offset) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 4000)
        return fail(appError('input_invalid', 'input', 'Evidence offset or UTF-16 limit is invalid.'));
    let end = Math.min(text.length, offset + limit);
    if (splitsPair(end)) end--;
    if (end === offset) return fail(appError('input_invalid', 'input', 'Evidence limit cannot fit the next UTF-16 character.'));
    return ok({ excerpt: { start: offset, end, quote: text.slice(offset, end) }, nextOffset: end < text.length ? end : null });
}
