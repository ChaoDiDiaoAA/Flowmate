/** Controlled public API fixture derived from the actual SDK's transported OTLP JSON. */
export function observationRowsFromOtlp(body: any): any[] {
  const rows: any[] = [];
  for (const resource of body.resourceSpans) for (const scope of resource.scopeSpans) for (const span of scope.spans) {
    const attrs = Object.fromEntries(span.attributes.map((a: any) => [a.key, a.value.stringValue]));
    const metadata = Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith('langfuse.observation.metadata.'))
      .map(([key, value]) => [key.slice('langfuse.observation.metadata.'.length), value]));
    rows.push({ id: span.spanId, traceId: span.traceId, parentObservationId: span.parentSpanId ?? null, name: span.name,
      type: attrs['langfuse.observation.type'].toUpperCase(), startTime: new Date(Number(BigInt(span.startTimeUnixNano) / 1_000_000n)).toISOString(),
      endTime: new Date(Number(BigInt(span.endTimeUnixNano) / 1_000_000n)).toISOString(), input: attrs['langfuse.observation.input'] ?? null,
      output: attrs['langfuse.observation.output'] ?? null, model: attrs['langfuse.observation.model.name'] ?? '',
      modelParameters: attrs['langfuse.observation.model.parameters'] ?? {},
      usageDetails: JSON.parse(attrs['langfuse.observation.usage_details'] ?? '{}'), metadata });
  }
  return rows;
}
