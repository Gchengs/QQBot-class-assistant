import { config } from '../config.js';
import { log } from '../logger.js';

let cached = { token: '', expiresAt: 0 };
let inflight = null;

export async function getAccessToken() {
  const now = Date.now();
  if (cached.token && now < cached.expiresAt - 60_000) return cached.token;
  if (inflight) return inflight;

  inflight = (async () => {
    const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: config.appId,
        clientSecret: config.appSecret,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`获取 access_token 失败 ${res.status}: ${text}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`access_token 响应不是 JSON: ${text}`);
    }
    if (!data.access_token) {
      throw new Error(`access_token 响应缺少字段: ${text}`);
    }
    const ttl = Number(data.expires_in ?? 7200) * 1000;
    cached = { token: data.access_token, expiresAt: Date.now() + ttl };
    log.debug(`access_token 已刷新，有效期 ${Math.round(ttl / 1000)}s`);
    return cached.token;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function invalidateToken() {
  cached = { token: '', expiresAt: 0 };
}
