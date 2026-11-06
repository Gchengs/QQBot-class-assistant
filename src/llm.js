import { config } from './config.js';
import { log } from './logger.js';

export function llmEnabled() {
  return Boolean(config.llm.apiKey);
}

/**
 * 调用 OpenAI 兼容的 chat completions 接口。
 * 失败时抛错，由调用方降级处理。
 */
export async function chat(messages, { temperature = 0, maxTokens = 800, timeoutMs = 20000 } = {}) {
  if (!llmEnabled()) throw new Error('LLM 未配置');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${config.llm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    return data?.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

/** 从模型输出里抠出 JSON，兼容 ```json 包裹和前后废话 */
export function extractJson(raw) {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
  if (end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    log.debug(`JSON 解析失败：${err.message}`);
    return null;
  }
}
