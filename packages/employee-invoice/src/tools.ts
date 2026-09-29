import { INVOICE_TOOL_NAMES, invoiceToolSchemas } from '@flowmate/contracts';
import type { InvoiceToolInput, InvoiceToolName, InvoiceToolOutput, ProductToolContext, Result, ToolCallContext, ToolDefinition, ToolEffect } from '@flowmate/contracts';
import type { DocumentService, EvidenceService } from '@flowmate/data';
import type { ZodType } from 'zod';
import { CandidateService } from './candidate-service.ts';
import { calculateInvoiceAmounts, normalizeInvoiceValues } from './validation.ts';

type Services = { documents: DocumentService; evidence: EvidenceService; candidates: CandidateService };

function define<Name extends InvoiceToolName>(name: Name, label: string, description: string, effect: ToolEffect,
  executionMode: 'parallel' | 'sequential', execute: (input: InvoiceToolInput<Name>, call: ToolCallContext,
    context: ProductToolContext) => Promise<InvoiceToolOutput<Name>>): ToolDefinition<InvoiceToolInput<Name>, InvoiceToolOutput<Name>> {
  const schema = invoiceToolSchemas[name];
  return { name, version: '1', label, description, effect, executionMode,
    inputSchema: schema.input as ZodType<InvoiceToolInput<Name>>,
    outputSchema: schema.output as ZodType<InvoiceToolOutput<Name>>, execute };
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw result.error;
  return result.data;
}

export function createInvoiceTools(services: Services): ToolDefinition<any, any>[] {
  const tools: ToolDefinition<any, any>[] = [
    define('list_invoice_pages', 'List pages', '列出获准材料的页数、块数和表格数。', 'READ', 'parallel', async (input, _call, context) =>
      unwrap(services.documents.listPages(input, context))),
    define('read_invoice_document', 'Read invoice', '分页读取指定页的完整解析块和来源。', 'READ', 'parallel', async (input, _call, context) =>
      unwrap(services.documents.readPage(input, context))),
    define('search_invoice_document', 'Search invoice', '在获准解析文本中做区分大小写的字面搜索。', 'READ', 'parallel', async (input, _call, context) =>
      unwrap(services.documents.search(input, context))),
    define('list_invoice_tables', 'List tables', '列出已有 table 解析块，不推断行列结构。', 'READ', 'parallel', async (input, _call, context) =>
      unwrap(services.documents.listTables(input, context))),
    define('read_invoice_evidence', 'Read evidence', '读取解析证据或返回获准原图的受管引用。', 'READ', 'parallel', async (input, call, context) =>
      unwrap(services.evidence.read(input, { ...context, ...call }))),
    define('check_invoice_sources', 'Check sources', '检查候选来源的版本、范围、块和原文引用。', 'READ', 'parallel', async (input, call, context) =>
      unwrap(services.evidence.checkSources(input, { ...context, ...call }))),
    define('normalize_invoice_values', 'Normalize values', '保守规范数字、日期或币种文本，不建立票面事实。', 'PURE', 'parallel', async (input) =>
      normalizeInvoiceValues(input)),
    define('calculate_invoice_amounts', 'Calculate amounts', '以精确十进制计算限定的合计、乘积或税额。', 'PURE', 'parallel', async (input) =>
      calculateInvoiceAmounts(input)),
    define('validate_invoice_candidate', 'Validate candidate', '只读检查候选的来源、字段状态和金额规则。', 'READ', 'parallel', async (input, call, context) =>
      unwrap(await services.candidates.validate(input, call, context))),
    define('list_invoice_candidates', 'List candidates', '分页列出当前可信 Run 所属 Job 的候选。', 'READ', 'parallel', async (input, _call, context) =>
      unwrap(services.candidates.listForRun(input, context))),
    define('get_invoice_candidate', 'Get candidate', '读取当前 Run 所属 Job 下不可变候选详情。', 'READ', 'parallel', async (input, _call, context) =>
      unwrap(services.candidates.readForRun(input, context))),
    define('compare_invoice_candidates', 'Compare candidates', '按 JSON Pointer 分页比较同 Job 的两个候选。', 'READ', 'parallel', async (input, _call, context) =>
      unwrap(await services.candidates.compareForRun(input, context))),
    define('save_invoice_candidate', 'Save candidate', '重新核验来源和规则后提交一份本地候选。', 'LOCAL_WRITE', 'sequential', async (input, call, context) =>
      unwrap(await services.candidates.save(input, call, context))),
  ];
  if (tools.length !== INVOICE_TOOL_NAMES.length || tools.some((tool, index) => tool.name !== INVOICE_TOOL_NAMES[index])) {
    throw new Error('invoice_tool_manifest_invalid');
  }
  return tools;
}
