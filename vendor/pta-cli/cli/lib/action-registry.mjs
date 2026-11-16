// 面板动作注册表：每一个面板动作 = 这里的一项。
// 以后加功能只加注册项、不改框架；面板按 group 分组渲染按钮。
// 字段：
//   id：动作唯一标识（group.name）
//   group：分组（account / problemSet / solve / monitor / manage）
//   name：按钮文案；icon：按钮图标（emoji）；hint：悬停/下方说明
//   method + endpoint：调的服务端接口
//   confirm：false = 直接执行；字符串 = 二次确认文案（危险动作必须有）
//   allowedWhileRunning：任务运行中能不能点
//   form：取参数用的面板表单（login / run / retryOne / settings / none）
//   defaults：固定带上的参数
//   clientOnly：true = 纯前端动作，不调服务端接口（如复制配置、只读开关）
// 红线（RESEARCH.md §5.7“别做”6 条中的 5 条，不进注册表）：批量删/重跑、
// 面板改密码、定时全量跑、面板改提示词、多账号一键全开。
// 删账号原先也在“别做”里，但用户 2026-11-16 03:17 明确要求面板要能点，
// 故恢复进注册表，以双重确认为代价：面板二次确认 + 服务端显式 confirm:true，
// 且运行中 409。只清账号表状态、会话与凭据引用，账号目录（审计日志）保留备查。
export const GROUPS = [
  { id: 'account', name: '账号' },
  { id: 'problemSet', name: '题集' },
  { id: 'solve', name: '做题' },
  { id: 'monitor', name: '监控' },
  { id: 'manage', name: '管理' },
];

export const ACTIONS = [
  // ---- 账号 ----
  { id: 'account.login', group: 'account', name: '登录', icon: '🔑', method: 'POST', endpoint: '/api/login', confirm: false, allowedWhileRunning: true, form: 'login', hint: '输账号密码登录，密码只进内存' },
  { id: 'account.add', group: 'account', name: '添加账号', icon: '➕', method: 'POST', endpoint: '/api/login', confirm: false, allowedWhileRunning: true, form: 'login', hint: '和登录同一个接口：新账号就建出来' },
  { id: 'account.switch', group: 'account', name: '切换账号', icon: '🔀', method: 'POST', endpoint: '/api/account/select', confirm: false, allowedWhileRunning: false, form: 'run', hint: '把下拉框里选中的账号设为当前账号' },
  { id: 'account.ping', group: 'account', name: '一键测活', icon: '💓', method: 'POST', endpoint: '/api/account/ping', confirm: false, allowedWhileRunning: true, form: 'run', hint: '查一下当前账号的会话还活不活' },
  { id: 'account.logout', group: 'account', name: '登出', icon: '🚪', method: 'POST', endpoint: '/api/logout', confirm: false, allowedWhileRunning: false, form: 'run', hint: '清掉该账号的会话，下次要重新登录' },
  { id: 'account.toggle', group: 'account', name: '启用 / 停用切换', icon: '⏯️', method: 'POST', endpoint: '/api/account/toggle-enabled', confirm: false, allowedWhileRunning: false, form: 'run', hint: '停用的账号不会跑任务，不用删号重登' },
  { id: 'account.delete', group: 'account', name: '删除账号', icon: '🗑️', method: 'POST', endpoint: '/api/account/delete', confirm: '确定删除这个账号吗？会话和凭据引用会清掉，审计日志保留备查。', allowedWhileRunning: false, form: 'run', hint: '危险动作：双重确认。清账号状态、会话与凭据引用，审计日志保留' },
  // ---- 题集 ----
  { id: 'set.list', group: 'problemSet', name: '拉取题集列表', icon: '📚', method: 'GET', endpoint: '/api/problem-sets', confirm: false, allowedWhileRunning: true, form: 'run', hint: '刷新下拉框里的题集列表' },
  { id: 'set.refresh', group: 'problemSet', name: '刷新', icon: '🔄', method: 'POST', endpoint: '/api/refresh', confirm: false, allowedWhileRunning: true, form: 'run', hint: '重新拉题集 + 每题状态，写回看板' },
  { id: 'set.problems', group: 'problemSet', name: '查看题目列表', icon: '📝', method: 'GET', endpoint: '/api/problems', confirm: false, allowedWhileRunning: true, form: 'run', hint: '看选中题集里每道题的题型、分值、状态' },
  { id: 'set.start', group: 'problemSet', name: '选定题集开始做', icon: '▶️', method: 'POST', endpoint: '/api/run', confirm: '将真实提交答案到 PTA，确认开始做这个题集吗？', allowedWhileRunning: false, form: 'run', defaults: { mode: 'all', yes: true }, hint: '危险动作：真提交。等于“一键完成作业”' },
  { id: 'set.pause', group: 'problemSet', name: '暂停', icon: '⏸️', method: 'POST', endpoint: '/api/pause', confirm: false, allowedWhileRunning: true, form: 'none', hint: '当前题做完后停住，等你点继续' },
  { id: 'set.resume', group: 'problemSet', name: '继续', icon: '▶️', method: 'POST', endpoint: '/api/resume', confirm: false, allowedWhileRunning: true, form: 'none', hint: '从暂停处接着做' },
  { id: 'set.stop', group: 'problemSet', name: '停止', icon: '⏹️', method: 'POST', endpoint: '/api/stop', confirm: '确定停止当前任务吗？正在做的这道题不会提交。', allowedWhileRunning: true, form: 'none', hint: '危险动作：停掉当前任务' },
  // ---- 做题 ----
  { id: 'solve.all', group: 'solve', name: '一键完成作业', icon: '🚀', method: 'POST', endpoint: '/api/run', confirm: '将真实提交答案到 PTA，确认一键完成吗？', allowedWhileRunning: false, form: 'run', defaults: { mode: 'all', yes: true }, hint: '危险动作：真提交。全自动做完选中题集' },
  { id: 'solve.todo', group: 'solve', name: '只做未完成的', icon: '📋', method: 'POST', endpoint: '/api/run', confirm: '将真实提交答案到 PTA，确认只做未完成的题吗？', allowedWhileRunning: false, form: 'run', defaults: { mode: 'todo', yes: true }, hint: '危险动作：真提交。只做还没答过的题' },
  { id: 'solve.wrong', group: 'solve', name: '只做错题', icon: '❌', method: 'POST', endpoint: '/api/run', confirm: '将真实提交答案到 PTA，确认只重做错题吗？', allowedWhileRunning: false, form: 'run', defaults: { mode: 'wrong', yes: true }, hint: '危险动作：真提交。只重做答错 / 部分通过的题' },
  { id: 'solve.retryOne', group: 'solve', name: '单题重做', icon: '🎯', method: 'POST', endpoint: '/api/run', confirm: '将真实提交这道题的答案到 PTA，确认重做吗？', allowedWhileRunning: false, form: 'retryOne', defaults: { mode: 'one', yes: true }, hint: '危险动作：真提交。只重做下面填的那一道题' },
  { id: 'solve.skipOne', group: 'solve', name: '单题跳过', icon: '⏭️', method: 'POST', endpoint: '/api/problem/skip', confirm: false, allowedWhileRunning: true, form: 'retryOne', defaults: { skip: true }, hint: '把下面填的那道题加入跳过清单（运行中点也生效，下一题开始前检查）；取消跳过用同一接口 skip=false' },
  { id: 'solve.detail', group: 'solve', name: '查看单题详情', icon: '🔍', method: 'GET', endpoint: '/api/problem', confirm: false, allowedWhileRunning: true, form: 'retryOne', hint: '看下面填的那道题的题面、答案状态、最近一次判题（不跳平台页面）' },
  { id: 'solve.preview', group: 'solve', name: '只解题不提交', icon: '👁️', method: 'POST', endpoint: '/api/run', confirm: false, allowedWhileRunning: false, form: 'run', defaults: { mode: 'all', yes: false }, hint: '只解题 + 本地自测，不提交，先看答案预览' },
  // ---- 监控 ----
  { id: 'monitor.progress', group: 'monitor', name: '实时进度', icon: '📊', method: 'GET', endpoint: '/api/state', confirm: false, allowedWhileRunning: true, form: 'none', hint: '立即刷新一次进度（平时每 5 秒自动刷）' },
  { id: 'monitor.review', group: 'monitor', name: '查看待复核', icon: '🧐', method: 'GET', endpoint: '/api/review', confirm: false, allowedWhileRunning: true, form: 'run', hint: '低置信 / 停表 / 自测失败的题都在这里，等人验收或返工（最多返工 5 次）' },
  { id: 'monitor.acceptReview', group: 'monitor', name: '验收通过', icon: '✅', method: 'POST', endpoint: '/api/review/accept', confirm: false, allowedWhileRunning: true, form: 'review', hint: '把下面选中的待复核题标记为已验收（人工已看过，不再自动处理）' },
  { id: 'monitor.reworkReview', group: 'monitor', name: '返工重做', icon: '🔧', method: 'POST', endpoint: '/api/review/rework', confirm: '将真实提交这道题的答案到 PTA，确认返工重做吗？', allowedWhileRunning: false, form: 'review', hint: '危险动作：真提交。把下面选中的待复核题再跑一遍；同一题最多返工 5 次' },
  { id: 'monitor.audit', group: 'monitor', name: '提交历史 / 审计日志', icon: '📜', method: 'GET', endpoint: '/api/audit', confirm: false, allowedWhileRunning: true, form: 'run', hint: '看该账号最近的操作记录' },
  { id: 'monitor.retryFailed', group: 'monitor', name: '失败重试', icon: '🔁', method: 'POST', endpoint: '/api/run', confirm: '将真实提交错题答案到 PTA，确认重试失败的题吗？', allowedWhileRunning: false, form: 'run', defaults: { mode: 'wrong', yes: true }, hint: '危险动作：真提交。把失败的题再跑一遍' },
  { id: 'monitor.pace', group: 'monitor', name: '节律档位切换', icon: '⏱️', method: 'POST', endpoint: '/api/pace', confirm: false, allowedWhileRunning: true, form: 'run', hint: '慢 / 正常 / 快：运行中的任务下一次等待就用新档位' },
  // ---- 管理 ----
  { id: 'manage.report', group: 'manage', name: '导出报告', icon: '📄', method: 'GET', endpoint: '/api/report', confirm: false, allowedWhileRunning: true, form: 'run', hint: '下载一份 Markdown 报告（完成情况 + 审计）' },
  { id: 'manage.clearCache', group: 'manage', name: '清理缓存', icon: '🧹', method: 'POST', endpoint: '/api/cache/clear', confirm: '确定清理该账号的进度缓存吗？审计日志和会话不受影响。', allowedWhileRunning: false, form: 'run', hint: '删进度缓存文件，不动日志和会话' },
  { id: 'manage.exportLog', group: 'manage', name: '导出日志', icon: '💾', method: 'GET', endpoint: '/api/audit/download', confirm: false, allowedWhileRunning: true, form: 'run', hint: '下载该账号的审计日志（JSONL）' },
  { id: 'manage.copyConfig', group: 'manage', name: '复制任务配置为 JSON', icon: '📋', method: 'GET', endpoint: '', confirm: false, allowedWhileRunning: true, form: 'run', clientOnly: true, hint: '把当前表单里的任务配置（账号/题集/模式/节律/模型）复制为 JSON，换个题集复用' },
  { id: 'manage.readonly', group: 'manage', name: '只读模式开关', icon: '🔒', method: 'GET', endpoint: '', confirm: false, allowedWhileRunning: true, form: 'none', clientOnly: true, hint: '一键隐藏全部写按钮（演示 / 给别人看时防误点），再点一次恢复' },
  { id: 'manage.settings', group: 'manage', name: '保存设置', icon: '⚙️', method: 'POST', endpoint: '/api/settings', confirm: false, allowedWhileRunning: true, form: 'settings', hint: '保存重试次数、DS 模型、默认节律档位' },
];

export function getAction(id) {
  return ACTIONS.find((a) => a.id === id) || null;
}

export function actionsByGroup() {
  const out = [];
  for (const g of GROUPS) {
    out.push({ ...g, actions: ACTIONS.filter((a) => a.group === g.id) });
  }
  return out;
}
