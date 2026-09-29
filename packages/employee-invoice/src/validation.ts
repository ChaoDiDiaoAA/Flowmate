import type {
  CandidateDraft,
  CheckResult,
  InvoiceField,
  InvoiceIssue,
  InvoiceToolInput,
  InvoiceToolOutput,
} from '@flowmate/contracts';
import { absoluteDecimalAtMost, addDecimal, multiplyDecimal, parseDecimal, roundDecimal, subtractDecimal, taxAmount, toDecimalString } from '@flowmate/shared';

const currencyScales: Readonly<Record<string, number>> = { CNY: 2, USD: 2, EUR: 2, GBP: 2, JPY: 0, KWD: 3, BHD: 3 };
const requiredHeader: ReadonlyArray<keyof CandidateDraft['fields']> = [
  'invoiceNumber', 'issueDate', 'sellerName', 'buyerName', 'currency', 'totalAmount',
];
const amountFields = new Set(['netAmount', 'taxAmount', 'totalAmount', 'quantity', 'unitPrice', 'taxRate']);

export function normalizeInvoiceValues(input: InvoiceToolInput<'normalize_invoice_values'>): InvoiceToolOutput<'normalize_invoice_values'> {
  return { items: input.items.map(({ kind, raw }, index) => {
    const text = raw.trim();
    if (kind === 'decimal') {
      const value = parseDecimal(text);
      return value
        ? { index, kind, raw, status: 'normalized' as const, value: toDecimalString(value), alternatives: [], reason: null }
        : { index, kind, raw, status: 'unsupported' as const, value: null, alternatives: [], reason: 'unsupported_decimal' };
    }
    if (kind === 'currency') {
      const code = /^[A-Za-z]{3}$/.test(text) ? text.toUpperCase() : '';
      return code && currencyScales[code] !== undefined
        ? { index, kind, raw, status: 'normalized' as const, value: code, alternatives: [], reason: null }
        : { index, kind, raw, status: 'unsupported' as const, value: null, alternatives: [], reason: 'unsupported_currency' };
    }
    const parsedDate = parseDate(text);
    if (parsedDate.kind === 'valid') {
      return { index, kind, raw, status: 'normalized' as const, value: parsedDate.value, alternatives: [], reason: null };
    }
    if (parsedDate.kind === 'ambiguous') {
      return { index, kind, raw, status: 'ambiguous' as const, value: null, alternatives: parsedDate.values, reason: 'ambiguous_date_order' };
    }
    return { index, kind, raw, status: 'unsupported' as const, value: null, alternatives: [], reason: 'unsupported_date' };
  }) };
}

export function calculateInvoiceAmounts(input: InvoiceToolInput<'calculate_invoice_amounts'>): InvoiceToolOutput<'calculate_invoice_amounts'> {
  const exact = input.operation === 'sum' ? addDecimal(input.values)
    : input.operation === 'product' ? multiplyDecimal(input.quantity, input.unitPrice)
      : taxAmount(input.netAmount, input.taxRate);
  return { operation: input.operation, exact, rounded: input.scale === null ? null : roundDecimal(exact, input.scale),
    scale: input.scale, rounding: input.scale === null ? null : 'half_away_from_zero' };
}

export function evaluateCandidate(candidate: CandidateDraft,
  sourceResults: readonly InvoiceToolOutput<'check_invoice_sources'>['results'][number][]): {
    violations: { code: string; fieldPaths: string[] }[]; checks: CheckResult[]; issues: InvoiceIssue[];
  } {
  const violations: { code: string; fieldPaths: string[] }[] = [];
  const checks: CheckResult[] = [];
  const issues: InvoiceIssue[] = candidate.notes.map((message) => ({
    code: 'model_note', severity: 'warning', origin: 'model', fieldPaths: [], message, rule: null,
  }));
  const fields = candidateFields(candidate);
  const sources = fields.flatMap(({ value }) => value.sources);
  const badSourcePaths: string[] = [];
  let validSourceCount = 0;
  let unverifiedSourceCount = 0;
  let sourceCursor = 0;

  for (const field of fields) {
    const { path, name, value } = field;
    if (value.raw !== null && !value.raw.trim()) addViolation(violations, 'field_value_blank', [path]);
    if (value.normalized !== null && !value.normalized.trim()) addViolation(violations, 'normalized_value_blank', [path]);
    if (value.state === 'present') {
      if (value.raw === null || !value.raw.trim()) addViolation(violations, 'present_value_missing', [path]);
      if (value.sources.length === 0) addViolation(violations, 'present_source_missing', [path]);
      if (value.normalized === null) addIssue(issues, 'normalization_unresolved', 'warning', [path], 'No normalized value is available.', null);
    } else {
      if (value.normalized !== null) addViolation(violations, 'non_present_value_normalized', [path]);
      if ((value.state === 'missing' || value.state === 'not_applicable') && value.alternatives.length > 0) {
        addViolation(violations, 'alternatives_not_allowed', [path]);
      }
      if (value.state === 'ambiguous' && value.alternatives.length < 2) addViolation(violations, 'ambiguous_alternatives_missing', [path]);
      if (value.state === 'not_applicable') {
        const indicated = candidate.notes.some((note) => note.toLowerCase().includes(name.toLowerCase())
          && note.trim().length > name.length + 1);
        if (!indicated) addViolation(violations, 'not_applicable_reason_missing', [path]);
      }
    }

    if (value.state === 'present' && value.normalized !== null) {
      if (name === 'issueDate' || name.endsWith('.issueDate')) {
        if (!isIsoDate(value.normalized)) addViolation(violations, 'date_format_invalid', [path]);
        const rawDate = value.raw === null ? null : parseDate(value.raw.trim());
        if (rawDate?.kind === 'ambiguous') addIssue(issues, 'ambiguous_normalization', 'warning', [path], 'The source date has more than one valid order.', 'date-format');
      }
      if (isAmountPath(name) && parseDecimal(value.normalized) === null) {
        addViolation(violations, 'decimal_format_invalid', [path]);
      }
      if (isAmountPath(name) && value.raw !== null && parseDecimal(value.normalized) !== null) {
        const raw = interpretRawDecimal(value.raw);
        if (raw?.kind === 'ambiguous') addIssue(issues, 'ambiguous_normalization', 'warning', [path], 'The raw number has more than one reasonable decimal interpretation.', 'raw-normalization');
        else if (raw?.kind === 'value' && canonical(raw.value) !== canonical(value.normalized)) {
          addIssue(issues, 'normalization_mismatch', 'warning', [path], 'The normalized value differs from the unambiguous raw number.', 'raw-normalization');
        }
      }
    }

    for (const _source of value.sources) {
      const result = sourceResults[sourceCursor++];
      if (!result) {
        badSourcePaths.push(path);
      } else if (result.status === 'valid') {
        validSourceCount += 1;
      } else if (result.status === 'invalid') {
        badSourcePaths.push(path);
      } else {
        unverifiedSourceCount += 1;
        addIssue(issues, 'image_quote_unverified', 'warning', [path], 'The original-image quote was delivered but its visual meaning is not verified.', 'source-reference');
      }
    }
  }

  if (badSourcePaths.length > 0) addViolation(violations, 'source_invalid', badSourcePaths);
  const allSourcesAccounted = sourceResults.length === sources.length && validSourceCount + unverifiedSourceCount === sources.length;
  checks.push(check('source-reference', sources.length === 0 ? 'not_applicable' : !allSourcesAccounted || badSourcePaths.length > 0 ? 'failed'
    : unverifiedSourceCount > 0 ? 'not_evaluable' : 'passed',
  unique(sources.length === 0 ? fields.filter(({ value }) => value.state === 'present').map(({ path }) => path) : badSourcePaths),
  null, null, null, null, sources.length === 0 ? 'present_source_missing' : null));

  const missingRequired = requiredHeader.filter((name) => candidate.fields[name].state === 'missing'
    || candidate.fields[name].state === 'unreadable' || candidate.fields[name].state === 'ambiguous'
    || candidate.fields[name].state === 'not_applicable');
  for (const name of missingRequired) {
    const field = candidate.fields[name];
    addIssue(issues, field.state === 'ambiguous' ? 'required_header_ambiguous' : 'required_header_missing',
      'warning', [`/fields/${name}`], `Required header field ${name} is ${field.state}.`, 'required-header');
  }
  checks.push(check('required-header', missingRequired.length ? 'failed' : 'passed',
    missingRequired.map((name) => `/fields/${name}`), null, null, null, null,
    missingRequired.length ? 'one_or_more_required_fields_unavailable' : null));

  const precision = candidate.fields.currency.normalized === null ? null : currencyScales[candidate.fields.currency.normalized.toUpperCase()] ?? null;
  if (candidate.fields.currency.state === 'present' && candidate.fields.currency.normalized !== null && precision === null) {
    addIssue(issues, 'currency_precision_unsupported', 'warning', ['/fields/currency'], 'The currency is retained, but its minor-unit precision is not configured.', null);
  }
  checks.push(numericCheck(candidate.fields.netAmount.normalized, candidate.fields.taxAmount.normalized,
    candidate.fields.totalAmount.normalized, precision, 'header-total', ['/fields/netAmount', '/fields/taxAmount', '/fields/totalAmount'],
    'header_total_mismatch', issues));

  for (const [index, line] of candidate.lines.entries()) {
    const prefix = `/lines/${index}`;
    checks.push(binaryCheck(line.quantity.normalized, line.unitPrice.normalized, line.netAmount.normalized, precision,
      'line-net', [`${prefix}/quantity`, `${prefix}/unitPrice`, `${prefix}/netAmount`], 'line_net_mismatch', issues,
      (left, right) => multiplyDecimal(left, right)));
    checks.push(binaryCheck(line.netAmount.normalized, line.taxRate.normalized, line.taxAmount.normalized, precision,
      'line-tax', [`${prefix}/netAmount`, `${prefix}/taxRate`, `${prefix}/taxAmount`], 'line_tax_mismatch', issues,
      (left, right) => taxAmount(left, right)));
    checks.push(binaryCheck(line.netAmount.normalized, line.taxAmount.normalized, line.totalAmount.normalized, precision,
      'line-total', [`${prefix}/netAmount`, `${prefix}/taxAmount`, `${prefix}/totalAmount`], 'line_total_mismatch', issues,
      addDecimalPair));
  }

  if (candidate.lines.length === 0 || precision === null
    || candidate.lines.some((line) => line.netAmount.normalized === null)
    || candidate.fields.netAmount.normalized === null) {
    checks.push(check('lines-net-total', 'not_evaluable', ['/fields/netAmount', ...candidate.lines.map((_, index) => `/lines/${index}/netAmount`)],
      candidate.fields.netAmount.normalized, null, null, precision === null ? null : unit(precision), 'missing_amount_or_currency_precision'));
  } else {
    const expected = roundDecimal(addDecimal(candidate.lines.map((line) => line.netAmount.normalized!)), precision);
    checks.push(compareCheck('lines-net-total', candidate.fields.netAmount.normalized, expected, precision,
      ['/fields/netAmount', ...candidate.lines.map((_, index) => `/lines/${index}/netAmount`)], 'lines_net_total_mismatch', issues));
  }

  return { violations: uniqueViolations(violations), checks, issues: uniqueIssues(issues) };
}

function candidateFields(candidate: CandidateDraft): { path: string; name: string; value: InvoiceField }[] {
  const header = Object.entries(candidate.fields).map(([name, value]) => ({ path: `/fields/${name}`, name, value }));
  const lines = candidate.lines.flatMap((line, index) => Object.entries(line).map(([name, value]) => ({
    path: `/lines/${index}/${name}`, name: `lines.${name}`, value,
  })));
  return [...header, ...lines];
}

function numericCheck(actual: string | null, addend: string | null, observed: string | null, precision: number | null,
  rule: string, paths: string[], issueCode: string, issues: InvoiceIssue[]): CheckResult {
  if (precision === null || actual === null || addend === null || observed === null) {
    return check(rule, 'not_evaluable', paths, observed, null, null, precision === null ? null : unit(precision),
      precision === null ? 'currency_precision_unavailable' : 'required_amount_unavailable');
  }
  return compareCheck(rule, observed, roundDecimal(addDecimal([actual, addend]), precision), precision, paths, issueCode, issues);
}

function binaryCheck(left: string | null, right: string | null, actual: string | null, precision: number | null,
  rule: string, paths: string[], issueCode: string, issues: InvoiceIssue[], calculate: (left: string, right: string) => string): CheckResult {
  if (precision === null || left === null || right === null || actual === null) {
    return check(rule, 'not_evaluable', paths, actual, null, null, precision === null ? null : unit(precision),
      precision === null ? 'currency_precision_unavailable' : 'required_amount_unavailable');
  }
  return compareCheck(rule, actual, roundDecimal(calculate(left, right), precision), precision, paths, issueCode, issues);
}

function compareCheck(rule: string, actual: string, expected: string, precision: number, paths: string[], issueCode: string,
  issues: InvoiceIssue[]): CheckResult {
  const difference = roundDecimal(subtractDecimal(actual, expected), precision);
  const tolerance = unit(precision);
  const passed = absoluteDecimalAtMost(difference, tolerance);
  if (!passed) addIssue(issues, issueCode, 'error', paths, `${rule} differs from its calculated value.`, rule);
  return check(rule, passed ? 'passed' : 'failed', paths, actual, expected, difference, tolerance, null);
}

function check(rule: string, status: CheckResult['status'], paths: string[], actual: string | null, expected: string | null,
  difference: string | null, tolerance: string | null, reason: string | null): CheckResult {
  return { rule, version: '1', status, fieldPaths: paths, actual, expected, difference, tolerance, reason };
}

function unit(scale: number): string {
  return scale === 0 ? '1' : `0.${'0'.repeat(scale - 1)}1`;
}

function isAmountPath(name: string): boolean {
  const leaf = name.split('.').at(-1) ?? name;
  return amountFields.has(leaf);
}

function canonical(value: string): string {
  const parsed = parseDecimal(value);
  return parsed === null ? value : toDecimalString(parsed);
}

function addDecimalPair(left: string, right: string): string { return addDecimal([left, right]); }

function interpretRawDecimal(value: string): { kind: 'value'; value: string } | { kind: 'ambiguous' } | null {
  const raw = value.trim();
  const direct = parseDecimal(raw);
  if (direct) return { kind: 'value', value: toDecimalString(direct) };
  const sign = raw.startsWith('-') ? '-' : '';
  const unsigned = sign ? raw.slice(1) : raw;
  if (/^[0-9]{1,3}(?:,[0-9]{3})+\.[0-9]{1,6}$/.test(unsigned)) {
    return { kind: 'value', value: `${sign}${unsigned.replaceAll(',', '')}` };
  }
  if (/^[0-9]{1,3}(?:\.[0-9]{3})+,[0-9]{1,6}$/.test(unsigned)) {
    return { kind: 'value', value: `${sign}${unsigned.replaceAll('.', '').replace(',', '.')}` };
  }
  if (/^[0-9]+,[0-9]+$/.test(unsigned)) {
    return unsigned.split(',')[1]?.length === 3 ? { kind: 'ambiguous' }
      : { kind: 'value', value: `${sign}${unsigned.replace(',', '.')}` };
  }
  if (/^[0-9]{1,3}(?:,[0-9]{3})+$/.test(unsigned)) return { kind: 'ambiguous' };
  return null;
}

function parseDate(value: string): { kind: 'valid'; value: string } | { kind: 'ambiguous'; values: string[] } | { kind: 'invalid' } {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso && validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))) return { kind: 'valid', value };
  const chinese = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(value);
  if (chinese && validDate(Number(chinese[1]), Number(chinese[2]), Number(chinese[3]))) {
    return { kind: 'valid', value: formatDate(Number(chinese[1]), Number(chinese[2]), Number(chinese[3])) };
  }
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (slash) {
    const first = Number(slash[1]); const second = Number(slash[2]); const year = Number(slash[3]);
    const alternatives = [
      validDate(year, first, second) ? formatDate(year, first, second) : null,
      validDate(year, second, first) ? formatDate(year, second, first) : null,
    ].filter((item): item is string => item !== null);
    const uniqueAlternatives = [...new Set(alternatives)].sort(compareCodePoints);
    if (uniqueAlternatives.length > 1) return { kind: 'ambiguous', values: uniqueAlternatives };
    if (uniqueAlternatives.length === 1) return { kind: 'valid', value: uniqueAlternatives[0]! };
  }
  return { kind: 'invalid' };
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match !== null && validDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day >= 1 && day <= days;
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (value) => value.codePointAt(0)!);
  const b = Array.from(right, (value) => value.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

function addViolation(target: { code: string; fieldPaths: string[] }[], code: string, paths: string[]): void {
  target.push({ code, fieldPaths: unique(paths) });
}

function addIssue(target: InvoiceIssue[], code: string, severity: InvoiceIssue['severity'], paths: string[], message: string, rule: string | null): void {
  target.push({ code, severity, origin: 'rule', fieldPaths: unique(paths), message, rule });
}

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }

function uniqueViolations(values: { code: string; fieldPaths: string[] }[]): { code: string; fieldPaths: string[] }[] {
  const keyed = new Map<string, { code: string; fieldPaths: string[] }>();
  for (const item of values) {
    const existing = keyed.get(item.code);
    if (existing) existing.fieldPaths = unique([...existing.fieldPaths, ...item.fieldPaths]);
    else keyed.set(item.code, { code: item.code, fieldPaths: unique(item.fieldPaths) });
  }
  return [...keyed.values()];
}

function uniqueIssues(values: InvoiceIssue[]): InvoiceIssue[] {
  const keyed = new Map<string, InvoiceIssue>();
  for (const item of values) keyed.set(`${item.origin}:${item.code}:${item.rule ?? ''}:${item.fieldPaths.join(',')}:${item.message}`, item);
  return [...keyed.values()];
}
