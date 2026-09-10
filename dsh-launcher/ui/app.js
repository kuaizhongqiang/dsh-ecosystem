/* app.js —— dsh-launcher 界面逻辑（v0.9 分区化信息架构 + 折叠 + 概览卡；#17/#18/#19）
   预览模式：默认跑模拟数据（window.launcherBridge 不存在时）。
   真实模式：Node SEA 内嵌 http 服务在页面注入 window.launcherBridge（REST + SSE），
   本文件自动切换。 */

'use strict';

/* ---------- 模拟桥接层 ---------- */

const mockUi = { collapsed: {}, log: { errorsOnly: 'all', maxLines: 2000 }, layout: {} };
const mockConns = {
  active: 'local-3080',
  fromFile: false,
  list: [
    { id: 'local-3080', kind: 'local', name: '本机 dsh', port: 3080, hasToken: false },
    { id: 'wan-main', kind: 'remote', name: '广域网 dsh', url: 'https://dsh.example.com', hasToken: true },
  ],
};

const mock = {
  async getStatus() {
    return {
      node: { present: true, version: 'v24.14.0' },
      npm:  { present: true, version: '11.3.2' },
      dsh:  { installed: true, version: 'v0.1.0-rc.7' },
      port: { number: 3080, running: state.running },
      connection: { id: 'local-3080', kind: 'local', name: '本机 dsh', port: 3080, url: '' },
      components: { vscode: '', desktop: '' },
      update: { checking: false, dshAvail: false, launcherAvail: false },
      defaultDir: 'C:\\Users\\kua\\AppData\\Local\\dsh',
      installedDir: 'C:\\Users\\kua\\AppData\\Local\\dsh',
    };
  },
  async getUiState() { return JSON.parse(JSON.stringify(mockUi)); },
  async setUiState(patch) {
    if (patch.collapsed) mockUi.collapsed = { ...mockUi.collapsed, ...patch.collapsed };
    if (patch.log) mockUi.log = { ...mockUi.log, ...patch.log };
    if (patch.layout) mockUi.layout = { ...mockUi.layout, ...patch.layout };
    return JSON.parse(JSON.stringify(mockUi));
  },
  async open() { log('预览模式：打开 UI（模拟）。', 'ok'); return { ok: true }; },
  async start() { await delay(900); return { ok: true }; },
  async stop()  { await delay(700); return { ok: true }; },
  async install(dir, source, version, proxy) {
    await delay(300);
    streamInstallLogs();
    await delay(2600);
    return { ok: true };
  },
  async getTags() {
    return { ok: true, tags: ['dsh-v0.1.2-alpha.1', 'dsh-v0.1.1-rc.2', 'dsh-v0.1.1-rc.1', 'dsh-v0.1.0-rc.8'] };
  },
  async move(dir) { await delay(800); return { ok: true }; },
  async checkUpdate() { await delay(1200); return { dshAvail: false, launcherAvail: false }; },
  async browse() { return 'C:\\Users\\kua\\AppData\\Local\\dsh'; },
  async getEcosystem() {
    return {
      ok: true,
      busy: false,
      label: '默认（内嵌）',
      manifest: {
        dsh: { source: 'github', version: 'latest' },
        pluginsCommit: '15ffcfd7',
        packages: [
          { id: 'credentials', dir: 'plugins/credentials-dsh-plugin', installSha: 'a1b2c3d4e5f6', fileCount: 1 },
          { id: 'stock', dir: 'plugins/stock-dsh-plugin', installSha: '123456789abc', fileCount: 1 },
          { id: 'github', dir: 'plugins/github-dsh-plugin', installSha: 'fedcba987654', fileCount: 1 },
        ],
        skills: true,
      },
      state: null,
      pluginsDir: 'C:\\Users\\kua\\.dsh\\dsh-plugins',
    };
  },
  async pullEcosystem(opts) {
    await delay(300);
    streamEcoLogs();
    await delay(2200);
    return { ok: true };
  },
  async updateEcosystem(opts) {
    await delay(300);
    streamUpdateLogs();
    await delay(3200);
    return { ok: true };
  },
  async getConnections() {
    return { ok: true, ...mockConns, list: mockConns.list.map((c) => ({ ...c })) };
  },
  async useConnection(id) { await delay(300); mockConns.active = id; return { ok: true, active: id }; },
  async removeConnection(id) {
    await delay(200);
    mockConns.list = mockConns.list.filter((c) => c.id !== id);
    if (mockConns.active === id && mockConns.list.length) mockConns.active = mockConns.list[0].id;
    return { ok: true };
  },
  async restartDsh() { await delay(600); return { ok: true }; },
  async setupFlow(opts) {
    await delay(400);
    streamEcoLogs();
    streamInstallLogs();
    await delay(2200);
    return { ok: true };
  },
};

const bridge = window.launcherBridge || mock;

/* ---------- 模拟状态 ---------- */

const state = {
  busy: false,
  running: false,
  installed: true,
  updating: false,
};

let lastStatus = null;   // 最近一次 getStatus() 原始数据（概览行/卡片摘要消费）
let lastEco = null;      // 最近一次 getEcosystem() 数据（chips / 明细消费）
let uiState = { collapsed: {}, log: { errorsOnly: 'all', maxLines: 2000 }, layout: {} };
let uiStateLoaded = false;

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------- DOM ---------- */

const $ = (id) => document.getElementById(id);
const fields = {
  node: $('node'), npm: $('npm'), dsh: $('dsh'), port: $('port'), update: $('update'),
};
const rowEls = {
  node: document.querySelector('[data-key="node"] .dot'),
  npm: document.querySelector('[data-key="npm"] .dot'),
  dsh: document.querySelector('[data-key="dsh"] .dot'),
  port: document.querySelector('[data-key="port"] .dot'),
  update: document.querySelector('[data-key="update"] .dot'),
};
const logBox = $('log');

/* ---------- UI 状态（#18：折叠/日志记忆，经后端桥持久化） ---------- */

/** 卡片默认展开态（首帧无记忆时用；dsh 未安装时 install 卡自动展开）。 */
const CARD_DEFAULTS = {
  'card-install': false,
  'card-eco': true,
  'card-conn': false,
  'card-log': true,
  'card-settings': false,
};
const CARD_IDS = Object.keys(CARD_DEFAULTS);

let uiSaveTimer = 0;
function persistUi(delayMs = 300) {
  clearTimeout(uiSaveTimer);
  uiSaveTimer = setTimeout(() => {
    const patch = { collapsed: { ...uiState.collapsed }, log: { ...uiState.log } };
    if (bridge.setUiState) {
      bridge.setUiState(patch).catch(() => { /* 预览/无持久化时静默 */ });
    }
  }, delayMs);
}

function cardBodyId(cardId) { return cardId.replace(/^card-/, 'card-body-'); }

function setCardExpanded(cardId, expanded, persist = true) {
  const head = document.querySelector(`#${cardId} .card-head`);
  const body = $(cardBodyId(cardId));
  if (!head || !body) return;
  head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  body.hidden = !expanded;
  uiState.collapsed[cardId] = expanded;
  if (persist) persistUi();
  scheduleAutoSize();
}

function toggleCard(cardId) {
  const head = document.querySelector(`#${cardId} .card-head`);
  const expanded = head ? head.getAttribute('aria-expanded') !== 'true' : true;
  setCardExpanded(cardId, expanded);
}

function expandCardAndJump(cardId) {
  const card = $(cardId);
  if (!card) return;
  const head = card.querySelector('.card-head');
  const expanded = head ? head.getAttribute('aria-expanded') === 'true' : false;
  if (!expanded) setCardExpanded(cardId, true);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 折叠语义归一：collapsed map 记的是"是否展开"（历史兼容：key 缺省用默认）。 */
function applyUiState(saved) {
  if (!saved) return;
  if (saved.collapsed) uiState.collapsed = { ...saved.collapsed };
  if (saved.log) uiState.log = { ...(uiState.log || {}), ...saved.log };
  if (saved.layout) uiState.layout = { ...saved.layout };
  uiStateLoaded = true;
  for (const cardId of CARD_IDS) {
    const has = Object.prototype.hasOwnProperty.call(uiState.collapsed, cardId);
    // dsh 未安装时强制展开安装卡（除非用户已显式记忆）
    let expanded = has ? !!uiState.collapsed[cardId] : !!CARD_DEFAULTS[cardId];
    if (!has && cardId === 'card-install' && state.installed === false) expanded = true;
    setCardExpanded(cardId, expanded, false);
  }
  applyLogPrefs();
}

function resetLayout() {
  uiState.collapsed = {};
  uiState.log = { errorsOnly: 'all', maxLines: 2000 };
  applyUiState(uiState); // 重新走默认逻辑（含未安装展开安装卡）
  persistUi(0);
  log('已恢复默认布局（折叠/日志偏好已重置）。', 'ok');
}

/* ---------- 日志（#18：buffer + 过滤 + 贴底跟随，SSE 不变） ---------- */

const FILTERS = ['all', 'warn-err', 'err'];
const FILTER_LABEL = { all: '全部', 'warn-err': '警告+错误', err: '仅错误' };

const logState = {
  filter: 'all',
  follow: true,
  lines: [],           // 环形缓冲（含被过滤行），容量 maxLines
  domCount: 0,         // 当前 DOM 行数
  pendingNew: 0,       // 暂停跟随期间新到行数
};

function errLike(line) { return /error|fail|失败|错误|拒绝/i.test(line); }

function lineMatchesFilter(line, kind) {
  if (logState.filter === 'all') return true;
  const isErr = kind === 'err' || errLike(line);
  if (logState.filter === 'err') return isErr;
  // warn-err：错误 + 警告
  return isErr || kind === 'warn';
}

function logSubText() {
  const max = uiState.log.maxLines || 2000;
  const cap = Math.min(logState.lines.length, max);
  return `${cap} 行` + (logState.filter !== 'all' ? ` · 只看${FILTER_LABEL[logState.filter]}` : '');
}

function logCountEl() { return $('logCount'); }

function applyLogPrefs() {
  logState.filter = uiState.log.errorsOnly || 'all';
  $('logErrors').textContent = '只看错误：' + FILTER_LABEL[logState.filter];
  $('logErrors').title = '循环：全部 → 警告+错误 → 仅错误（当前：' + FILTER_LABEL[logState.filter] + '）';
  const max = Math.max(uiState.log.maxLines || 2000, 200);
  if (logState.lines.length > max) logState.lines.splice(0, logState.lines.length - max);
  rebuildLogDom();
}

function atBottom() {
  return logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 24;
}

function scrollLogToBottom() {
  logBox.scrollTop = logBox.scrollHeight;
  logState.pendingNew = 0;
  const n = $('logNew');
  n.hidden = true;
}

function appendLogLine(line, kind) {
  const max = Math.max(uiState.log.maxLines || 2000, 200);
  logState.lines.push({ text: line, kind });
  if (logState.lines.length > max) {
    const removed = logState.lines.splice(0, logState.lines.length - max);
    // 若被移除行已在 DOM 中（可见），整体重绘保证一致性
    if (removed.some((r) => lineMatchesFilter(r.text, r.kind))) rebuildLogDom();
  }
  const visible = lineMatchesFilter(line, kind);
  if (visible) {
    appendLogDom(line, kind);
    const stick = logState.follow || atBottom();
    if (logState.follow && stick) {
      logBox.scrollTop = logBox.scrollHeight;
    } else if (!atBottom()) {
      logState.pendingNew += 1;
      const n = $('logNew');
      n.textContent = logState.pendingNew + ' 条新日志 · 回到底部';
      n.hidden = false;
    }
  }
  const sub = $('logSub');
  if (sub) sub.textContent = logSubText();
}

function appendLogDom(line, kind) {
  const el = document.createElement('div');
  const hasTs = /^\[\d{4}-\d{2}-\d{2}/.test(line);
  if (!hasTs) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const time = document.createElement('span');
    time.className = 'line-time';
    time.textContent = '[' + t + ']';
    el.appendChild(time);
  }
  const text = document.createElement('span');
  text.className = 'line-' + kind;
  text.textContent = line;
  el.appendChild(text);
  logBox.appendChild(el);
  logState.domCount += 1;
}

function rebuildLogDom() {
  logBox.textContent = '';
  logState.domCount = 0;
  for (const l of logState.lines) {
    if (lineMatchesFilter(l.text, l.kind)) appendLogDom(l.text, l.kind);
  }
  if (logState.follow) scrollLogToBottom();
  const sub = $('logSub');
  if (sub) sub.textContent = logSubText();
}

/** 对外日志入口（服务端 SSE 与本地行都走这里）。 */
function log(line, kind = '') {
  appendLogLine(line, kind);
}

function clearLog() {
  logState.lines = [];
  logBox.textContent = '';
  logState.domCount = 0;
  logState.pendingNew = 0;
  $('logNew').hidden = true;
  log('日志已清空。', 'dim');
}

function cycleLogFilter() {
  const idx = (FILTERS.indexOf(logState.filter) + 1) % FILTERS.length;
  logState.filter = FILTERS[idx];
  uiState.log.errorsOnly = logState.filter;
  $('logErrors').textContent = '只看错误：' + FILTER_LABEL[logState.filter];
  rebuildLogDom();
  persistUi();
}

function streamInstallLogs() {
  const lines = [
    ['检测 npm 源：registry.npmjs.org …', ''],
    ['官方源延迟 42ms，使用官方源', ''],
    ['npm install -g --prefix C:\\Users\\kua\\AppData\\Local\\dsh @deepseek-ai/dsh', 'brand'],
    ['added 218 packages in 9.1s', 'ok'],
    ['dsh 安装完成（v0.1.0-rc.7）', 'ok'],
  ];
  lines.forEach(([text, kind], i) => setTimeout(() => log(text, kind), 350 + i * 420));
}

/* ---------- 渲染状态 ---------- */

function setDot(key, cls) {
  rowEls[key].className = 'dot ' + cls;
}

function setValue(key, text, cls = '') {
  fields[key].textContent = text;
  fields[key].className = 'row-value' + (cls ? ' is-' + cls : '');
}

/* ---------- 概览行（#19）：连接 + 组件版本 chips ---------- */

function ovChip(text, opts = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip' + (opts.jump ? ' chip-link' : '');
  b.textContent = text;
  b.title = opts.title || '';
  if (opts.jump) b.dataset.jump = opts.jump;
  return b;
}

function renderOverviewLine() {
  const connDot = $('connDot');
  const connName = $('connName');
  const s = lastStatus;
  if (s && s.connection) {
    const c = s.connection;
    connName.textContent = '连接：' + (c.name || c.id) +
      (c.kind === 'local' ? '' : '（remote）') +
      (c.kind === 'remote' ? (s.port.running ? ' · 可达' : ' · 不可达') : '');
    connDot.className = 'dot ' + (s.port.running ? 'dot-green' : (c.kind === 'remote' ? 'dot-red' : 'dot-dim'));
    connName.title = c.url || c.id;
  } else {
    connName.textContent = '连接：—';
  }
  // 组件版本 chips
  const line = $('chipLine');
  line.textContent = '';
  const launcherVer = window.launcherVersion || 'v?';
  line.appendChild(ovChip('launcher ' + launcherVer, { title: '本启动器版本' }));
  if (s && s.components) {
    line.appendChild(ovChip('vscode ' + (s.components.vscode || '—'), { title: s.components.vscode ? '已检测 vscode 扩展版本' : '未检测到 vscode 扩展（安装后显示）' }));
    line.appendChild(ovChip('desktop ' + (s.components.desktop || '—'), { title: s.components.desktop ? '已检测 desktop 版本' : '未检测到 desktop（安装后显示）' }));
  }
  if (lastEco && lastEco.manifest) {
    const commit = (lastEco.manifest.pluginsCommit || '').slice(0, 8);
    line.appendChild(ovChip('插件集 ' + commit, {
      jump: 'card-eco',
      title: '点此查看插件清单（滚动到生态卡并展开）',
    }));
  }
}

/* ---------- 状态刷新 ---------- */

async function refreshStatus() {
  // 状态刷新永不应把界面卡死：失败只记日志，返回 false 供调用方重试。
  let s;
  try {
    s = await bridge.getStatus();
  } catch (e) {
    log('状态检测失败：' + e.message, 'err');
    return false;
  }
  lastStatus = s;
  // 同步状态，供按钮启用/文案使用（此前只更新显示、未同步 state）
  state.installed = s.dsh.installed;
  state.running = s.port.running;
  if (s.node.present) {
    setValue('node', s.node.version);
    setDot('node', 'dot-green');
  } else {
    setValue('node', '未安装');
    setDot('node', 'dot-red');
  }
  if (s.npm.present) {
    setValue('npm', s.npm.version);
    setDot('npm', 'dot-green');
  } else {
    setValue('npm', '未安装');
    setDot('npm', 'dot-red');
  }
  if (s.dsh.installed) {
    setValue('dsh', s.dsh.version);
    setDot('dsh', 'dot-green');
  } else {
    setValue('dsh', '未安装');
    setDot('dsh', 'dot-red');
  }
  if (s.dsh.installed) {
    if (s.port.running) {
      setValue('port', s.port.number + ' 运行中', 'green');
      setDot('port', 'dot-green');
    } else {
      setValue('port', s.port.number + ' 未运行', 'dim');
      setDot('port', 'dot-dim');
    }
  } else {
    setValue('port', '—', 'dim');
    setDot('port', 'dot-dim');
  }
  // M5：激活连接为 remote 时，端口行改为连接语义（HTTP ping）
  if (s.connection && s.connection.kind === 'remote') {
    setValue('port', s.connection.id + ' ' + (s.port.running ? '可达' : '不可达'), s.port.running ? 'green' : 'red');
    setDot('port', s.port.running ? 'dot-green' : 'dot-red');
  }
  if (s.update.checking) {
    setValue('update', '正在检查…', 'dim');
    setDot('update', 'dot-dim');
  } else if (s.update.dshAvail || s.update.launcherAvail) {
    setValue('update', '有新版本可升级', 'brand');
    setDot('update', 'dot-brand');
  } else {
    setValue('update', '已是最新', 'green');
    setDot('update', 'dot-green');
  }
  // #19：概览行 + 分区摘要联动
  renderOverviewLine();
  const installSub = $('installSub');
  if (installSub) {
    installSub.textContent = s.dsh.installed
      ? 'dsh ' + (s.dsh.version || 'v?') + (s.installedDir ? ' · ' + s.installedDir : '')
      : '未安装 —— 请在下方安装后使用「一键部署」';
  }
  const dirEl = $('settingsDir');
  if (dirEl) dirEl.value = s.installedDir || s.defaultDir || '';
  return true;
}

function renderButtons() {
  const start = $('btnStart');
  start.textContent = state.running ? '已运行' : '启动';
  start.disabled = state.busy;
  $('btnStop').disabled = state.busy || !state.running;
  $('btnRestart').disabled = state.busy;
  $('btnInstall').disabled = state.busy;
  $('btnMove').disabled = state.busy;
  $('btnBrowse').disabled = state.busy;
  $('btnUpdate').disabled = state.busy || state.updating;
  $('btnUpdate').textContent = state.updating ? '检查中…' : '检查更新';
  const q = $('btnQuickUpdate');
  q.disabled = state.busy || state.updating;
  $('btnSetup').disabled = state.busy;
  $('btnOpenUI').disabled = state.busy || !state.installed;
  if (typeof renderEcoButtons === 'function') renderEcoButtons();
}

function setBusy(b) {
  state.busy = b;
  renderButtons();
}

function setProgress(on, text) {
  $('progress').hidden = !on;
  if (text) $('progressText').textContent = text;
}

/* ---------- 交互 ---------- */

async function onStart() {
  if (state.busy) return;
  if (state.running) { log('dsh 已在运行，打开浏览器…', 'ok'); return; }
  setBusy(true);
  log('启动 dsh…', 'brand');
  try {
    const r = await bridge.start();
    if (!r.ok) throw new Error(r.message || '启动失败');
    state.running = true;
    log(r.already ? 'dsh 已在运行，已打开浏览器。' : 'dsh 已启动（关闭启动器将同时停止 dsh）。', 'ok');
  } catch (e) {
    log('启动失败：' + e.message, 'err');
  }
  setBusy(false);
  await refreshStatus();
  renderButtons();
}

async function onOpenUI() {
  log('打开 dsh UI…', 'brand');
  try {
    const r = await bridge.open();
    if (!r.ok) throw new Error(r.message || '打开失败');
    log('已在默认浏览器打开 dsh UI：' + (r.url || ''), 'ok');
  } catch (e) {
    log('打开 UI 失败：' + e.message + '（可先「启动」dsh）', 'err');
  }
}

async function onStop() {
  if (state.busy || !state.running) return;
  setBusy(true);
  log('停止 dsh（端口 3080）…', 'brand');
  try {
    const r = await bridge.stop();
    if (!r.ok) throw new Error(r.message || '停止失败');
    state.running = false;
    log('已停止 dsh。', 'ok');
  } catch (e) {
    log('停止失败：' + e.message, 'err');
  }
  setBusy(false);
  await refreshStatus();
  renderButtons();
}

async function onInstall() {
  if (state.busy) return;
  const dir = $('pathInput').value.trim();
  if (!dir) { log('请先选择安装目录。', 'warn'); return; }
  const version = $('verSelect').value || '';
  setBusy(true);
  setProgress(true, version ? '安装中（' + version + '）…' : '安装中（最新版）…');
  log('开始安装到 ' + dir + (version ? '（版本 ' + version + '）' : '（最新版）') + ' …', 'brand');
  try {
    const r = await bridge.install(dir, 'github', version, '');
    if (!r.ok) throw new Error(r.message || '安装失败');
    state.installed = true;
    log('安装完成。可以点击「启动」。', 'ok');
  } catch (e) {
    log('安装失败：' + e.message, 'err');
  }
  setProgress(false);
  setBusy(false);
  await refreshStatus();
  renderButtons();
  applyUiState(uiState); // 安装态变化可能影响默认展开（未安装→展开安装卡）
}

/** 从 GitHub 拉取可选版本列表填入下拉框。 */
async function refreshTags() {
  if (!bridge.getTags) return;
  const sel = $('verSelect');
  const prev = sel.value;
  const keep = [sel.options[0]];
  try {
    const r = await bridge.getTags();
    if (r && Array.isArray(r.tags) && r.tags.length > 0) {
      for (const t of r.tags) {
        const o = document.createElement('option');
        o.value = t;
        o.textContent = t;
        keep.push(o);
      }
    } else if (r && r.message) {
      log('版本列表获取失败：' + r.message, 'warn');
    }
  } catch (e) {
    log('版本列表获取失败：' + e.message, 'warn');
  }
  sel.replaceChildren(...keep);
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function onMove() {
  if (state.busy) return;
  const dir = await bridge.browse();
  if (!dir) { log('已取消移动。', 'dim'); return; }
  setBusy(true);
  log('移动 dsh 到 ' + dir + ' …', 'brand');
  try {
    const r = await bridge.move(dir);
    if (!r.ok) throw new Error(r.message || '移动失败');
    $('pathInput').value = dir;
    log('移动完成。', 'ok');
  } catch (e) {
    log('移动失败：' + e.message, 'err');
  }
  setBusy(false);
  renderButtons();
}

async function onBrowse() {
  if (state.busy) return;
  const dir = await bridge.browse();
  if (dir) {
    $('pathInput').value = dir;
    log('安装目录：' + dir, '');
  }
}

async function onUpdate() {
  if (state.busy || state.updating) return;
  state.updating = true;
  renderButtons();
  log('检查更新：dsh（GitHub tag / npm registry）与启动器（GitHub Release）…', 'brand');
  try {
    const r = await bridge.checkUpdate();
    if (r.dshAvail || r.launcherAvail) {
      const parts = [];
      if (r.dshAvail) parts.push('dsh → ' + (r.dshLatest || '最新'));
      if (r.launcherAvail) parts.push('启动器 → ' + (r.launcherLatest || '最新'));
      log('发现新版本（' + parts.join('；') + '）。dsh 运行「安装」即升级，启动器到 GitHub Release 下载。', 'warn');
    } else {
      log('dsh 与启动器均已是最新。', 'ok');
    }
  } catch (e) {
    log('更新检测失败：' + e.message, 'err');
  }
  state.updating = false;
  await refreshStatus();
  renderButtons();
}

/* ---------- 生态（M2） ---------- */

const eco = { busy: false, updating: false, dry: false, rows: {} };

function streamEcoLogs() {
  const lines = [
    ['生态清单：默认（内嵌）', ''],
    ['插件源锁定：15ffcfd7（https://github.com/kuaizhongqiang/dsh-plugins.git）', ''],
    ['sha256 ✓ plugins/credentials-dsh-plugin/install.ps1', 'ok'],
    ['插件 credentials 安装完成', 'ok'],
    ['生态状态已写入 ecosystem-state.json', 'ok'],
  ];
  lines.forEach(([t, k], i) => setTimeout(() => log(t, k), 350 + i * 320));
}

/* 一键更新插件的模拟日志（真实模式由服务端 SSE 推送，此仅供预览 mock） */
function streamUpdateLogs() {
  const lines = [
    ['一键更新插件开始（GUI 触发）……', ''],
    ['当前插件源：9a6427e0（默认（内嵌））', ''],
    ['发现新插件源 148e94cc：同步检出……', ''],
    ['插件源已同步：148e94cc', 'ok'],
    ['读取伞仓自声明清单：sync@148e94cc', ''],
    ['sha256 ✓ dsh-plugins/plugins/stock-dsh-plugin/install.ps1', 'ok'],
    ['插件 stock 安装完成（v0.2.0）', 'ok'],
    ['技能安装完成', 'ok'],
    ['重启 dsh（让新插件与技能生效）……', 'brand'],
    ['dsh 已重启。', 'ok'],
    ['一键更新完成。', 'ok'],
  ];
  lines.forEach(([t, k], i) => setTimeout(() => log(t, k), 350 + i * 380));
}

function ecoChip(okFlag) {
  const s = document.createElement('span');
  s.className = 'eco-chip ' + (okFlag ? 'ok' : 'no');
  s.textContent = okFlag ? '已装' : '未装';
  return s;
}

function ecoCheckedIds() {
  return Object.keys(eco.rows).filter((id) => eco.rows[id] && eco.rows[id].checked);
}

function renderEcoButtons() {
  const busy = state.busy || eco.busy || eco.updating;
  $('btnEcoPull').disabled = busy;
  $('btnEcoDry').disabled = busy || ecoCheckedIds().length === 0;
  $('btnEcoRefresh').disabled = busy;
  $('btnEcoUpdate').disabled = busy;
  const q = $('btnQuickUpdate');
  q.textContent = eco.updating ? '更新中…' : (eco.busy ? '拉齐中…' : '一键更新');
  $('btnEcoPull').textContent = eco.busy ? '拉齐中…' : (eco.dry ? '校验中…' : '拉齐勾选项');
  $('btnEcoDry').textContent = eco.dry ? '校验中…' : '仅校验（dry-run）';
  $('btnEcoUpdate').textContent = eco.updating ? '更新中…' : '一键更新插件';
}

function renderEcoDetail(d) {
  // #18：生态明细（id / dir / install.ps1 sha256 前缀 / 声明文件数）——展开卡内可见
  const box = $('ecoDetail');
  const pkgs = d.manifest.packages || [];
  if (!pkgs.length) { box.hidden = true; return; }
  box.hidden = false;
  box.textContent = '';
  const title = document.createElement('div');
  title.className = 'eco-detail-title';
  title.textContent = '包清单明细（sha256 = install.ps1 前 12 位）';
  box.appendChild(title);
  for (const p of pkgs) {
    const row = document.createElement('div');
    row.className = 'eco-detail-row';
    const idSpan = document.createElement('span');
    idSpan.className = 'eco-detail-id';
    idSpan.textContent = p.id;
    const dirSpan = document.createElement('span');
    dirSpan.className = 'eco-detail-dir';
    dirSpan.textContent = p.dir || '';
    const shaSpan = document.createElement('span');
    shaSpan.className = 'eco-detail-sha';
    shaSpan.textContent = 'sha256 ' + (p.installSha ? p.installSha + '…' : '—') + ' · ' + (p.fileCount || 0) + ' 文件';
    row.append(idSpan, dirSpan, shaSpan);
    box.appendChild(row);
  }
}

async function refreshEcosystem() {
  let d;
  try {
    d = await bridge.getEcosystem();
  } catch (e) {
    log('生态状态读取失败：' + e.message, 'err');
    return;
  }
  if (!d || !d.ok) {
    log('生态状态读取失败：' + (d && d.message ? d.message : '未知错误'), 'err');
    return;
  }
  lastEco = d;
  eco.busy = !!d.busy;
  const commit = (d.manifest.pluginsCommit || '').slice(0, 8);
  $('ecoMeta').textContent =
    (d.label || '') + ' · 插件源 ' + commit + ' · dsh ' + d.manifest.dsh.source + '/' + d.manifest.dsh.version +
    (d.manifest.skills ? ' · skills ✓' : '');
  // 状态摘要
  const st = d.state;
  let summary = '清单共 ' + d.manifest.packages.length + ' 个插件包';
  if (st && st.updatedAt) {
    const nOk = st.plugins ? Object.values(st.plugins).filter((p) => p && p.ok).length : 0;
    summary += ' · 上次拉齐 ' + nOk + ' 个成功' + (st.core && st.core.installed ? ' · core 已装' : ' · core 未装') +
      ' · ' + new Date(st.updatedAt).toLocaleString('zh-CN', { hour12: false });
  } else {
    summary += ' · 尚无拉齐记录（运行一次「拉齐勾选项」）';
  }
  $('ecoState').textContent = summary;
  // 插件列表（首次全选；后续保留用户勾选）
  const box = $('ecoPkgs');
  const prevChecked = ecoCheckedIds();
  box.textContent = '';
  eco.rows = {};
  for (const p of d.manifest.packages) {
    const label = document.createElement('label');
    label.className = 'eco-chk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = prevChecked.length === 0 || prevChecked.includes(p.id);
    const stp = st && st.plugins ? st.plugins[p.id] : undefined;
    cb.addEventListener('change', renderEcoButtons);
    label.appendChild(cb);
    const name = document.createElement('span');
    name.textContent = p.id;
    label.appendChild(name);
    label.appendChild(ecoChip(!!(stp && stp.ok)));
    label.title = (p.dir || '') + (p.installSha ? '\nsha256 ' + p.installSha + '…' : '');
    eco.rows[p.id] = cb;
    box.appendChild(label);
  }
  renderEcoDetail(d);
  renderEcoButtons();
  renderOverviewLine();
  scheduleAutoSize();
  return d;
}

async function onEcoPull(dryRun) {
  if (state.busy || eco.busy) return;
  const ids = ecoCheckedIds();
  const wantCore = $('ecoCore').checked;
  const wantSkills = $('ecoSkills').checked;
  if (ids.length === 0 && !wantCore && !wantSkills) {
    log('请至少勾选一个插件，或开启 core / 技能。', 'warn');
    return;
  }
  eco.busy = true;
  eco.dry = dryRun;
  renderEcoButtons();
  log((dryRun ? '生态 dry-run 校验开始（仅校验清单与 sha256，不安装）……' : '生态拉齐开始……'), 'brand');
  try {
    const r = await bridge.pullEcosystem({
      plugins: ids,
      core: wantCore,
      skills: wantSkills,
      dryRun: dryRun,
    });
    if (!r.ok) throw new Error(r.message || '拉齐启动失败');
    log(dryRun ? 'dry-run 已开始（进度见日志）。' : '拉齐已开始（进度见日志）。', 'ok');
  } catch (e) {
    log('生态拉齐启动失败：' + e.message, 'err');
    eco.busy = false;
    eco.dry = false;
    renderEcoButtons();
    return;
  }
  // 轮询服务端 busy 直到结束（最长 20 分钟）
  const deadline = Date.now() + 20 * 60 * 1000;
  const timer = setInterval(async () => {
    try {
      const d = await bridge.getEcosystem();
      if (!d || !d.busy || Date.now() > deadline) {
        clearInterval(timer);
        eco.busy = false;
        eco.dry = false;
        await refreshEcosystem();
        await refreshStatus();
        renderButtons();
      }
    } catch (e) {
      clearInterval(timer);
      eco.busy = false;
      eco.dry = false;
      renderEcoButtons();
    }
  }, 1500);
}

/* 一键更新插件：同步最新插件源 → 安装/更新 → 重启 dsh（进度走日志流） */
async function onEcoUpdate() {
  if (state.busy || eco.busy || eco.updating) return;
  if (!window.confirm('一键更新插件将执行：同步最新插件源（git）→ 安装/更新插件与技能 → 重启 dsh。\n继续？')) return;
  eco.updating = true;
  renderEcoButtons();
  log('一键更新插件开始（同步最新插件源 → 安装/更新 → 重启 dsh）……', 'brand');
  try {
    const r = await bridge.updateEcosystem({ restart: true });
    if (!r || r.ok === false) throw new Error((r && r.message) || '更新启动失败');
    log(r.message || '一键更新已开始（进度见日志）。', 'ok');
  } catch (e) {
    log('一键更新启动失败：' + e.message, 'err');
    eco.updating = false;
    renderEcoButtons();
    return;
  }
  // 轮询服务端 busy 直到结束（最长 30 分钟：含 git 同步 + 安装 + 重启）
  const deadline = Date.now() + 30 * 60 * 1000;
  const timer = setInterval(async () => {
    try {
      const d = await bridge.getEcosystem();
      if (!d || !d.busy || Date.now() > deadline) {
        clearInterval(timer);
        eco.updating = false;
        await refreshEcosystem();
        await refreshStatus();
        renderButtons();
      }
    } catch (e) {
      clearInterval(timer);
      eco.updating = false;
      renderEcoButtons();
    }
  }, 1500);
}

/* ---------- 连接切换（M5） ---------- */

async function refreshConnections() {
  let d;
  try {
    d = await bridge.getConnections();
  } catch (e) {
    log('连接列表读取失败：' + e.message, 'err');
    return;
  }
  if (!d || !d.ok) return;
  const sel = $('connSelect');
  const active = d.active;
  sel.replaceChildren(
    ...d.list.map((c) => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.id + '（' + c.kind + (c.kind === 'local' && c.port ? ':' + c.port : '') + '）' + (c.hasToken ? ' · token✓' : '');
      return o;
    }),
  );
  const has = [...sel.options].some((o) => o.value === active);
  sel.value = has ? active : sel.options.length ? sel.options[0].value : '';
  renderConnList(d, active);
  scheduleAutoSize();
}

async function onConnUseId(id) {
  if (!id) return;
  log('切换激活连接 → ' + id + ' …', 'brand');
  try {
    const r = await bridge.useConnection(id);
    if (!r.ok) throw new Error(r.message || '切换失败');
    log('激活连接 → ' + id + '（local 启动端口跟随；remote 健康检查+开浏览器；launch-token 照写）。', 'ok');
  } catch (e) {
    log('切换连接失败：' + e.message, 'err');
  }
  await refreshStatus();
  await refreshConnections();
}

async function onConnRemoveId(id) {
  if (!window.confirm('删除连接 ' + id + '？')) return;
  try {
    const r = await bridge.removeConnection(id);
    if (!r || r.ok === false) throw new Error((r && r.message) || '删除失败');
    log('连接已删除：' + id, 'ok');
  } catch (e) {
    log('删除连接失败：' + e.message, 'err');
  }
  await refreshConnections();
}

function renderConnList(d, activeId) {
  const box = $('connList');
  box.textContent = '';
  if (!d.list || !d.list.length) {
    const p = document.createElement('p');
    p.className = 'eco-state';
    p.textContent = '（无连接，使用右上角下拉或配置文件新增）';
    box.appendChild(p);
    return;
  }
  for (const c of d.list) {
    const row = document.createElement('div');
    row.className = 'conn-row' + (c.id === activeId ? ' active' : '');
    const name = document.createElement('span');
    name.className = 'conn-row-name';
    name.textContent = (c.name || c.id) + (c.id === activeId ? ' · 当前' : '');
    const meta = document.createElement('span');
    meta.className = 'conn-row-meta';
    meta.textContent = c.id + ' · ' + c.kind +
      (c.kind === 'local' && c.port ? ':' + c.port : (c.url ? ' · ' + c.url : '')) +
      (c.hasToken ? ' · token✓' : ' · 无 token');
    row.appendChild(name);
    row.appendChild(meta);
    const actions = document.createElement('span');
    actions.className = 'conn-row-actions';
    if (c.id !== activeId) {
      const use = document.createElement('button');
      use.className = 'btn btn-ghost btn-sm';
      use.textContent = '使用';
      use.addEventListener('click', () => onConnUseId(c.id));
      actions.appendChild(use);
    }
    const del = document.createElement('button');
    del.className = 'btn btn-ghost btn-sm';
    del.textContent = '删除';
    del.addEventListener('click', () => onConnRemoveId(c.id));
    actions.appendChild(del);
    row.appendChild(actions);
    box.appendChild(row);
  }
  const sum = $('connSum');
  if (sum) {
    const active = d.list.find((c) => c.id === activeId);
    sum.textContent = active ? (active.name || active.id) + ' · ' + active.kind : '—';
  }
}

async function onConnUse() {
  const id = $('connSelect').value;
  if (!id) return;
  await onConnUseId(id);
}

function onHide() {
  // M6:标题栏 × = 隐藏到托盘(dsh 继续跑;真正退出走「退出」按钮或托盘菜单)
  if (window.electronWindow && window.electronWindow.hide) {
    window.electronWindow.hide();
    return;
  }
  log('浏览器/SEA 版无托盘：如需停止 dsh 请用「退出」。', 'dim');
}

async function onRestart() {
  if (state.busy) return;
  setBusy(true);
  log('重启 dsh（优雅停止 → 等端口释放 → 重抓 token 照写）…', 'brand');
  try {
    const r = await bridge.restartDsh();
    if (!r || r.ok === false) throw new Error((r && r.message) || '重启失败');
    log('重启已开始（进度见日志；30 天 cookie 下重启后免手动重登）。', 'ok');
  } catch (e) {
    log('重启失败：' + e.message, 'err');
  }
  setBusy(false);
  setTimeout(() => { void refreshStatus(); }, 4000);
}

async function onSetup() {
  if (state.busy) return;
  if (!window.confirm('一键部署将执行：core 安装（如缺）→ 插件/技能拉齐 → 启动 dsh。\n继续？')) return;
  setBusy(true);
  log('一键部署开始（core → pull → 连接 → start）…', 'brand');
  try {
    const r = await bridge.setupFlow({});
    if (!r || r.ok === false) throw new Error((r && r.message) || '部署失败');
    log('一键部署已开始（进度见日志）。', 'ok');
  } catch (e) {
    log('一键部署失败：' + e.message, 'err');
  }
  setBusy(false);
  setTimeout(() => { void refreshStatus(); void refreshEcosystem(); }, 5000);
}

function onExit() {
  log('dsh 绑定启动器运行：退出将同时停止 dsh。', 'dim');
  // 桌面窗口：通过 preload 关闭窗口（触发 main 的 closed → app.quit → 停止 dsh）
  if (window.electronWindow && window.electronWindow.close) {
    window.electronWindow.close();
    return;
  }
  // 浏览器 / SEA 版：调用后端 /api/exit（内部先停止 dsh 再退出）
  if (bridge.exit) {
    void bridge.exit();
  }
}

/* ---------- 桌面窗口内容自适应（#20 界面高度不够） ---------- */

/**
 * 量出页面自然总高度（标题栏 + 内容），请求主进程把窗口扩到刚好放下全部内容。
 * 测量时临时解除 .content 的伸缩/滚动约束，读 offsetHeight 后立即还原（同一帧内完成，无闪烁）。
 * 小屏放不下时主进程保持窗口上限，由 body.desktop .content 内滚动兜底。
 */
function desktopAutoSize() {
  const ew = window.electronWindow;
  if (!ew || typeof ew.autosize !== 'function') return;
  const content = document.querySelector('main.content');
  const title = document.querySelector('.titlebar');
  if (!content || !title) return;
  const prevFlex = content.style.flex;
  const prevOverflow = content.style.overflow;
  content.style.flex = '0 0 auto';
  content.style.overflow = 'visible';
  let h = 0;
  try {
    h = content.offsetHeight + title.offsetHeight;
  } finally {
    content.style.flex = prevFlex;
    content.style.overflow = prevOverflow;
  }
  if (h > 0) ew.autosize(h + 8); // +8 兜底行高/字体取整
}

let autoSizeTimer = 0;
function scheduleAutoSize() {
  clearTimeout(autoSizeTimer);
  autoSizeTimer = setTimeout(desktopAutoSize, 120);
}

/* ---------- 启动 ---------- */

(async function init() {
  // 桌面窗口（Electron frameless）：显示最小化按钮 + 占满布局
  if (window.electronWindow && window.electronWindow.isDesktop) {
    document.body.classList.add('desktop');
    $('btnMin').hidden = false;
    $('btnMin').addEventListener('click', () => window.electronWindow.minimize());
  }
  // 真实模式下订阅服务端日志流
  if (bridge.onLog) {
    bridge.onLog((line, kind) => log(line, kind));
  }
  // 版本号 + 默认安装目录预填
  if (window.launcherVersion) {
    $('ver').textContent = window.launcherVersion;
  }
  // 分区跳转 + 卡片折叠头
  document.querySelectorAll('.jump-chip').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.jump;
      if (id) expandCardAndJump(id);
    });
  });
  document.querySelectorAll('.card-head').forEach((head) => {
    head.addEventListener('click', () => {
      const card = head.closest('.card');
      if (card && card.id) toggleCard(card.id);
    });
  });
  $('chipLine').addEventListener('click', (e) => {
    const b = e.target.closest('.chip-link');
    if (b && b.dataset.jump) expandCardAndJump(b.dataset.jump);
  });

  // 先挂按钮，保证界面立即可用：状态请求失败也不阻塞交互
  $('btnStart').addEventListener('click', onStart);
  $('btnStop').addEventListener('click', onStop);
  $('btnRestart').addEventListener('click', onRestart);
  $('btnOpenUI').addEventListener('click', onOpenUI);
  $('btnQuickUpdate').addEventListener('click', onEcoUpdate);
  $('btnSetup').addEventListener('click', onSetup);
  $('btnInstall').addEventListener('click', onInstall);
  $('btnMove').addEventListener('click', onMove);
  $('btnBrowse').addEventListener('click', onBrowse);
  $('btnUpdate').addEventListener('click', onUpdate);
  $('btnRefreshTags').addEventListener('click', refreshTags);
  $('btnExit').addEventListener('click', onExit);
  $('btnClose').addEventListener('click', onHide);
  $('btnEcoRefresh').addEventListener('click', refreshEcosystem);
  $('btnEcoDry').addEventListener('click', () => onEcoPull(true));
  $('btnEcoPull').addEventListener('click', () => onEcoPull(false));
  $('btnEcoUpdate').addEventListener('click', onEcoUpdate);
  $('connSelect').addEventListener('change', onConnUse);
  // 日志工具条
  $('logErrors').addEventListener('click', cycleLogFilter);
  $('logFollow').addEventListener('click', () => {
    logState.follow = !logState.follow;
    $('logFollow').setAttribute('aria-pressed', logState.follow ? 'true' : 'false');
    $('logFollow').textContent = '自动滚动：' + (logState.follow ? '开' : '关');
    if (logState.follow) scrollLogToBottom();
    log('自动滚动' + (logState.follow ? '已开启' : '已暂停（可点“回到底部”跟随）') + '。', 'dim');
  });
  $('logClear').addEventListener('click', clearLog);
  $('logNew').addEventListener('click', scrollLogToBottom);
  $('btnResetLayout').addEventListener('click', resetLayout);

  // 日志滚动位置 → 暂停跟随
  logBox.addEventListener('scroll', () => {
    if (atBottom() && !logState.follow) {
      // 手动回到底部时恢复跟随并清角标
      logState.follow = true;
      logState.pendingNew = 0;
      $('logNew').hidden = true;
      $('logFollow').setAttribute('aria-pressed', 'true');
      $('logFollow').textContent = '自动滚动：开';
    }
  });

  log('dsh-launcher 已就绪。', '');

  // UI 状态（折叠/日志偏好）恢复
  if (bridge.getUiState) {
    try {
      const saved = await bridge.getUiState();
      applyUiState(saved);
    } catch (e) {
      /* 预览/读取失败用默认 */
    }
  } else {
    applyUiState(null);
  }

  // 预填安装目录（失败忽略）
  try {
    const s0 = await bridge.getStatus();
    if (s0.installedDir) {
      $('pathInput').value = s0.installedDir;
    } else if (s0.defaultDir && !$('pathInput').value.trim()) {
      $('pathInput').value = s0.defaultDir;
    }
  } catch (e) {
    /* 忽略 */
  }
  // 初始状态检测：失败自动重试几次（首启冷启动偶尔慢）
  for (let i = 1; i <= 3; i++) {
    if (await refreshStatus()) break;
    if (i < 3) await delay(600 * i);
  }
  // 拉取 GitHub 可选版本列表（失败静默，默认「最新」即可用）
  refreshTags();
  renderButtons();
  // 生态页首载（异步；失败不阻塞主界面）
  void refreshEcosystem();
  // 连接列表首载（M5）
  void refreshConnections();
  // #20：首帧数据就绪后让窗口按内容自适应（生态/连接异步完成时各自再调度一次）
  scheduleAutoSize();
})();

/* ---------- 真实后端契约（Node SEA 版，由服务端注入） ----------
   window.launcherVersion: string
   window.launcherBridge = {
     getStatus(): Promise<{ node, npm, dsh, port, connection, components, update, defaultDir, installedDir }>,
     start(): Promise<{ok}>,
     stop(): Promise<{ok}>,
     install(dir, source, version, proxy): Promise<{ok}>,
     getTags(): Promise<{ok, tags}>,
     move(dir): Promise<{ok}>,
     checkUpdate(): Promise<{dshAvail, launcherAvail, dshLatest, launcherLatest}>,
     browse(): Promise<string|null>,
     getEcosystem(): Promise<{ok, busy, label, manifest, state, pluginsDir}>,
     pullEcosystem(opts): Promise<{ok}>,
     updateEcosystem(opts): Promise<{ok}>,      // 一键更新插件（同步源→安装→重启）
     getConnections(): Promise<{ok, active, list}>,
     useConnection(id): Promise<{ok}>,
     removeConnection(id): Promise<{ok}>,
     getUiState(): Promise<UiSettings>,         // #18 折叠/日志偏好
     setUiState(patch): Promise<UiSettings>,
     open(): Promise<{ok, url}>,                // #19 打开 dsh UI
     restartDsh(): Promise<{ok}>,
     setupFlow(opts): Promise<{ok}>,
     defaultDir: string,
     onLog(fn): void   // 订阅日志流（SSE /api/events），fn(line, kind)
   }
*/
