// Feed controlled provider responses through the real Pi streaming adapters.
export function judgeResponse(body: Record<string, any>): Response {
    const events: string[] = [];
    const emit = (data: unknown, event?: string) => events.push(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
    if (body.choices) {
        const choice = body.choices[0], model = body.model ?? 'llama-3.3-70b-versatile';
        emit({ id: 'controlled', object: 'chat.completion.chunk', model,
            choices: [{ index: 0, delta: { role: 'assistant', ...choice.message }, finish_reason: null }] });
        emit({ id: 'controlled', object: 'chat.completion.chunk', model,
            choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], ...(body.usage ? { usage: body.usage } : {}) });
        events.push('data: [DONE]\n\n');
    } else {
        emit({ type: 'message_start', message: { id: 'controlled', type: 'message', role: 'assistant',
            model: body.model ?? 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0, ...body.usage } } }, 'message_start');
        for (const [index, block] of (body.content ?? []).entries()) {
            emit({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, 'content_block_start');
            emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }, 'content_block_delta');
            emit({ type: 'content_block_stop', index }, 'content_block_stop');
        }
        emit({ type: 'message_delta', delta: { stop_reason: body.stop_reason, stop_sequence: null },
            ...(body.usage ? { usage: body.usage } : {}) }, 'message_delta');
        emit({ type: 'message_stop' }, 'message_stop');
    }
    return new Response(events.join(''), { headers: { 'content-type': 'text/event-stream' } });
}
