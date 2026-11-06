import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';
import { migrate, SCHEMA_VERSION } from './schema.js';
import { knownGroups, moveGroup } from './todos.js';

/**
 * 群登记簿。
 *
 * 存在的理由：QQ 的群 OpenID 不是群号，人工抄写极容易错，而 .env 里填错一个字符
 * 就会让主动推送全部静默失败（API 返回 11255）。所以改成「机器人收到这个群的任何
 * 消息就自动记下来」，配合 .env 留空即可工作。
 */

const FILE = () => path.join(config.dataDir, 'groups.json');

let cache = null;

function emptyState() {
  return { version: SCHEMA_VERSION, groups: [] };
}

function load() {
  if (cache) return cache;
  const file = FILE();
  if (!fs.existsSync(file)) {
    cache = emptyState();
    return cache;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log.error(`读取群登记簿失败，将以空表启动：${err.message}`);
    cache = emptyState();
    return cache;
  }

  // 版本比程序新时这里会抛，故意不兜：群登记簿丢了等于所有主动推送都发不出去
  const data = migrate(parsed, file);
  cache = { version: SCHEMA_VERSION, groups: Array.isArray(data.groups) ? data.groups : [] };
  return cache;
}

function save() {
  const file = FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 记录一次「这个群活着」的证据。返回是否首次发现。 */
export function rememberGroup(openid, { name = '' } = {}) {
  if (!openid) return { isNew: false, count: load().groups.length };
  const state = load();
  const now = new Date().toISOString();
  const hit = state.groups.find((g) => g.openid === openid);

  if (hit) {
    hit.last_seen = now;
    if (name) hit.name = name;
    save();
    return { isNew: false, count: state.groups.length };
  }

  state.groups.push({ openid, name, first_seen: now, last_seen: now });
  save();
  return { isNew: true, count: state.groups.length };
}

export function listGroups() {
  return [...load().groups].sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}

export function removeGroup(openid) {
  const state = load();
  const before = state.groups.length;
  state.groups = state.groups.filter((g) => g.openid !== openid);
  if (state.groups.length !== before) {
    save();
    return true;
  }
  return false;
}

/**
 * 该往哪些群发主动消息。
 * 优先级：.env 明确配置 > 自动发现的群 > 有待办记录的群。
 * 三者都为空时返回空数组，调用方据此跳过而不是报错。
 */
export function resolveTargets() {
  if (config.groupOpenids.length) return config.groupOpenids;

  const discovered = listGroups().map((g) => g.openid);
  const fromTodos = knownGroups().filter((g) => g !== 'pending');
  const merged = [...discovered];
  for (const g of fromTodos) if (!merged.includes(g)) merged.push(g);
  return merged;
}

/**
 * 第一个群被登记时，把 pending 占位群里的待办认领过来。
 * 只在一个群、且没有显式配置 QQ_GROUP_OPENIDS 时生效——
 * 多个群的情况下认领给谁都不对，宁可让人手动 move。
 */
export function bootstrapFirstGroup(openid) {
  if (config.groupOpenids.length) return 0;
  if (load().groups.length !== 1) return 0;
  return moveGroup('pending', openid);
}
