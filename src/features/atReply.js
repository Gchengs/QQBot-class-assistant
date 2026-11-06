import { sendLongGroupMessage } from '../qq/api.js';
import {
  listActive,
  listTodos,
  isDisplayable,
  findByKeyword,
  updateTodo,
  addTodo,
  reopenByKeyword,
} from '../store/todos.js';
import { renderSummary, renderWeekly, pickByIndex } from './render.js';
import { pickWeeklyBuckets } from './digest.js';
import { parseDueDate, parseDateRange, parseTime, parseBaseDate } from '../utils/date.js';
import { findRoleOwner, classifyUndated } from './extract.js';
import { log } from '../logger.js';

export function cleanContent(raw) {
  return String(raw || '')
    .replace(/<@!?[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HELP = [
  '【群待办助手】',
  '',
  '记待办：',
  '#待办 @某人 周五 交材料',
  '（不 @ 我也能识别，静默入库）',
  '',
  '查待办：',
  '@我 待办 —— 按紧急度汇总',
  '@我 周报 —— 本周/下周/待定分组（和周六定时推送同一份内容）',
  '',
  '销项：',
  '#完成 关键词   或   #完成 3（按编号）',
  '（过了截止日会自动销项）',
  '',
  '恢复：',
  '#恢复 关键词 —— 把自动过期的撤回',
  '',
  '其他：',
  '群ID —— 查看本群 OpenID（配置用）',
  '帮助 —— 显示这段说明',
].join('\n');

/**
 * 处理群内 @ 机器人的消息。
 * 必须在 5 分钟内回复，且同一 msg_id 最多回 5 次（超长内容按分片消耗这 5 次配额）。
 */
export async function handleAtMessage(d) {
  const group = d.group_openid;
  const msgId = d.id;
  const content = cleanContent(d.content);

  const reply = async (text) => {
    try {
      const sent = await sendLongGroupMessage(group, text, { msgId });
      log.info(`已回复群 ${group}（${text.length} 字，分 ${sent.length} 条）`);
    } catch (err) {
      log.error(`回复失败：${err.message}`);
      if (err.payload) log.debug(JSON.stringify(err.payload));
    }
  };

  if (!content) return reply(HELP);

  if (/^(群\s*id|group\s*id|群openid)$/i.test(content)) {
    return reply(`本群 OpenID：\n${group}\n\n填到 .env 的 QQ_GROUP_OPENIDS 即可只服务这个群。`);
  }

  if (/^(帮助|help|指令|命令)$/i.test(content)) {
    return reply(HELP);
  }

  const done = content.match(/^[#＃]?\s*(完成|销项|done|归档)\s+(.+)$/i);
  if (done) {
    const keyword = done[2].trim();

    // 纯数字 → 按上一次推送的编号销项，比记标题方便
    if (/^\d+$/.test(keyword)) {
      const target = pickByIndex(group, Number(keyword));
      if (!target) {
        return reply(`编号 ${keyword} 不在最近一次清单里，发「待办」看一下最新编号。`);
      }
      updateTodo(target.id, { status: 'done', closed_at: new Date().toISOString() });
      return reply(`已销项：${target.title}`);
    }

    const matches = findByKeyword(group, keyword);
    if (!matches.length) return reply(`没有找到包含「${keyword}」的待办。`);
    if (matches.length > 1) {
      return reply(
        `「${keyword}」匹配到 ${matches.length} 项，请说得更具体：\n` +
          matches.map((t, i) => `${i + 1}. ${t.title}`).join('\n')
      );
    }
    updateTodo(matches[0].id, {
      status: 'done',
      closed_at: new Date().toISOString(),
    });
    return reply(`已销项：${matches[0].title}`);
  }

  // 自动过期销错了可以救回来
  const reopen = content.match(/^[#＃]?\s*(恢复|撤回|reopen)\s+(.+)$/i);
  if (reopen) {
    const keyword = reopen[2].trim();
    const hits = reopenByKeyword(group, keyword);
    if (!hits.length) return reply(`没有找到已自动过期的「${keyword}」。`);
    return reply(`已恢复 ${hits.length} 项：\n${hits.map((t) => t.title).join('\n')}`);
  }

  const add = content.match(/^[#＃]待办\s+(.+)$/);
  if (add) {
    const body = add[1].trim();
    const mentions = d.mentions || [];
    // 同 ingest：指令里的「明天」也得按发消息的时间算，拿不到时间就只认绝对日期
    const base = parseBaseDate(d.timestamp);
    if (!base) {
      log.warn(`指令消息 ${d.id || '?'} 没有可用的发送时间，相对日期不解析`);
    }
    const range = parseDateRange(body, base);
    const due = parseDueDate(body, base);
    const dueTime = parseTime(body);
    // 没 @ 人就看正文有没有用职务指派（学委/纪检委员/寝室长…），
    // 这才是班级群真实的写法，不能一律当成全体的事
    const owner = mentions[0]?.username || findRoleOwner(body);
    const title = body
      .replace(/@\S+/g, ' ')
      .replace(/^(无期限|无截止|不限时|长期有效|长期|待定|待通知|另行通知)\s*[的：:，,]?\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) return reply('待办内容不能为空。示例：#待办 @张三 明天14:00 交材料');
    const { todo, duplicated } = addTodo({
      group,
      title,
      owner,
      ownerOpenid: mentions[0]?.member_openid || '',
      due,
      dueStart: range?.start || null,
      dueTime,
      timeState: due ? 'dated' : classifyUndated(body),
      sourceMsgId: msgId,
      sourceText: content,
      source: 'manual',
    });
    return reply(duplicated ? `这条已经在清单里了：${todo.title}` : `已记录：${todo.title}`);
  }

  // 平台不给主动消息权限时（40034105 无权限），靠 @ 机器人发「#周报」拿到同一份内容。
  // 被动回复带 msg_id，不消耗主动消息配额，这是目前唯一 100% 能送达的通道。
  if (/^[#＃]?\s*(周报|本周|weekly)\s*$/i.test(content)) {
    const all = listTodos(group, { status: 'open' }).filter(isDisplayable);
    return reply(renderWeekly(pickWeeklyBuckets(all)).text);
  }

  const todos = listActive(group);
  return reply(renderSummary(todos, group));
}
