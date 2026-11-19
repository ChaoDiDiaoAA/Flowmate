import { z } from 'zod';
import { ToolExecutionFailure, appError, isResearchWebUrl, RESEARCH_WEB_SEARCH_RESULTS } from '@flowmate/contracts';
import type { ResearchStep, ToolCallContext } from '@flowmate/contracts';
import { checkResearchControl } from './tools.ts';

export type TavilyResearchOptions = { apiKey: string; fetch?: (url: string, init: RequestInit) => Promise<Response> };
const TAVILY_URL = 'https://api.tavily.com';
const TAVILY_TIMEOUT_MS = 20_000;
const MAX_SOURCE_BYTES = 2_000_000;
const MAX_RESPONSE_BYTES = 12_000_000;
type WebStep = Exclude<ResearchStep, { tool: 'read_research_local' }>;
const result = z.object({ url: z.string(), raw_content: z.string().nullish(), title: z.string().nullish(), published_date: z.string().nullish() });
const response = z.object({ results: z.array(z.unknown()).max(RESEARCH_WEB_SEARCH_RESULTS),
  failed_results: z.array(z.object({ url: z.string() })).optional(), request_id: z.string().max(256).nullish(),
  usage: z.object({ credits: z.number().min(0) }).nullish() });

function failure(code: string, message: string, retryable = false): ToolExecutionFailure {
  return new ToolExecutionFailure(appError(code, 'tool', message, retryable));
}

async function readResponse(reply: Response) {
  const reader = reply.body?.getReader();
  if (!reader) throw failure('research_web_response_invalid', 'Tavily returned no response body.', true);
  // A search can return five pages. Bound the response before decoding JSON.
  const decoder = new TextDecoder(), chunks: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw failure('research_web_source_too_large', 'The Tavily response exceeded the acquisition size limit.');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return response.parse(JSON.parse(chunks.join('')));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function acquireTavilyPage(options: TavilyResearchOptions, step: WebStep, call: ToolCallContext) {
  checkResearchControl(call);
  const timeout = AbortSignal.timeout(TAVILY_TIMEOUT_MS);
  const signal = AbortSignal.any([timeout, call.signal]);
  let requestId: string | null = null, credits: number | null = 0;

  async function post(endpoint: 'search' | 'extract', body: object) {
    checkResearchControl(call);
    const payload = JSON.stringify(body);
    if (payload.includes(options.apiKey)) throw failure('research_source_denied', 'The request contains a credential.');
    try {
      const reply = await (options.fetch ?? fetch)(`${TAVILY_URL}/${endpoint}`, {
        method: 'POST', signal, redirect: 'error', headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: payload,
      });
      if (!reply.ok) {
        void reply.body?.cancel().catch(() => undefined);
        if (reply.status === 401 || reply.status === 403) throw failure('research_web_auth_failed', 'Tavily rejected the configured API key.');
        if (reply.status === 402 || reply.status === 432) throw failure('research_web_quota', 'Tavily credits are unavailable.');
        if (reply.status === 429 || reply.status === 434) throw failure('research_web_rate_limited', 'Tavily is rate limited or at capacity.', true);
        throw failure('research_web_request_failed', 'Tavily could not complete the request.', reply.status >= 500);
      }
      const parsed = await readResponse(reply);
      checkResearchControl(call);
      const charged = parsed.usage?.credits;
      credits = charged === undefined || credits === null ? null : credits + charged;
      requestId = parsed.request_id ?? null;
      return parsed;
    } catch (error) {
      checkResearchControl(call);
      if (timeout.aborted) throw failure('tool_timeout', 'The Tavily request timed out.', true);
      if (error instanceof ToolExecutionFailure) throw error;
      throw failure('research_web_request_failed', 'Tavily returned an invalid response or was unreachable.', true);
    }
  }

  function snapshot(page: z.infer<typeof result>) {
    const { url, title, published_date: date } = page;
    const text = page.raw_content?.trim();
    if (!text || !isResearchWebUrl(url))
      throw failure('research_web_source_unavailable', 'Tavily returned no usable webpage body for this step.', true);
    const address = new URL(url);
    if (address.href.length > 4096)
      throw failure('research_web_response_invalid', 'Tavily returned an oversized webpage address.');
    if ([url, text, title, requestId].some(value => value?.includes(options.apiKey)))
      throw failure('research_web_response_invalid', 'Tavily returned a credential in the source data.');
    if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES)
      throw failure('research_web_source_too_large', 'The extracted webpage exceeded the 2 MB source limit.');
    const publishedAt = date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null;
    return { address: address.href, text, title: [...(title?.trim() || address.hostname)].slice(0, 120).join(''), publishedAt,
      usage: { requestId, credits } };
  }

  let candidate: z.infer<typeof result> | undefined;
  let url: string;
  if (step.tool === 'search_research_web') {
    const rank = (step.input.rank ?? 1) - 1;
    const query = { query: step.input.query.trim(), time_range: step.input.timeRange, filter_by_published_date: Boolean(step.input.timeRange),
      search_depth: 'basic', max_results: RESEARCH_WEB_SEARCH_RESULTS, include_answer: false, include_published_date: true, include_usage: true };
    let listing = await post('search', { ...query, max_age_hours: 0, include_raw_content: 'text' });
    // A strict live age can remove the ranked candidate. Use the provider's default only to discover a URL.
    const discover = listing.results[rank] === undefined;
    if (discover) listing = await post('search', { ...query, include_raw_content: false });
    const selected = result.safeParse(listing.results[rank]);
    if (!selected.success || !isResearchWebUrl(selected.data.url))
      throw failure('research_web_source_unavailable', 'Tavily returned no usable result at the confirmed search rank.', true);
    candidate = selected.data;
    if (!discover && candidate.raw_content?.trim()) return snapshot(candidate);
    url = candidate.url;
  } else {
    url = step.input.url;
    if (!isResearchWebUrl(url)) throw failure('research_source_denied', 'Only public HTTP(S) URLs can be sent to Tavily.');
  }

  const extraction = await post('extract', { urls: [url], format: 'text', include_published_date: true, include_usage: true });
  const page = result.safeParse(extraction.results[0]);
  if (!page.success || !isResearchWebUrl(page.data.url) || new URL(page.data.url).href !== new URL(url).href
    || extraction.failed_results?.some(failed => failed.url === url || failed.url === page.data.url))
    throw failure('research_web_source_unavailable', 'Tavily did not successfully extract the selected URL.', true);
  return snapshot({ ...page.data, title: page.data.title?.trim() || candidate?.title,
    published_date: page.data.published_date ?? candidate?.published_date });
}
