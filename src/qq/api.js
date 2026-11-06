import { getAccessToken } from './auth.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { splitMessage } from '../utils/chunk.js';

const API_BASE = 'https://api.sgroup.qq.com';

async function call(path, { method = 'GET', body, retry = true } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `QQBot ${token}`,
      'Content-Type': 'application/json',
      'X-Union-Appid': config.appId,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (res.status === 401 && retry) {
    const { invalidateToken } = await import('./auth.js');
    invalidateToken();
    return call(path, { method, body, retry: false });
  }

  if (!res.ok) {
    const err = new Error(`QQ API ${method} ${path} -> ${res.status}: ${text}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

/**
 * 机器人自己的 openid。
 *
 * 用途只有一个：全量消息模式下，QQ 可能只推 GROUP_MESSAGE_CREATE 而不推
 * GROUP_AT_MESSAGE_CREATE，导致 @ 了机器人却没有任何回调。
 * 这时只能从消息正文里的 `<@!openid>` 标记判断「这是在 @ 我」。
 */
let selfOpenid = '';

export async function getSelfOpenid() {
  if (selfOpenid) return selfOpenid;
  if (config.botOpenid) {
    selfOpenid = String(config.botOpenid).trim();
    return selfOpenid;
  }
  try {
    const me = await call('/users/@me');
    selfOpenid = me?.id || '';
  } catch (err) {
    log.warn(`拿不到机器人自身 openid：${err.message}（@ 识别会退回纯指令判断）`);
  }
  return selfOpenid;
}

export async function getGatewayUrl() {
  const data = await call('/gateway');
  return data.url;
}

/**
 * 发送群消息。
 * 带 msgId 时是「被动回复」：5 分钟内有效，同一 msgId 最多回复 5 次。
 * 不带 msgId 时是「主动消息」：受频控（单群 20 条/分钟，1000 条/天），
 * 且群成员可在客户端关闭「允许主动发送」，关闭后直接失败。
 */
export async function sendGroupMessage(groupOpenid, content, opts = {}) {
  const { msgId, msgSeq } = opts;
  const body = { content, msg_type: 0 };
  if (msgId) {
    body.msg_id = msgId;
    body.msg_seq = msgSeq ?? Math.floor(Math.random() * 1000) + 1;
  }
  return call(`/v2/groups/${groupOpenid}/messages`, { method: 'POST', body });
}

export function isRateLimitError(err) {
  return err?.status === 429 || err?.payload?.code === 22009;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 发送可能超长的消息：自动分片成多条。
 * 被动回复时 msg_seq 从 1 递增（平台要求同一 msg_id 的回复序号唯一）。
 */
export async function sendLongGroupMessage(groupOpenid, text, { msgId } = {}) {
  const chunks = splitMessage(text, { maxChunks: msgId ? 5 : 3 });
  if (!chunks.length) return [];

  const results = [];
  for (let i = 0; i < chunks.length; i += 1) {
    results.push(
      await sendGroupMessage(groupOpenid, chunks[i], {
        msgId,
        msgSeq: msgId ? i + 1 : undefined,
      })
    );
    if (i < chunks.length - 1) await sleep(350);
  }
  return results;
}
