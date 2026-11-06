const DEFAULT_MAX_LEN = 1200;

function hardSplit(line, maxLen) {
  const out = [];
  for (let i = 0; i < line.length; i += maxLen) {
    out.push(line.slice(i, i + maxLen));
  }
  return out;
}

/**
 * 把长文本按行切成多条消息。
 * 被动回复同一 msg_id 最多 5 条，所以默认上限 5；
 * 主动消息可以更多，但为了不刷屏也建议控制在这个量级。
 */
export function splitMessage(text, { maxLen = DEFAULT_MAX_LEN, maxChunks = 5 } = {}) {
  const raw = String(text ?? '');
  if (!raw) return [];
  if (raw.length <= maxLen) return [raw];

  const lines = [];
  for (const line of raw.split('\n')) {
    if (line.length > maxLen) lines.push(...hardSplit(line, maxLen));
    else lines.push(line);
  }

  const chunks = [];
  let buf = '';
  for (const line of lines) {
    const candidate = buf ? `${buf}\n${line}` : line;
    if (candidate.length > maxLen && buf) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);

  if (chunks.length <= maxChunks) return chunks;

  const kept = chunks.slice(0, maxChunks);
  const dropped = chunks.length - maxChunks;
  kept[maxChunks - 1] = `${kept[maxChunks - 1]}\n…（内容较长，还有 ${dropped} 段未发送）`;
  return kept;
}
