'use strict';

/**
 * Talk to an OpenAI-compatible chat-completions API (DeepSeek by default).
 *
 * Two entry points:
 *
 * 1. streamChat({ systemPrompt, messages }) — legacy: returns a raw response
 *    body stream of SSE chunks. Kept for compatibility (no callers depend on
 *    this any more inside the project, but other tooling might).
 *
 * 2. llmTurn({ systemPrompt, messages, tools }) — async generator that yields
 *    structured events:
 *      { type: 'text', delta: string }
 *      { type: 'tool_call', tool_call: { id, name, arguments } }
 *      { type: 'done', finishReason: 'stop'|'tool_calls'|... }
 *    Callers drive a tool-call loop themselves: forward `text` deltas to the
 *    client as they arrive, execute the tool when a `tool_call` arrives,
 *    append a `tool` message to the history, and call llmTurn() again.
 *
 * The `messages` array passed to llmTurn uses the OpenAI shape
 * ({role, content, tool_calls?, tool_call_id?}); the chat route is
 * responsible for turning DB rows into that shape.
 */

const DEFAULT_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';

function llmConfig() {
  const apiKey = process.env.LLM_API_KEY;
  const apiUrl = process.env.LLM_API_URL || DEFAULT_API_URL;
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;
  if (!apiKey) throw new Error('LLM_API_KEY is not configured');
  return { apiKey, apiUrl, model };
}

/**
 * Legacy entrypoint — returns a raw SSE byte stream.
 *
 * @param {object} args
 * @param {string} args.systemPrompt
 * @param {Array<{role:string, content:string}>} args.messages
 */
async function streamChat({ systemPrompt, messages }) {
  const { apiKey, apiUrl, model } = llmConfig();
  const body = {
    model,
    stream: true,
    messages: [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  };
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API error ${res.status}: ${text}`);
  }
  return res.body;
}

/**
 * Modern entrypoint with tool-call support. Yields structured events.
 *
 * @param {object} args
 * @param {string} [args.systemPrompt]
 * @param {Array<object>} args.messages              — full OpenAI-shape history
 * @param {Array<object>} [args.tools]               — OpenAI-shape tools array
 * @param {'auto'|'required'|'none'|object} [args.toolChoice]
 *      — passed through as `tool_choice`. 'required' forces the model to
 *        call one of the exposed tools (useful for the very first turn of
 *        a tool-using user message, where we want to defeat DeepSeek's
 *        habit of replying in prose). Defaults to 'auto' when tools are
 *        provided, omitted otherwise.
 * @param {object} [args.deps]                       — for tests: { fetch }
 */
async function* llmTurn({ systemPrompt, messages, tools, toolChoice, deps }) {
  const fetchFn = deps?.fetch || fetch;
  const { apiKey, apiUrl, model } = llmConfig();

  const fullMessages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...messages,
  ];

  const hasTools = Array.isArray(tools) && tools.length > 0;
  const body = {
    model,
    stream: true,
    messages: fullMessages,
    ...(hasTools ? { tools, tool_choice: toolChoice ?? 'auto' } : {}),
  };

  const res = await fetchFn(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM API error ${res.status}: ${text}`);
  }

  // Parse SSE chunks. We must handle:
  //   - text content deltas (delta.content)
  //   - tool_call deltas, possibly multi-call, with arguments arriving in
  //     pieces across many chunks (delta.tool_calls[i])
  //   - finish_reason on the last chunk before [DONE]
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  /** @type {{id:string, name:string, arguments:string}[]} */
  const toolCalls = [];
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        yield { type: 'text', delta: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: '', name: '', arguments: '' };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) {
            toolCalls[idx].arguments += tc.function.arguments;
          }
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  // Once the stream is fully consumed, emit each accumulated tool call.
  for (const tc of toolCalls) {
    if (!tc) continue;
    yield { type: 'tool_call', tool_call: tc };
  }
  yield { type: 'done', finishReason };
}

module.exports = { streamChat, llmTurn };
