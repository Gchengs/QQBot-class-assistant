import WebSocket from 'ws';
import { getAccessToken, invalidateToken } from './auth.js';
import { getGatewayUrl } from './api.js';
import { log } from '../logger.js';

// GROUP_AND_C2C_EVENT：群聊与单聊消息事件（含 @ 与全量群消息）
const INTENTS = 1 << 25;

const DEDUPE_LIMIT = 3000;

export class Gateway {
  constructor({ onEvent }) {
    this.onEvent = onEvent;
    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.attempt = 0;
    this.stopped = false;
    this.seen = new Set();
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  stop() {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  async connect() {
    if (this.stopped) return;
    const url = await getGatewayUrl();
    log.info(`连接网关 ${url}`);

    const ws = new WebSocket(url, { handshakeTimeout: 15000 });
    this.ws = ws;

    ws.on('open', () => log.debug('WebSocket 已打开，等待 Hello'));
    ws.on('message', (buf) => this.handleMessage(buf));
    ws.on('close', (code, reason) => this.handleClose(code, reason?.toString?.() ?? ''));
    ws.on('error', (err) => log.error('WebSocket 错误：', err.message));
    ws.on('unexpected-response', (_req, res) => {
      log.error(`WebSocket 握手被拒绝 HTTP ${res.statusCode}，请检查 AppID/Secret 与 IP 白名单`);
    });
  }

  handleMessage(buf) {
    let payload;
    try {
      payload = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (typeof payload.s === 'number') this.seq = payload.s;

    switch (payload.op) {
      case 10: {
        const interval = payload.d?.heartbeat_interval ?? 40000;
        this.startHeartbeat(interval);
        this.identifyOrResume();
        break;
      }
      case 11:
        log.debug('心跳 ACK');
        break;
      case 0:
        this.handleDispatch(payload);
        break;
      case 7:
        log.warn('服务端要求重连');
        this.reconnect();
        break;
      case 9:
        log.warn('会话失效，重新认证');
        this.sessionId = null;
        this.seq = null;
        setTimeout(() => {
          if (!this.stopped) this.identify();
        }, 1200);
        break;
      default:
        log.debug(`未处理的 opcode ${payload.op}`);
    }
  }

  async identifyOrResume() {
    if (this.sessionId) return this.resume();
    return this.identify();
  }

  async identify() {
    try {
      const token = await getAccessToken();
      this.ws?.send(
        JSON.stringify({
          op: 2,
          d: {
            token: `QQBot ${token}`,
            intents: INTENTS,
            shard: [0, 1],
            properties: {
              $os: process.platform,
              $browser: 'qqbot-class-assistant',
              $device: 'qqbot-class-assistant',
            },
          },
        })
      );
      log.debug('已发送 Identify');
    } catch (err) {
      log.error('Identify 失败：', err.message);
      this.scheduleReconnect();
    }
  }

  async resume() {
    try {
      const token = await getAccessToken();
      this.ws?.send(
        JSON.stringify({
          op: 6,
          d: {
            token: `QQBot ${token}`,
            session_id: this.sessionId,
            seq: this.seq ?? 0,
          },
        })
      );
      log.info('尝试 Resume 会话');
    } catch (err) {
      log.error('Resume 失败：', err.message);
      this.sessionId = null;
      this.scheduleReconnect();
    }
  }

  handleDispatch(payload) {
    const t = payload.t;
    const d = payload.d;

    if (t === 'READY') {
      this.sessionId = d?.session_id ?? null;
      this.attempt = 0;
      const name = d?.user?.username ?? d?.user?.id ?? 'unknown';
      log.info(`机器人已上线：${name}（session=${this.sessionId}）`);
      return;
    }

    if (t === 'RESUMED') {
      this.attempt = 0;
      log.info('会话已恢复');
      return;
    }

    if (t === 'GROUP_AT_MESSAGE_CREATE' || t === 'GROUP_MESSAGE_CREATE') {
      const id = d?.id;
      if (!id) return;
      if (this.seen.has(id)) return;
      this.seen.add(id);
      if (this.seen.size > DEDUPE_LIMIT) {
        const first = this.seen.values().next().value;
        this.seen.delete(first);
      }
      try {
        this.onEvent(t, d);
      } catch (err) {
        log.error('事件处理异常：', err);
      }
    }
  }

  startHeartbeat(intervalMs) {
    this.stopHeartbeat();
    const tick = () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: this.seq }));
      }
    };
    this.heartbeatTimer = setInterval(tick, Math.max(5000, intervalMs));
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  reconnect() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt, 5));
    this.attempt += 1;
    log.warn(`${delay}ms 后重连（第 ${this.attempt} 次）`);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        log.error('重连失败：', err.message);
        this.scheduleReconnect();
      });
    }, delay);
  }

  handleClose(code, reason) {
    this.stopHeartbeat();
    this.ws = null;
    if (this.stopped) return;
    log.warn(`连接关闭 code=${code} reason=${reason || '-'}`);
    if (code === 4004 || code === 4013 || code === 4014) {
      invalidateToken();
      this.sessionId = null;
      this.seq = null;
    }
    this.scheduleReconnect();
  }
}
