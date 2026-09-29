export type Decimal = { coefficient: bigint; scale: number };

const DECIMAL_PATTERN = /^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/;

export function parseDecimal(value: string): Decimal | null {
  if (!DECIMAL_PATTERN.test(value)) return null;
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  let coefficient = BigInt(`${whole}${fraction}`);
  if (negative) coefficient = -coefficient;
  return normalize({ coefficient, scale: fraction.length });
}

export function toDecimalString(value: Decimal): string {
  const normalized = normalize(value);
  const negative = normalized.coefficient < 0n;
  const digits = String(negative ? -normalized.coefficient : normalized.coefficient).padStart(normalized.scale + 1, '0');
  const whole = normalized.scale === 0 ? digits : digits.slice(0, -normalized.scale);
  const fraction = normalized.scale === 0 ? '' : `.${digits.slice(-normalized.scale)}`;
  const result = `${negative ? '-' : ''}${whole}${fraction}`;
  if (result.length > 128) throw new RangeError('decimal_result_too_large');
  return result;
}

export function addDecimal(values: readonly string[]): string {
  if (values.length === 0) throw new RangeError('decimal_values_required');
  const decimals = values.map(requireDecimal);
  const scale = Math.max(...decimals.map((value) => value.scale));
  const coefficient = decimals.reduce((sum, value) => sum + value.coefficient * power10(scale - value.scale), 0n);
  return toDecimalString({ coefficient, scale });
}

export function multiplyDecimal(left: string, right: string): string {
  const a = requireDecimal(left);
  const b = requireDecimal(right);
  return toDecimalString({ coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale });
}

export function subtractDecimal(left: string, right: string): string {
  const value = requireDecimal(right);
  return addDecimal([left, toDecimalString({ coefficient: -value.coefficient, scale: value.scale })]);
}

export function absoluteDecimalAtMost(value: string, limit: string): boolean {
  const left = requireDecimal(value);
  const right = requireDecimal(limit);
  const scale = Math.max(left.scale, right.scale);
  const a = left.coefficient * power10(scale - left.scale);
  const b = right.coefficient * power10(scale - right.scale);
  return (a < 0n ? -a : a) <= (b < 0n ? -b : b);
}

export function taxAmount(netAmount: string, taxRate: string): string {
  const a = requireDecimal(netAmount);
  const b = requireDecimal(taxRate);
  const amount = { coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale };
  return toDecimalString({ coefficient: amount.coefficient, scale: amount.scale + 2 });
}

export function roundDecimal(value: string, scale: number): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) throw new RangeError('decimal_scale_invalid');
  const parsed = requireDecimal(value);
  const rounded = round(parsed, scale);
  const coefficient = rounded.coefficient * power10(scale - rounded.scale);
  const negative = coefficient < 0n;
  const digits = String(negative ? -coefficient : coefficient).padStart(scale + 1, '0');
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? '' : `.${digits.slice(-scale)}`;
  const result = `${negative ? '-' : ''}${whole}${fraction}`;
  if (result.length > 128) throw new RangeError('decimal_result_too_large');
  return result;
}

function requireDecimal(value: string): Decimal {
  const parsed = parseDecimal(value);
  if (!parsed) throw new RangeError('decimal_invalid');
  return parsed;
}

function round(value: Decimal, scale: number): Decimal {
  if (value.scale <= scale) return { coefficient: value.coefficient, scale: value.scale };
  const divisor = power10(value.scale - scale);
  const negative = value.coefficient < 0n;
  const absolute = negative ? -value.coefficient : value.coefficient;
  let quotient = absolute / divisor;
  if ((absolute % divisor) * 2n >= divisor) quotient += 1n;
  return normalize({ coefficient: negative ? -quotient : quotient, scale });
}

function normalize(value: Decimal): Decimal {
  if (!Number.isInteger(value.scale) || value.scale < 0 || value.scale > 64) throw new RangeError('decimal_scale_invalid');
  let { coefficient, scale } = value;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return coefficient === 0n ? { coefficient: 0n, scale: 0 } : { coefficient, scale };
}

function power10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}
