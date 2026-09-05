/* app.js —— dsh-launcher 界面逻辑
   预览模式：默认跑模拟数据（window.launcherBridge 不存在时）。
   真实模式：Node SEA 内嵌 http 服务在页面注入 window.launcherBridge（REST + SSE），
   本文件自动切换。 */

'use strict';

/* ---------- 模拟桥接层 ---------- */

const mock = {
  async getStatus() {
    return {
      node: { present: true, version: 'v24.14.0' },
      npm:  { present: true, version: '11.3.2' },
      dsh:  { installed: true, version: 'v0.1.0-rc.7' },
      port: { number: 3080, running: state.running },
      update: { checking: false, dshAvail: false, launcherAvail: false },
      defaultDir: 'C:\\Users\\kua\\AppData\\Local\\dsh',
      installedDir: 'C:\\Users\\kua\\AppData\\Local\\dsh',
    };
  },
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
          { id: 'credentials', dir: 'plugins/credentials-dsh-plugin' },
          { id: 'stock', dir: 'plugins/stock-dsh-plugin' },
          { id: 'github', dir: 'plugins/github-dsh-plugin' },
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
  async getConnections() {
    return {
      ok: true,
      active: 'local-3080',
      fromFile: false,
      list: [
        { id: 'local-3080', kind: 'local', name: '本机 dsh', port: 3080, hasToken: false },
        { id: 'wan-main', kind: 'remote', name: '广域网 dsh', url: 'https://dsh.example.com', hasToken: true },
      ],
    };
  },
  async useConnection(id) { await delay(300); return { ok: true, active: id }; },
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

/* ---------- 日志 ---------- */

function log(line, kind = '') {
  const el = document.createElement('div');
  // 服务端推送的行已带时间戳（2026-08-21 12:00:00.000 [INFO] ...），不再重复加
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
  // 限行 + 自动滚动
  while (logBox.children.length > 300) logBox.removeChild(logBox.firstChild);
  logBox.scrollTop = logBox.scrollHeight;
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

async function refreshStatus() {
  // 状态刷新永不应把界面卡死：失败只记日志，返回 false 供调用方重试。
  let s;
  try {
    s = await bridge.getStatus();
  } catch (e) {
    log('状态检测失败：' + e.message, 'err');
    return false;
  }
  // 同步状态，供按钮启用/文案使用（此前只更新显示、未同步 state）
  state.installed = s.dsh.installed;
  state.running = s.port.running;
  if (s.node.present) {
    setValue('node', 'Node.js  ' + s.node.version);
    setDot('node', 'dot-green');
  } else {
    setValue('node', 'Node.js  未安装', 'red');
    setDot('node', 'dot-red');
  }
  if (s.npm.present) {
    setValue('npm', 'npm  ' + s.npm.version);
    setDot('npm', 'dot-green');
  } else {
    setValue('npm', 'npm  未安装', 'red');
    setDot('npm', 'dot-red');
  }
  if (s.dsh.installed) {
    setValue('dsh', 'dsh  ' + s.dsh.version + '  已安装', 'green');
    setDot('dsh', 'dot-green');
  } else {
    setValue('dsh', 'dsh  未安装', 'red');
    setDot('dsh', 'dot-red');
  }
  if (s.dsh.installed) {
    if (s.port.running) {
      setValue('port', '端口  ' + s.port.number + '  运行中', 'green');
      setDot('port', 'dot-green');
    } else {
      setValue('port', '端口  ' + s.port.number + '  未运行', 'dim');
      setDot('port', 'dot-dim');
    }
  } else {
    setValue('port', '端口  —', 'dim');
    setDot('port', 'dot-dim');
  }
  // M5：激活连接为 remote 时，端口行改为连接语义（HTTP ping）
  if (s.connection && s.connection.kind === 'remote') {
    setValue('port', 'remote  ' + s.connection.id + (s.port.running ? '  可达' : '  不可达'), s.port.running ? 'green' : 'red');
    setDot('port', s.port.running ? 'dot-green' : 'dot-red');
  }
  if (s.update.checking) {
    setValue('update', '更新  正在检查…', 'dim');
    setDot('update', 'dot-dim');
  } else if (s.update.dshAvail || s.update.launcherAvail) {
    setValue('update', '更新  有新版本可升级', 'brand');
    setDot('update', 'dot-brand');
  } else {
    setValue('update', '更新  已是最新', 'green');
    setDot('update', 'dot-green');
  }
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

const eco = { busy: false, dry: false, rows: {} };

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
  const busy = state.busy || eco.busy;
  $('btnEcoPull').disabled = busy;
  $('btnEcoDry').disabled = busy || ecoCheckedIds().length === 0;
  $('btnEcoRefresh').disabled = busy;
  $('btnEcoPull').textContent = eco.busy ? '拉齐中…' : (eco.dry ? '校验中…' : '拉齐勾选项');
  $('btnEcoDry').textContent = eco.dry ? '校验中…' : '仅校验（dry-run）';
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
    label.title = p.dir;
    eco.rows[p.id] = cb;
    box.appendChild(label);
  }
  renderEcoButtons();
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
  scheduleAutoSize();
}

async function onConnUse() {
  const id = $('connSelect').value;
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
  // 先挂按钮，保证界面立即可用：状态请求失败也不阻塞交互
  $('btnStart').addEventListener('click', onStart);
  $('btnStop').addEventListener('click', onStop);
  $('btnRestart').addEventListener('click', onRestart);
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
  $('connSelect').addEventListener('change', onConnUse);
  log('dsh-launcher 已就绪。', '');

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
     getStatus(): Promise<{ node, npm, dsh, port, update, defaultDir, installedDir }>,
     start(): Promise<{ok}>,
     stop(): Promise<{ok}>,
     install(dir, source, version, proxy): Promise<{ok}>,
     getTags(): Promise<{ok, tags}>,
     move(dir): Promise<{ok}>,
     checkUpdate(): Promise<{dshAvail, launcherAvail, dshLatest, launcherLatest}>,
     browse(): Promise<string|null>,
     defaultDir: string,
     onLog(fn): void   // 订阅日志流（SSE /api/events），fn(line, kind)
   }
*/
