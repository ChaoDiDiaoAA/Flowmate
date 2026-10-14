import { StoredCandidateDraftSchema, type StoredInvoiceField } from '@flowmate/contracts';
import { parseDecimal, toDecimalString } from '@flowmate/shared';
import type { EvaluationContext } from '../types.ts';

const valuesSchema = StoredCandidateDraftSchema.pick({fields:true,lines:true});
const numericFields = new Set(['quantity','unitPrice','netAmount','taxRate','taxAmount','totalAmount']);
export function candidateValues(context: EvaluationContext) {
    const fact = context.result.evidence['candidate-values'];
    return fact ? valuesSchema.parse(fact.actual) : undefined;
}
export function invoiceValueEquals(key: string, actual: unknown, expected: unknown, field?: StoredInvoiceField) {
    if (field && field.state!=='present') return false;
    if (!numericFields.has(key)) return actual===expected;
    if (field && field.normalized===null || typeof actual!=='string' || typeof expected!=='string') return false;
    const left=parseDecimal(actual.trim()), right=parseDecimal(expected.trim());
    const normalized=field?.normalized===undefined ? left : parseDecimal(field.normalized!);
    return !!left && !!right && !!normalized && toDecimalString(left)===toDecimalString(normalized) && toDecimalString(left)===toDecimalString(right);
}
