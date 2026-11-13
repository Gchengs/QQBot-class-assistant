/**
 * 自检脚本，不需要 QQ 凭证。
 * 运行：node scripts/selftest.js
 *
 * 每次跑之前先清掉上次留下的临时数据，否则第二次跑会读到上一次的课程和待办，
 * 结果变成一片红——那不是代码坏了，是脚本自己没打扫房间。
 */
import fs from 'node:fs';
fs.rmSync('./data/_selftest', { recursive: true, force: true });

process.env.DATA_DIR = './data/_selftest';

const { parseDueDate, parseTime, humanDate, today, addDays, diffDays } = await import(
  '../src/utils/date.js'
);
const { renderSummary, renderDigest, renderReminder } = await import(
  '../src/features/render.js'
);
const { addTodo, listActive, listTodos, findByKeyword, updateTodo } = await import(
  '../src/store/todos.js'
);
const { addCourse, parseScheduleSpec, listCourses, importCourses } =
  await import('../src/store/courses.js');
const { computeNext, scanCourses } = await import('../src/features/course.js');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}\n       期望 ${JSON.stringify(expected)}\n       实际 ${JSON.stringify(actual)}`);
  }
}

const base = new Date(2026, 9, 31); // 2026-10-31 周六

console.log('\n[1] 日期解析');
check('明天', parseDueDate('明天交材料', base), '2026-11-01');
check('后天', parseDueDate('后天之前', base), '2026-11-02');
check('大后天', parseDueDate('大后天', base), '2026-11-03');
check('周五（已过则顺延）', parseDueDate('周五给我', base), '2026-11-06');
check('本周三（已过则顺延）', parseDueDate('本周三', base), '2026-11-04');
check('下周一', parseDueDate('下周一', base), '2026-11-02');
check('11月5日', parseDueDate('11月5日', base), '2026-11-05');
check('11/5', parseDueDate('11/5 前', base), '2026-11-05');
check('3天后', parseDueDate('3天后', base), '2026-11-03');
check('无时间词', parseDueDate('把这个弄一下', base), null);

console.log('\n[2] 日期展示');
check('今天', humanDate(today()), humanDate(today()));
check('明天', diffDays(today(), addDays(today(), 1)), 1);

console.log('\n[3] 入库与去重');
const g = 'selftest_group';
const a = addTodo({ group: g, title: '交季度报表', owner: '张三', due: '2026-11-02' });
const b = addTodo({ group: g, title: '交季度报表 ', owner: '张三', due: '2026-11-02' });
check('首次写入', a.duplicated, false);
check('重复写入被拦', b.duplicated, true);
check('列表长度', listTodos(g).length, 1);

addTodo({ group: g, title: '确认合同条款', owner: '李四', due: today() });
addTodo({ group: g, title: '整理会议纪要', owner: '王五', due: null });

console.log('\n[4] 关键词销项');
const matched = findByKeyword(g, '合同');
check('模糊匹配', matched.length, 1);
updateTodo(matched[0].id, { status: 'done' });
check('销项后剩余', listTodos(g).length, 2);

console.log('\n[5] @ 汇总渲染');
const summary = renderSummary(listTodos(g));
console.log('---');
console.log(summary);
console.log('---');
check('包含标题', summary.includes('【待办】'), true);
check('不含 @ 负责人', summary.includes('@'), false);

console.log('\n[6] 日报渲染（逾期项应被隐藏）');
const t = today();
const digest = renderDigest([
  { title: '交周报', due: addDays(t, -2) },
  { title: '确认合同', due: t, due_time: '15:00' },
  { title: '采购清单', due: addDays(t, 1) },
]);
console.log('---');
console.log(digest);
console.log('---');
check('包含日报标题', digest.includes('【待办日报】'), true);
check('逾期项被隐藏', digest.includes('交周报'), false);
check('小时级时间保留', digest.includes('15:00'), true);

console.log('\n[7] 到期提醒渲染');
const reminder = renderReminder([
  { title: '采购清单', due: addDays(t, 1) },
  { title: '场地预定', due: addDays(t, 1), due_time: '09:30' },
]);
console.log('---');
console.log(reminder);
console.log('---');
check('提醒不含 @', reminder.includes('@'), false);
check('提醒包含条数', reminder.includes('2 项'), true);
check('提醒保留时刻', reminder.includes('09:30'), true);

console.log('\n[8] 时刻解析');
check('下午3点', parseTime('明天下午3点交'), '15:00');
check('18:30', parseTime('11月5日 18:30 前'), '18:30');
check('晚上8点半', parseTime('今晚8点半开会'), '20:30');
check('纯日期无时刻', parseTime('周五之前给'), null);
check('上午9点15', parseTime('明早上午9点15'), '09:15');

console.log('\n[9] 课程时间规则');
check(
  '每周三 08:00',
  parseScheduleSpec('每周三 08:00'),
  { repeat: 'weekly', weekday: 3, time: '08:00' }
);
check('一次性日期', parseScheduleSpec('2026-11-05 19:30'), {
  date: '2026-11-05',
  time: '19:30',
});

console.log('\n[10] 课程提醒触发窗口');
const spec = { repeat: 'weekly', weekday: 3, time: '08:00' };
const next = computeNext(spec, new Date());
const course = addCourse({
  name: '测试课',
  open: spec,
  advanceOpenMin: 30,
  target: 'g_test',
});
const sent = [];
const sender = async (group, text) => sent.push({ group, text });

const triggerAt = new Date(next.getTime() - 30 * 60_000);

await scanCourses(new Date(triggerAt.getTime() - 3 * 60_000), { sender });
check('窗口外不触发', sent.length, 0);

await scanCourses(triggerAt, { sender });
check('窗口内触发', sent.length, 1);
if (sent[0]) {
  console.log('---');
  console.log(sent[0].text);
  console.log('---');
}

await scanCourses(triggerAt, { sender });
check('同一时间点不重复触发', sent.length, 1);
// 不能断言「总共有几门课」：前面的用例也往同一个库里加过课。
// 只认这门课自己在不在。
const mine = listCourses().find((c) => c.name === '测试课');
check('课程已入库', Boolean(mine), true);
check('通知状态已落库', mine?.last?.open, next.toISOString());

console.log('\n[11] 同群同时段多门课合并成一条');
const mergeSpec = { repeat: 'weekly', weekday: 3, time: '08:00' };
const mergeNext = computeNext(mergeSpec, new Date());
const mergeAt = new Date(mergeNext.getTime() - 30 * 60_000);
addCourse({ name: '合并课甲', open: mergeSpec, advanceOpenMin: 30, target: 'g_merge' });
addCourse({ name: '合并课乙', open: mergeSpec, advanceOpenMin: 30, target: 'g_merge' });
addCourse({ name: '隔壁群课', open: mergeSpec, advanceOpenMin: 30, target: 'g_other' });

const merged = [];
await scanCourses(mergeAt, { sender: async (g, t) => merged.push({ g, text: t }) });
check('两个群各发一条', merged.length, 2);
const mergeMsg = merged.find((m) => m.g === 'g_merge');
if (mergeMsg) {
  console.log('---');
  console.log(mergeMsg.text);
  console.log('---');
}
check('标题标注门数', mergeMsg?.text.includes('2 门课'), true);
check('包含甲', mergeMsg?.text.includes('合并课甲'), true);
check('包含乙', mergeMsg?.text.includes('合并课乙'), true);
check('另一群内容独立', merged.find((m) => m.g === 'g_other')?.text.includes('隔壁群课'), true);

console.log('\n[12] 批量导入');
const imp = importCourses(`
# 这是注释行，应被忽略
导入课一 | 每周一 08:00 | 每周日 23:59
导入课二 | 11月5日 14:30
导入课三, 每周五 19:00, 每周日 22:00, 15, 60
坏行 | 下个月某天
`);
check('成功导入 3 门', imp.added.length, 3);
check('失败 1 行', imp.failed.length, 1);
check('失败行有原因', imp.failed[0]?.reason.includes('开课时间'), true);
const impAgain = importCourses('导入课一 | 每周一 08:00 | 每周日 23:59');
check('同名跳过不重复', impAgain.skipped.length, 1);
check('同名跳过后未新增', impAgain.added.length, 0);
const impRicher = importCourses('导入课一 | 每周一 08:00');
check('同名但时间规则不同不算重复', impRicher.added.length, 1);
const advCourse = listCourses().find((c) => c.name === '导入课三');
check('第 4/5 列覆盖提前分钟', [advCourse?.advanceOpenMin, advCourse?.advanceCloseMin], [15, 60]);

const twoSessions = importCourses(`
同名讲座 | 11月10日 14:00
同名讲座 | 11月17日 14:00
`);
check('同名不同场次都导入', twoSessions.added.length, 2);
check('同名同场次才跳过', importCourses('同名讲座 | 11月10日 14:00').skipped.length, 1);

const onlyClose = importCourses('只截止课 | - | 11月20日 11:59');
check('只有截止也能导入', onlyClose.added.length, 1);
check('只有截止时 open 为空', onlyClose.added[0]?.open, null);
check('只有截止时 close 有值', onlyClose.added[0]?.close?.time, '11:59');
check(
  '没有时间则报错',
  importCourses('啥都不填 | - | -').failed[0]?.reason.includes('都没有填'),
  true
);

console.log('\n[13] 静默时段');
const { inQuietHours } = await import('../src/features/course.js');
check('凌晨 2 点静默', inQuietHours(new Date(2026, 10, 4, 2, 0)), true);
check('23:30 不静默（学生还在线）', inQuietHours(new Date(2026, 10, 4, 23, 30)), false);
check('上午 10 点不静默', inQuietHours(new Date(2026, 10, 4, 10, 0)), false);
check('早 7 点已解除', inQuietHours(new Date(2026, 10, 4, 7, 0)), false);

console.log('\n[14] 错过应发时刻会补发');
const lateSpec = { repeat: 'weekly', weekday: 4, time: '10:00' };
const lateNext = computeNext(lateSpec, new Date());
const lateAt = new Date(lateNext.getTime() - 10 * 60_000); // 事件前 10 分钟，已过 30 分钟应发线
addCourse({ name: '补发课', open: lateSpec, advanceOpenMin: 30, target: 'g_late' });
const lateSent = [];
await scanCourses(lateAt, {
  sender: async (g, t) => lateSent.push({ g, text: t }),
  ignoreQuiet: true,
});
check('事件未到就补发', lateSent.length, 1);
const lateAgain = [];
await scanCourses(lateAt, {
  sender: async (g, t) => lateAgain.push({ g, text: t }),
  ignoreQuiet: true,
});
check('补发后不重复', lateAgain.length, 0);

console.log('\n[15] 静默期内的提醒被跳过（并给出风险提示）');
const nx = new Date();
nx.setDate(nx.getDate() + 1);
const pad2 = (n) => String(n).padStart(2, '0');
const nxDate = `${nx.getFullYear()}-${pad2(nx.getMonth() + 1)}-${pad2(nx.getDate())}`;
const nightCourse = addCourse({
  name: '凌晨课',
  open: { date: nxDate, time: '02:30' },
  advanceOpenMin: 30,
  target: 'g_q',
});
const quietAt = new Date(nx.getFullYear(), nx.getMonth(), nx.getDate(), 2, 0, 0);
const quietSent = [];
await scanCourses(quietAt, { sender: async (g, t) => quietSent.push({ g, text: t }) });
check('凌晨窗口内但不发', quietSent.length, 0);

const { quietRisk } = await import('../src/features/course.js');
const risky = quietRisk(nightCourse, 1);
check('能识别出落进静默期的提醒', risky.length > 0, true);
check('风险项标出应发时刻在凌晨', risky[0]?.sendAt.getHours(), 2);

console.log('\n[16] 自然周分组（本周 / 下周 / 后续）');
const mkItem = (name, due) => ({ title: name, due, status: 'open', due_time: null });
const groupedItems = [
  mkItem('项今天', addDays(today(), 0)),
  mkItem('项明天', addDays(today(), 1)),
  mkItem('项两天后', addDays(today(), 2)),
  mkItem('项十天后', addDays(today(), 10)),
  mkItem('项二十天后', addDays(today(), 20)),
];
const groupedOut = renderDigest(groupedItems);
console.log('---');
console.log(groupedOut);
console.log('---');
// 用「后续」当分界，别用「下周」——今天是周五时，两周后的事本来就不该出现在下周段，
// 分组措辞也会随星期几变，拿它当分隔符会误判。
const [nearSeg, laterSeg = ''] = groupedOut.split('后续');
check('两天后不在后续段', laterSeg.includes('项两天后'), false);
check('十天后不落进本周段', nearSeg.includes('项十天后'), false);
check('十天后落进后续段', laterSeg.includes('项十天后'), true);
check('出现后续分组', groupedOut.includes('后续'), true);

console.log('\n[17] 群自动登记与 pending 认领');
const { rememberGroup, listGroups, resolveTargets, bootstrapFirstGroup, removeGroup } =
  await import('../src/store/groups.js');

const g1 = 'GROUP_OPENID_AAA';
// 注意：resolveTargets 还会带上「待办库里出现过的群」，所以只断言新群在不在里面
check('新群登记前不在推送目标里', resolveTargets().includes(g1), false);
const r1 = rememberGroup(g1, { name: '班级通知群' });
check('首次发现是新群', r1.isNew, true);
check('群数变成 1', r1.count, 1);
check('重复收到消息不算新群', rememberGroup(g1).isNew, false);
check('群名被保留', listGroups()[0].name, '班级通知群');

// 这个群此时没有任何待办，把 pending 里的搬过来
const pendingGroup = 'pending';
addTodo({ group: pendingGroup, title: '认领测试项', due: addDays(today(), 3), source: 'manual' });
const claimed = bootstrapFirstGroup(g1);
check('第一个群认领了 pending 待办', claimed > 0, true);
check('认领后 pending 清空', listTodos(pendingGroup).length, 0);
check('认领后群里能看到', listTodos(g1).some((t) => t.title === '认领测试项'), true);
check('推送目标包含该群', resolveTargets().includes(g1), true);

// 第二个群进来不应该再认领
addTodo({ group: pendingGroup, title: '第二个群的测试项', source: 'manual' });
rememberGroup('GROUP_OPENID_BBB');
check('第二个群不认领 pending', bootstrapFirstGroup('GROUP_OPENID_BBB'), 0);
check('第二个群也进了推送目标', resolveTargets().includes('GROUP_OPENID_BBB'), true);

check('可以移除群', removeGroup('GROUP_OPENID_BBB'), true);
check('移除后不再作为推送目标', resolveTargets().includes('GROUP_OPENID_BBB'), false);

console.log('\n[18] 作废（dropped）不参与展示');
const { activeOnly } = await import('../src/features/render.js');
const dropList = [
  { title: '做完的', due: addDays(today(), 5), status: 'done' },
  { title: '不用管的', due: addDays(today(), 5), status: 'dropped' },
  { title: '还在的', due: addDays(today(), 5), status: 'open' },
];
const kept = activeOnly(dropList).map((x) => x.title);
check('只保留 open 的', kept, ['还在的']);
const dropDigest = renderDigest(dropList);
check('作废项不出现在日报里', dropDigest.includes('不用管的'), false);
check('作废项不计入条数', dropDigest.includes('共 1 项'), true);

console.log('\n[19] 自动销项（过截止日归档）');
const { autoCloseOverdue, reopenByKeyword } = await import('../src/store/todos.js');
const ag = 'GROUP_AUTOCLOSE';
addTodo({ group: ag, title: '已经过期的事', due: addDays(today(), -1) });
addTodo({ group: ag, title: '今天到期的事', due: addDays(today(), 0) });
addTodo({ group: ag, title: '以后的事', due: addDays(today(), 3) });

const closed = autoCloseOverdue();
check('自动销项有命中', closed >= 1, true);
const remain = listActive(ag).map((x) => x.title);
check('过期项被移出清单', remain.includes('已经过期的事'), false);
check('今天到期的保留', remain.includes('今天到期的事'), true);
check('未来的保留', remain.includes('以后的事'), true);
check('重复跑不会重复计数', autoCloseOverdue(), 0);

const back = reopenByKeyword(ag, '已经过期');
check('可以手动恢复自动过期的项', back.length, 1);
check('恢复后重新出现在清单里', listActive(ag).map((x) => x.title).includes('已经过期的事'), true);
check('恢复后截止日顺延到今天', back[0].due, today());

console.log('\n[20] 标题自带日期时不重复展示');
// 两个坑，都是这组用例踩过的：
// 1. 日期不能写死。写死成 '2026-11-07'，那天一过 activeOnly() 就把它滤掉，
//    renderDigest 返回 null，整组用例静默失效。
// 2. 必须用「三天后」而不是「明天」。flatDue() 里 delta===1 会先返回「明天」，
//    压根走不到 titleHasDate() 那个分支，用明天测这条等于没测。
const dupDue = addDays(today(), 3);
const [, dupM, dupD] = dupDue.split('-').map(Number);
const dupItems = [
  { title: `CAD 上课 ${dupM}.${dupD}`, due: dupDue, due_time: null, status: 'open' },
  { title: '校史馆参观', due: dupDue, due_time: null, status: 'open' },
];
const dupOut = renderDigest(dupItems);
// 先确认渲染真的有内容，否则下面两条断言即使逻辑错了也可能「通过」
check('渲染结果非空', typeof dupOut === 'string' && dupOut.length > 0, true);
const dupLine = (title) =>
  String(dupOut || '')
    .split('\n')
    .find((l) => l.includes(title)) || '';
// 标题里已经写了「11.16」，这一行就不该再出现「11月16日」。
// 断到具体日期而不是「任意 X月X日」，否则万一别处冒出别的日期会误判。
check(
  '标题含日期的不再跟一遍日期',
  dupLine('CAD 上课').includes(`${dupM}月${dupD}日`),
  false
);
// 标题没写日期的，要照常补上具体日期
check('标题不含日期的照常显示', dupLine('校史馆参观').includes(`${dupM}月${dupD}日`), true);

console.log('\n[21] 日报不再带销项提示行');
const plainDigest = renderDigest([{ title: '一件事', due: addDays(today(), 2), status: 'open' }]);
check('日报里没有「销项：#完成」', plainDigest.includes('销项'), false);
const plainSummary = renderSummary([{ title: '一件事', due: addDays(today(), 2), status: 'open' }]);
check('@ 回复里保留销项提示', plainSummary.includes('销项'), true);

console.log('\n[22] 数据快照与恢复');
const { runBackup, listBackups, restoreBackup } = await import('../src/features/backup.js');
const fsx = await import('node:fs');
const before = listBackups().length;
addTodo({ group: 'GROUP_BACKUP', title: '快照前的这条', due: addDays(today(), 5) });
const snap = runBackup({ keep: 14 });
check('生成了快照文件', !!snap.file && fsx.existsSync(snap.file), true);
check('快照数量 +1', listBackups().length, before + 1);
const snapText = fsx.readFileSync(snap.file, 'utf8');
check('快照里包含待办数据', snapText.includes('快照前的这条'), true);
check('快照里包含课程数据', snapText.includes('courses.json'), true);

// 模拟被写坏：清空待办库后从快照恢复
fsx.writeFileSync(process.env.DATA_DIR + '/todos.json', '{"version":1,"todos":[]}', 'utf8');

const restored = restoreBackup();
check('恢复成功', restored.restored.includes('todos.json'), true);
// 恢复后进程内 cache 还是旧的，直接读文件校验
const disk = JSON.parse(fsx.readFileSync(process.env.DATA_DIR + '/todos.json', 'utf8'));
check(
  '恢复后文件里找回那条待办',
  disk.todos.some((t) => t.title === '快照前的这条'),
  true
);

console.log('\n[23] 快照保留份数上限');
runBackup({ keep: 2 });
check('超过保留数会清掉旧的', listBackups().length <= 2, true);
check('至少还留一份', listBackups().length >= 1, true);

console.log('\n[24] 数据结构版本与迁移');
const { SCHEMA_VERSION, migrate, SchemaTooNewError } = await import('../src/store/schema.js');

const probe = `${process.env.DATA_DIR}/schema-probe.json`;
const cleanProbe = () => {
  fs.rmSync(probe, { force: true });
  fs.rmSync(`${probe}.v1.bak`, { force: true });
};
const readProbe = () => JSON.parse(fs.readFileSync(probe, 'utf8'));

check('当前结构版本是 1', SCHEMA_VERSION, 1);

// 写入侧：落盘的文件必须带上当前版本号，否则下次读的时候无从判断
const diskTodos = JSON.parse(fs.readFileSync(`${process.env.DATA_DIR}/todos.json`, 'utf8'));
check('落盘文件带当前版本号', diskTodos.version, SCHEMA_VERSION);

// 最早那批文件没有 version 字段，不能因为读不到版本就判死
cleanProbe();
fs.writeFileSync(probe, JSON.stringify({ todos: [{ id: 'a' }] }), 'utf8');
check('缺 version 的老文件按 v1 读', migrate(readProbe(), probe).todos.length, 1);
check('缺 version 不会产生备份', fs.existsSync(`${probe}.v1.bak`), false);

// 同版本：原样返回，不折腾
cleanProbe();
fs.writeFileSync(probe, JSON.stringify({ version: 1, todos: [] }), 'utf8');
migrate(readProbe(), probe);
check('同版本不产生备份文件', fs.existsSync(`${probe}.v1.bak`), false);

// 数据比程序新：必须拦住。这里是最容易出人命的一条——
// 旧代码读新数据会丢掉不认识的字段，一保存原文件就废了
cleanProbe();
const newerRaw = JSON.stringify({ version: 2, todos: [{ id: 'keep-me' }] });
fs.writeFileSync(probe, newerRaw, 'utf8');
let tooNew = null;
try {
  migrate(readProbe(), probe);
} catch (err) {
  tooNew = err;
}
check('版本比程序新会抛错', tooNew instanceof SchemaTooNewError, true);
check('抛错时提示更新程序', Boolean(tooNew && tooNew.message.includes('更新程序')), true);
check('抛错后原文件一个字节没动', fs.readFileSync(probe, 'utf8'), newerRaw);

// 真跑一次迁移：注入一张假的迁移表，验证升级循环和备份
cleanProbe();
fs.writeFileSync(probe, JSON.stringify({ version: 1, todos: [{ id: 'a', owner: '老王' }] }), 'utf8');
const upgraded = migrate(readProbe(), probe, {
  target: 2,
  migrations: {
    1: (d) => ({
      ...d,
      todos: d.todos.map(({ owner, ...rest }) => ({ ...rest, assignee: owner || '' })),
    }),
  },
});
check('迁移把 owner 搬到了 assignee', upgraded.todos[0].assignee, '老王');
check('迁移后旧字段不在了', 'owner' in upgraded.todos[0], false);
check('迁移后版本号前进到 2', upgraded.version, 2);
check('迁移前留了原件备份', fs.existsSync(`${probe}.v1.bak`), true);
check('备份是升级前的数据', JSON.parse(fs.readFileSync(`${probe}.v1.bak`, 'utf8')).version, 1);

// 只升了版本号却忘了写迁移函数：必须点名报错，不能静默跳过
cleanProbe();
fs.writeFileSync(probe, JSON.stringify({ version: 1, todos: [] }), 'utf8');
let noStep = null;
try {
  migrate(readProbe(), probe, { target: 2, migrations: {} });
} catch (err) {
  noStep = err;
}
check('缺迁移函数会报错', Boolean(noStep && noStep.message.includes('MIGRATIONS')), true);
cleanProbe();

console.log('\n[25] 数据版本不兼容时以退出码 78 停止');
const { spawnSync } = await import('node:child_process');

const badDir = `${process.env.DATA_DIR}/_badver`;
fs.mkdirSync(badDir, { recursive: true });
fs.writeFileSync(
  `${badDir}/todos.json`,
  JSON.stringify({ version: 99, todos: [{ id: 'x', title: '救命数据' }] }),
  'utf8'
);

// 真把进程拉起来跑一次。systemd 的 RestartPreventExitStatus 只认退出码，
// 光测 migrate() 证明不了这个码真的从 process.exit 传了出来。
const badRun = spawnSync(process.execPath, ['src/index.js'], {
  encoding: 'utf8',
  timeout: 20000,
  env: {
    ...process.env,
    DATA_DIR: badDir,
    QQ_APP_ID: 'selftest',
    QQ_APP_SECRET: 'selftest',
    LOG_LEVEL: 'error',
  },
});

check('退出码是 78（systemd 据此不重启）', badRun.status, 78);
check('报错说明数据版本不兼容', (badRun.stderr || '').includes('数据版本'), true);
check('没走到连 QQ 那一步', (badRun.stderr || '').includes('机器人已上线'), false);
check(
  '原数据文件没被改动',
  JSON.parse(fs.readFileSync(`${badDir}/todos.json`, 'utf8')).todos.length,
  1
);
fs.rmSync(badDir, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
