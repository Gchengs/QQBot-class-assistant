/**
 * 数据结构版本与迁移。
 *
 * 为什么需要这东西：`data/` 下是纯 JSON 落盘，用户手里有真实数据。
 * 只要改一次字段名，老文件里的旧字段新代码就读不到——程序不报错，
 * 只是那几条待办的负责人和日期变成空值。静默出错比崩溃难查得多，
 * 所以把版本号写进文件，读的时候按版本一级一级升上来。
 *
 * 参与的三个文件，结构都是「信封 + 列表」：
 *   todos.json   { version, todos: [] }
 *   courses.json { version, courses: [] }
 *   groups.json  { version, groups: [] }
 *
 * push-state.json 故意不参与：它是可丢弃的发送记录，丢了顶多某周多推或少推一次，
 * 为它套一层 version 反而要让老用户现有的文件读不出来，不划算。
 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger.js';

/**
 * 当前数据结构版本。
 *
 * 改 `data/` 下任何 JSON 的字段结构时，这个数字 +1 并在 MIGRATIONS 里补一步，
 * 两件事缺一不可：只加数字会报错，只写函数不会被执行。
 */
export const SCHEMA_VERSION = 1;

/**
 * 迁移表：`MIGRATIONS[n]` 负责把 n 版数据升到 n+1 版。
 *
 * 现在表是空的——还没有发生过第二次结构变更（v1 就是初版）。
 * 真要为 v2 改结构时，照这个写：
 *
 *   1: (data) => {
 *     // v1 -> v2：owner 改名成 assignee，旧的 owner 值搬过去
 *     data.todos = data.todos
 *       .filter((t) => t && typeof t === 'object')
 *       .map(({ owner, ...rest }) => ({ ...rest, assignee: owner || '' }));
 *     return data;
 *   },
 *
 * 两条约束：
 *   1. 只改结构，别在里面读写文件、发网络请求，也别抛异常处理业务
 *   2. 函数要能接受「字段缺失」的老数据，用 `||` 这种兜底，别假设字段一定在
 */
const MIGRATIONS = {};

/** 数据比程序新。抛出它就不要兜底了，宁可起不来也不能把数据写坏。 */
export class SchemaTooNewError extends Error {
  constructor(file, from, to) {
    super(
      `${path.basename(file)} 的数据版本是 v${from}，当前程序只认到 v${to}。` +
        `用旧代码读新数据，会把它不认识的字段丢掉，然后一保存就彻底没了。` +
        `请更新程序后再启动；确实要降级，先把 ${path.basename(file)} 挪走备份。`
    );
    this.name = 'SchemaTooNewError';
  }
}

/**
 * 把读到的数据升到当前版本。
 *
 * @param {object} parsed  JSON.parse 的结果
 * @param {string} file    来源文件路径，只用于备份文件名和报错提示
 * @param {{migrations?: object, target?: number}} [opts] 仅测试时注入，正常调用不用传
 * @returns {object}       升到当前版本后的数据（同版本时原样返回）
 * @throws {SchemaTooNewError} 数据比程序新
 */
export function migrate(parsed, file, opts = {}) {
  const migrations = opts.migrations || MIGRATIONS;
  const target = opts.target ?? SCHEMA_VERSION;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;

  // 没有 version 字段的是最早那批文件，当时只有一种结构，按 v1 处理。
  // 这里不报错：那时候 .version 字段根本不存在，报错等于把所有老用户的库判死。
  const from = Number.isInteger(parsed.version) && parsed.version >= 1 ? parsed.version : 1;

  if (from > target) throw new SchemaTooNewError(file, from, target);
  if (from === target) return parsed;

  // 升级前留一份原件：迁移函数写错、或者升到一半断电，还能从 .bak 捞回来
  const backup = `${file}.v${from}.bak`;
  try {
    fs.copyFileSync(file, backup);
    log.warn(
      `${path.basename(file)} 数据结构从 v${from} 升到 v${target}，原件已备份为 ${path.basename(backup)}`
    );
  } catch (err) {
    // 备份失败就不升了。没有退路的情况下改写用户数据，比这次读失败严重得多
    throw new Error(
      `${path.basename(file)} 升级前备份失败（${err.message}），已中止迁移，数据未改动`
    );
  }

  let data = parsed;
  for (let v = from; v < target; v += 1) {
    const step = migrations[v];
    if (typeof step !== 'function') {
      throw new Error(
        `${path.basename(file)} 需要从 v${v} 升到 v${v + 1}，但没写对应的迁移函数。` +
          `改了数据结构就必须在 src/store/schema.js 的 MIGRATIONS 里补上这一步。`
      );
    }
    data = step(data) || data;
    data.version = v + 1;
  }
  return data;
}
