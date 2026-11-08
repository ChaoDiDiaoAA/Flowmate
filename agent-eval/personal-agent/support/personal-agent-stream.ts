import { CandidateDraftSchema, invoiceHeaderFields, type DocumentSnapshot } from '@flowmate/contracts';

export function stream(value: string | { document: DocumentSnapshot; id: number; candidate?: ReturnType<typeof CandidateDraftSchema.parse> }, model = 'personal-ui-model') {
  const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
  const draft = typeof value === 'string' ? null : value.candidate ?? CandidateDraftSchema.parse({ fields: { ...Object.fromEntries(invoiceHeaderFields.map(key => [key, missing])),
    totalAmount: { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [], sources: [{ documentId: value.document.documentRef.id,
      version: value.document.documentRef.version, artifactId: value.document.parsedArtifactId, page: 1, blockId: 'b1', quote: 'Total 113.00' }] } }, lines: [], notes: [] });
  const delta = typeof value === 'string' ? { role: 'assistant', content: value } : { role: 'assistant', tool_calls: [{ index: 0, id: 'p18-ui-call-' + value.id,
    type: 'function', function: { name: 'save_invoice_candidate', arguments: JSON.stringify({ documentId: value.document.documentRef.id, candidate: draft }) } }] };
  return new Response('data: ' + JSON.stringify({ id: 'p18-ui-response', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: typeof value === 'string' ? 'stop' : 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
