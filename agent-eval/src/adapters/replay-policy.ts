const allowed = new Set(['read_invoice_document', 'read_invoice_evidence', 'search_invoice_document', 'list_invoice_pages',
  'list_invoice_tables', 'normalize_invoice_values', 'calculate_invoice_amounts', 'save_invoice_candidate', 'validate_invoice_candidate',
  'list_invoice_candidates', 'get_invoice_candidate', 'compare_invoice_candidates', 'check_invoice_sources',
  'list_skill_resources', 'read_skill_resource', 'save_research_plan', 'read_research_local', 'query_research_evidence',
  'save_research_claim', 'save_research_report']);

/** Replay runs in a fresh Host; unknown tools must never acquire side effects through generated cases. */
export function controlledReplayTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter(tool => allowed.has(tool.name));
}
