/**
 * Sidebar Webview 模板（issue #3 卡片化）：纯静态 HTML/CSS/JS 字符串。
 *
 * 渲染约定：
 *   - 宿主 postMessage { type:'snapshot', snapshot } → 本页按 snapshot.view 整页重绘；
 *   - 交互统一走宿主命令：元素带 data-cmd / data-arg（arg 为 JSON 字符串）；
 *   - 层级视觉：分组=标题栏（色块）+ 卡片=圆角表面，不用缩进；
 *   - 无任何外部资源：图标为内联 SVG 描边集，样式随 VSCode 主题变量。
 */

export function sidebarViewHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:;">
<title>DSH</title>
<style>
  :root {
    --bg: var(--vscode-sideBar-background, #1e1e1e);
    --bg2: var(--vscode-editorWidget-background, #252526);
    --fg: var(--vscode-sideBar-foreground, #cccccc);
    --muted: var(--vscode-descriptionForeground, #9d9d9d);
    --accent: var(--vscode-textLink-foreground, #4daafc);
    --border: rgba(128,128,128,0.28);
    --ok: #89d185;
    --warn: #cca700;
    --err: #f48771;
    --brand: #4d6bfe;
    --radius: 10px;
    --radius-sm: 6px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
    font-size: 12.5px; line-height: 1.5;
    display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  }
  /* ---- header ---- */
  header {
    flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
    padding: 6px 10px;
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
  }
  header .back {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border: 1px solid var(--border); border-radius: 6px;
    background: transparent; color: var(--fg); cursor: pointer; padding: 0;
  }
  header .back:hover { background: rgba(128,128,128,0.15); }
  header .vt { font-weight: 600; font-size: 12.5px; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: 0 0 auto; }
  header .dot.ok { background: var(--ok); box-shadow: 0 0 6px rgba(137,209,125,0.6); }
  header .dot.bad { background: var(--err); }
  header .conn { margin-left: auto; font-size: 10.5px; color: var(--muted); }
  /* ---- scroll area ---- */
  #view { flex: 1 1 auto; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 12px; }
  /* ---- sections / groups ---- */
  .sec { display: flex; flex-direction: column; gap: 6px; }
  .sec-head {
    display: flex; align-items: center; gap: 8px;
    font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--muted);
    padding: 2px 2px 0; user-select: none;
  }
  .sec-head .bar { width: 3px; height: 12px; border-radius: 2px; background: var(--accent); flex: 0 0 auto; }
  .sec-head .cnt { margin-left: auto; font-weight: 500; letter-spacing: 0; text-transform: none; }
  .sec-head .cnt button {
    background: transparent; border: none; color: var(--accent); cursor: pointer;
    font-size: 11px; padding: 0 2px; text-transform: none;
  }
  .sec-head .cnt button:hover { text-decoration: underline; }
  /* ---- cards ---- */
  .card {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 9px 11px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .card.clickable { cursor: pointer; }
  .card.clickable:hover { border-color: rgba(77,170,252,0.55); }
  .card.row { flex-direction: row; align-items: center; gap: 10px; }
  .card .title { font-weight: 600; display: flex; align-items: center; gap: 8px; min-width: 0; }
  .card .title .txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .desc { color: var(--muted); font-size: 11px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .meta { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--muted); font-size: 10.5px; align-items: center; }
  .card .badge {
    margin-left: auto; flex: 0 0 auto; font-size: 10.5px; color: var(--muted);
    background: rgba(128,128,128,0.16); border-radius: 8px; padding: 0 7px;
  }
  .card .badge.run { color: var(--warn); background: rgba(204,167,0,0.14); }
  .card .badge.done { color: var(--ok); background: rgba(137,209,125,0.13); }
  .card .badge.err { color: var(--err); background: rgba(244,135,113,0.13); }
  /* icons */
  .icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; }
  .icon svg { display: block; }
  .chip { width: 30px; height: 30px; border-radius: 8px; flex: 0 0 auto;
    display: inline-flex; align-items: center; justify-content: center; }
  .chip.accent { background: rgba(77,107,254,0.16); color: #7d93ff; }
  .chip.green { background: rgba(137,209,125,0.14); color: var(--ok); }
  .chip.warn { background: rgba(204,167,0,0.14); color: var(--warn); }
  .chip.red { background: rgba(244,135,113,0.14); color: var(--err); }
  .chip.gray { background: rgba(128,128,128,0.14); color: var(--muted); }
  .chip.purple { background: rgba(197,134,255,0.15); color: #c586ff; }
  .chip.cyan { background: rgba(86,182,214,0.15); color: #56b6d6; }
  /* status pill inside conn card */
  .pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11px;
    border-radius: 9px; padding: 2px 10px; }
  .pill.ok { color: var(--ok); background: rgba(137,209,125,0.13); }
  .pill.bad { color: var(--err); background: rgba(244,135,113,0.13); }
  .pill.neu { color: var(--muted); background: rgba(128,128,128,0.14); }
  /* buttons */
  .btnrow { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
  button.btn {
    border: 1px solid var(--border); border-radius: 7px; padding: 5px 12px;
    background: transparent; color: var(--fg); cursor: pointer; font-size: 12px;
    display: inline-flex; align-items: center; gap: 6px;
  }
  button.btn:hover:not(:disabled) { background: rgba(128,128,128,0.15); }
  button.btn:disabled { opacity: 0.45; cursor: default; }
  button.btn.primary { border-color: transparent; background: var(--brand); color: #fff; font-weight: 600; }
  button.btn.primary:hover:not(:disabled) { filter: brightness(1.12); }
  button.btn.danger { color: var(--err); border-color: rgba(244,135,113,0.5); }
  button.btn.sm { padding: 2px 8px; font-size: 11px; border-radius: 6px; }
  /* session cards */
  .sess-actions { display: none; }
  .card:hover .sess-actions { display: inline-flex; gap: 2px; }
  .iconbtn { background: transparent; border: none; color: var(--muted); cursor: pointer;
    padding: 2px 4px; border-radius: 5px; display: inline-flex; align-items: center; }
  .iconbtn:hover { background: rgba(128,128,128,0.18); color: var(--fg); }
  .iconbtn.open { color: var(--accent); }
  /* settings rows */
  .set-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid rgba(128,128,128,0.12); }
  .set-row:first-of-type { border-top: none; }
  .set-row .grow { flex: 1 1 auto; min-width: 0; }
  .set-row .s-label { font-weight: 500; }
  .set-row .s-desc { color: var(--muted); font-size: 10.5px; }
  .set-row .s-val { font-size: 11px; color: var(--muted); font-family: var(--vscode-editor-font-family, monospace); max-width: 42%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .switch { position: relative; width: 30px; height: 16px; flex: 0 0 auto; cursor: pointer; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .switch .slider { position: absolute; inset: 0; border-radius: 8px; background: rgba(128,128,128,0.3); transition: 0.15s; }
  .switch .slider::before { content: ""; position: absolute; width: 12px; height: 12px; left: 2px; top: 2px;
    border-radius: 50%; background: #fff; transition: 0.15s; }
  .switch input:checked + .slider { background: var(--brand); }
  .switch input:checked + .slider::before { transform: translateX(14px); }
  /* plugin / preset tags */
  .tag { font-size: 10px; border-radius: 4px; padding: 0 6px; background: rgba(128,128,128,0.16); color: var(--muted); }
  .tag.skill { color: var(--warn); background: rgba(204,167,0,0.13); }
  .tag.tool { color: #56b6d6; background: rgba(86,182,214,0.13); }
  .tag.preset { color: #c586ff; background: rgba(197,134,255,0.13); }
  .tag.def { color: var(--ok); background: rgba(137,209,125,0.13); }
  /* logs */
  .logbox { background: rgba(0,0,0,0.28); border: 1px solid var(--border); border-radius: var(--radius-sm);
    font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 10.5px;
    padding: 7px 9px; max-height: 180px; overflow: auto; white-space: pre-wrap; word-break: break-all; color: var(--muted); }
  .empty { text-align: center; color: var(--muted); font-size: 12px; padding: 22px 8px; }
  .path { font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 10.5px;
    color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note { font-size: 10.5px; color: var(--muted); padding: 0 2px; }
  .kv { font-size: 11px; }
  .kv b { color: var(--fg); font-weight: 600; }
  footer { flex: 0 0 auto; padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 6px; }
</style>
</head>
<body>
  <header>
    <button class="back" id="btn-back" title="返回首页">‹</button>
    <span class="vt" id="view-title">DSH</span>
    <span class="dot" id="h-dot"></span>
    <span class="conn" id="h-conn"></span>
  </header>
  <div id="view"></div>
  <footer id="foot"></footer>
<script>
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var viewEl = document.getElementById('view');
  var titleEl = document.getElementById('view-title');
  var dotEl = document.getElementById('h-dot');
  var connEl = document.getElementById('h-conn');
  var footEl = document.getElementById('foot');
  var backBtn = document.getElementById('btn-back');

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function attr(s) {
    return esc(s).replace(/"/g, '&quot;');
  }
  function post(cmd, arg) {
    vscode.postMessage({ type: 'exec', command: cmd, arg: arg });
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function svg(inner, size) {
    return '<svg width="' + (size || 14) + '" height="' + (size || 14) + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  var IC = {
    back: '<path d="M10 3.5L5.5 8l4.5 4.5"/>',
    comment: '<path d="M2.5 3.5h11v8h-7l-3 2.5v-2.5h-1z"/>',
    server: '<rect x="2.5" y="2.5" width="11" height="4" rx="1"/><rect x="2.5" y="9.5" width="11" height="4" rx="1"/><path d="M5.5 4.5h.01M5.5 11.5h.01"/>',
    gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 2.5l1 1.8 2-.4.8 1.9-1.7 1.2 1.7 1.2-.8 1.9-2-.4-1 1.8h-2L5 10.1l-2 .4-.8-1.9L3.9 7.2 2.2 6l.8-1.9 2 .4L6 2.5z"/>',
    plug: '<path d="M9 2v4M7 2v4M5.5 6h5v2.5l-1.8 1.5H7.3L5.5 8.5z"/><path d="M8 10v3.5"/>',
    spark: '<path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.7.7 3.8-3.4-1.8-3.4 1.8.7-3.8L2.5 6.5l3.8-.5z"/>',
    folder: '<path d="M2.5 4h4l1.5 1.5h5.5v7h-11z"/>',
    session: '<path d="M3 3.5h10v7H8l-2.5 2v-2H3z"/>',
    clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
    play: '<path d="M5 3.5l7 4.5-7 4.5z"/>',
    stop: '<rect x="5" y="5" width="6" height="6" rx="1"/>',
    refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.8 1.8 2.7 3.5 2.7 5.5S9.8 11.7 8 13.5C6.2 11.7 5.3 10 5.3 8S6.2 4.3 8 2.5z"/>',
    rename: '<path d="M11.5 2.5l2 2-7.5 7.5-2.8.8.8-2.8z"/><path d="M10.5 3.5l2 2"/>',
    check: '<path d="M4 8.5l2.8 2.8L12 5.5"/>',
    link: '<path d="M6.5 9.5l3-3M5 11l-1 1a2.1 2.1 0 0 1-3-3l2.5-2.5a2.1 2.1 0 0 1 3 0"/><path d="M11 5l1-1a2.1 2.1 0 0 1 3 3l-2.5 2.5a2.1 2.1 0 0 1-3 0"/>',
    json: '<path d="M5 4.5L2.5 8 5 11.5M11 4.5l2.5 3.5L11 11.5M9 3l-2 10"/>',
    folderOpen: '<path d="M2.5 4h4l1.5 1.5h5.5v7h-11z"/><path d="M3.5 9h9"/>',
    wrench: '<path d="M12.5 6.5a4.5 4.5 0 0 1-6 4.2L3 14.2 1.8 13l3.5-3.5a4.5 4.5 0 0 1 4.2-6l-1.7 1.7 2.8 2.8z"/>',
  };
  function icon(name, size) { return svg(IC[name] || IC.comment, size); }

  var VIEW_TITLES = { home: 'DSH', sessions: '会话列表', service: '拉起服务', settings: '设置', plugins: '插件库', presets: '模式列表' };
  var ENTRY_ICON = { sessions: 'session', service: 'server', settings: 'gear', plugins: 'plug', presets: 'spark' };
  var ENTRY_CHIP = { sessions: 'accent', service: 'green', settings: 'gray', plugins: 'cyan', presets: 'purple' };

  // ---------- helpers ----------
  function sec(headTitle, contentHtml) {
    var s = el('div', 'sec');
    if (headTitle) {
      var h = el('div', 'sec-head');
      h.appendChild(el('span', 'bar'));
      h.appendChild(el('span', '', esc(headTitle)));
      s.appendChild(h);
    }
    if (contentHtml) s.insertAdjacentHTML('beforeend', contentHtml);
    return s;
  }
  function headWithCount(title, countHtml) {
    var h = el('div', 'sec-head');
    h.appendChild(el('span', 'bar'));
    h.appendChild(el('span', '', esc(title)));
    if (countHtml) h.appendChild(el('span', 'cnt', countHtml));
    return h;
  }

  // ---------- views ----------
  function renderHome(home, connected) {
    viewEl.textContent = '';
    // workspace
    if (home.workspacePath) {
      var wcard = el('div', 'card');
      wcard.appendChild(el('div', 'title', icon('folderOpen') + '<span class="txt">' + esc(home.workspacePath) + '</span>'));
      wcard.appendChild(el('div', 'path', esc(home.workspacePath)));
      if (home.workspaceHint) wcard.appendChild(el('div', 'desc', esc(home.workspaceHint)));
      viewEl.appendChild(wcard);
    }
    // connection
    var pill = home.connText === '已连接' ? 'ok' : 'bad';
    var ccard = el('div', 'card row');
    ccard.appendChild(el('span', 'pill ' + pill, icon(home.connText === '已连接' ? 'check' : 'plug', 12) + esc(home.connText)));
    if (home.connDetail) ccard.appendChild(el('span', 'desc', esc(home.connDetail)));
    ccard.appendChild(el('span', 'badge', connected ? '已连接' : '未连接'));
    viewEl.appendChild(ccard);
    // entries
    var g = el('div', 'sec');
    g.appendChild(headWithCount('功能', ''));
    home.entries.forEach(function (e) {
      var card = el('div', 'card row clickable');
      card.setAttribute('data-cmd', 'nav');
      card.setAttribute('data-nav', e.view);
      var chipCls = ENTRY_CHIP[e.view] || 'gray';
      card.insertAdjacentHTML('beforeend',
        '<span class="chip ' + chipCls + '">' + icon(ENTRY_ICON[e.view] || 'comment', 16) + '</span>' +
        '<span class="grow" style="flex:1;min-width:0"><div class="title" style="font-weight:600">' + esc(e.title) + '</div>' +
        '<div class="desc">' + esc(e.desc) + '</div></span>');
      if (e.badge) card.insertAdjacentHTML('beforeend', '<span class="badge">' + esc(e.badge) + '</span>');
      g.appendChild(card);
    });
    viewEl.appendChild(g);
    viewEl.appendChild(el('div', 'sec'));
    var actsRow = el('div', 'btnrow');
    actsRow.appendChild(btn('dsh.newSession', icon('plus', 13) + '新建会话', 'primary'));
    actsRow.appendChild(btn('dsh.refreshSessions', icon('refresh', 13) + '刷新'));
    if (connected) actsRow.appendChild(btn('dsh.disconnect', icon('stop', 13) + '断开'));
    else actsRow.appendChild(btn('dsh.connect', icon('plug', 13) + '连接'));
    viewEl.appendChild(actsRow);
  }

  function btn(cmd, labelHtml, cls) {
    var b = el('button', 'btn' + (cls ? ' ' + cls : ''), labelHtml);
    b.setAttribute('data-cmd', cmd);
    return b;
  }
  function smallBtn(cmd, arg, labelHtml, cls) {
    var b = el('button', 'btn sm' + (cls ? ' ' + cls : ''), labelHtml);
    b.setAttribute('data-cmd', cmd);
    if (arg !== undefined) b.setAttribute('data-arg', attr(JSON.stringify(arg)));
    return b;
  }
  function iconBtn(cmd, arg, title, ic, cls) {
    var b = el('button', 'iconbtn' + (cls ? ' ' + cls : ''), icon(ic, 13));
    b.title = title;
    b.setAttribute('data-cmd', cmd);
    if (arg !== undefined) b.setAttribute('data-arg', attr(JSON.stringify(arg)));
    return b;
  }

  function renderSessions(s) {
    viewEl.textContent = '';
    var toggleRow = el('div', 'btnrow');
    toggleRow.appendChild(smallBtn('dsh.toggleAllSessions', undefined, s.showAll ? '只看当前工作区' : '查看全部会话'));
    viewEl.appendChild(toggleRow);
    if (s.groups.length === 0) {
      viewEl.appendChild(el('div', 'empty', esc(s.emptyMsg || '暂无会话')));
    }
    s.groups.forEach(function (grp) {
      var g = el('div', 'sec');
      g.appendChild(headWithCount(grp.title, '<span style="color:var(--muted)">' + grp.sessions.length + ' 个会话</span>'));
      if (grp.subtitle) g.appendChild(el('div', 'path', esc(grp.subtitle)));
      grp.sessions.forEach(function (sess) {
        var chipCls = sess.running ? 'green' : 'gray';
        var headHtml = '<span class="chip ' + chipCls + '">' + icon(sess.running ? 'play' : 'session', 15) + '</span>' +
          '<span class="grow" style="flex:1;min-width:0">' +
          '<div class="title"><span class="txt">' + esc(sess.title) + '</span>' +
          (sess.running ? '<span class="badge run">运行中</span>' : '') +
          (sess.turns !== undefined ? '<span class="badge">' + sess.turns + ' 轮</span>' : '') +
          '</div><div class="meta">' +
          '<span>' + esc(sess.updatedText) + '</span>' +
          (sess.preset ? '<span>preset ' + esc(sess.preset) + '</span>' : '') +
          '</div></span>';
        var actions = '<span class="sess-actions" style="margin-left:auto;flex:0 0 auto">' +
          iconBtn('dsh.renameSession', sess.sessionId, '重命名', 'rename') +
          iconBtn('dsh.cancel', sess.sessionId, '停止当前回合', 'stop') +
          iconBtn('dsh.openInBrowser', sess.sessionId, '浏览器打开', 'globe') +
          '</span>';
        var row = el('div', 'card row clickable');
        row.setAttribute('data-cmd', 'dsh.openChat');
        row.setAttribute('data-arg', attr(JSON.stringify(sess.sessionId)));
        row.insertAdjacentHTML('beforeend', headHtml + actions);
        g.appendChild(row);
      });
      viewEl.appendChild(g);
    });
    var newRow = el('div', 'btnrow');
    newRow.appendChild(btn('dsh.newSession', icon('plus', 13) + '新建会话', 'primary'));
    viewEl.appendChild(newRow);
  }

  function renderService(sv) {
    viewEl.textContent = '';
    var stCls = sv.failed ? 'err' : (sv.running ? 'done' : 'neu');
    var card = el('div', 'card');
    card.appendChild(el('div', 'title', '<span class="chip ' + (sv.running ? 'green' : sv.failed ? 'red' : 'gray') + '">' +
      icon(sv.running ? 'check' : sv.failed ? 'stop' : 'server', 15) + '</span>' +
      '<span class="txt">' + esc(sv.statusText) + '</span>' +
      '<span class="badge ' + stCls + '">' + (sv.running ? '运行中' : sv.failed ? '失败' : '停止') + '</span>'));
    if (sv.url) card.appendChild(el('div', 'path', esc(sv.url)));
    if (sv.details && sv.details.length > 0) card.appendChild(el('div', 'meta', sv.details.map(esc).join(' · ')));
    if (sv.error) card.appendChild(el('div', 'desc', esc(sv.error)));
    if (sv.missingPath) {
      card.appendChild(el('div', 'note', '未配置本地服务目录（dsh.localServerPath）。'));
    }
    viewEl.appendChild(card);
    var acts = el('div', 'btnrow');
    if (sv.canStart) acts.appendChild(btn('dsh.startLocalService', icon('play', 13) + '启动服务（dsh web）', 'primary'));
    if (sv.canStop) acts.appendChild(btn('dsh.stopLocalService', icon('stop', 13) + '停止服务', 'danger'));
    acts.appendChild(btn('dsh.openSettings', icon('gear', 13) + '配置服务目录'));
    viewEl.appendChild(acts);
    if (sv.logs.length > 0) {
      var lg = el('div', 'sec');
      lg.appendChild(headWithCount('日志摘要', ''));
      lg.appendChild(el('div', 'logbox', esc(sv.logs.join('\n'))));
      viewEl.appendChild(lg);
    }
  }

  function renderSettings(s) {
    viewEl.textContent = '';
    if (s.note) viewEl.appendChild(el('div', 'note', esc(s.note)));
    s.groups.forEach(function (grp) {
      var g = el('div', 'sec');
      g.appendChild(headWithCount(grp.title, ''));
      var card = el('div', 'card');
      grp.rows.forEach(function (row) {
        var r = el('div', 'set-row');
        r.setAttribute('data-cmd', 'dsh.toggleSetting');
        r.setAttribute('data-arg', attr(JSON.stringify(row.key)));
        r.style.cursor = 'pointer';
        var grow = el('div', 'grow');
        grow.appendChild(el('div', 's-label', esc(row.label)));
        if (row.desc) grow.appendChild(el('div', 's-desc', esc(row.desc)));
        r.appendChild(grow);
        if (row.valueKind === 'bool') {
          var sw = el('label', 'switch');
          var inp = document.createElement('input');
          inp.type = 'checkbox';
          inp.checked = row.value === '开启';
          inp.setAttribute('data-cmd', 'dsh.toggleSetting');
          inp.setAttribute('data-arg', attr(JSON.stringify(row.key)));
          sw.appendChild(inp);
          sw.appendChild(el('span', 'slider'));
          r.appendChild(sw);
        } else {
          r.appendChild(el('span', 's-val', esc(row.value)));
        }
        card.appendChild(r);
      });
      g.appendChild(card);
      viewEl.appendChild(g);
    });
    var acts = el('div', 'btnrow');
    acts.appendChild(btn('dsh.openSettingsJson', icon('json', 13) + '打开设置 JSON'));
    viewEl.appendChild(acts);
  }

  function pluginCard(p) {
    var cls = p.kind === 'skill' ? 'warn' : p.kind === 'tool' ? 'cyan' : p.kind === 'preset' ? 'purple' : 'gray';
    var tagCls = 'tag ' + p.kind;
    var card = el('div', 'card row clickable');
    card.setAttribute('data-cmd', 'dsh.openPluginPath');
    card.setAttribute('data-arg', attr(JSON.stringify(p.path)));
    card.insertAdjacentHTML('beforeend',
      '<span class="chip ' + cls + '">' + icon(p.kind === 'skill' ? 'spark' : p.kind === 'tool' ? 'wrench' : p.kind === 'preset' ? 'json' : 'plug', 15) + '</span>' +
      '<span class="grow" style="flex:1;min-width:0">' +
      '<div class="title"><span class="txt">' + esc(p.name) + '</span><span class="' + tagCls + '">' + esc(p.kind) + '</span></div>' +
      (p.description ? '<div class="desc">' + esc(p.description) + '</div>' : '') +
      '<div class="path">' + esc(p.path) + '</div></span>');
    return card;
  }

  function renderPlugins(p) {
    viewEl.textContent = '';
    var g1 = el('div', 'sec');
    g1.appendChild(headWithCount('已安装（' + p.installed.length + '）', ''));
    if (p.installed.length === 0) g1.appendChild(el('div', 'empty', '还没有安装插件'));
    p.installed.forEach(function (pl) { g1.appendChild(pluginCard(pl)); });
    viewEl.appendChild(g1);
    var g2 = el('div', 'sec');
    g2.appendChild(headWithCount('可用（' + p.available.length + '）', ''));
    if (p.available.length === 0) g2.appendChild(el('div', 'note', '没有更多可用插件'));
    p.available.forEach(function (pl) { g2.appendChild(pluginCard(pl)); });
    viewEl.appendChild(g2);
    viewEl.appendChild(btn('dsh.openDshHome', icon('folderOpen', 13) + '打开 DSH_HOME 目录'));
  }

  function renderPresets(p) {
    viewEl.textContent = '';
    if (p.none) {
      viewEl.appendChild(el('div', 'empty', '暂无 preset 数据（连接 DSH 后可见）'));
      if (p.note) viewEl.appendChild(el('div', 'note', esc(p.note)));
    } else {
      p.list.forEach(function (pr) {
        var card = el('div', 'card row');
        var tags = '';
        if (pr.isDefault) tags += '<span class="tag def">服务端默认</span>';
        if (pr.configDefault) tags += '<span class="tag def">当前默认</span>';
        tags += '<span class="tag">' + esc(pr.trust) + '</span>';
        card.insertAdjacentHTML('beforeend',
          '<span class="chip purple">' + icon('spark', 15) + '</span>' +
          '<span class="grow" style="flex:1;min-width:0"><div class="title">' + esc(pr.id) + ' ' + tags + '</div>' +
          '<div class="desc">单击设为新建会话默认</div></span>');
        if (!pr.configDefault) {
          card.appendChild(smallBtn('dsh.usePreset', pr.id, '设为默认', ''));
        }
        viewEl.appendChild(card);
      });
      if (p.note) viewEl.appendChild(el('div', 'note', esc(p.note)));
    }
    var acts = el('div', 'btnrow');
    acts.appendChild(btn('dsh.newSession', icon('plus', 13) + '新建会话（默认 preset）', 'primary'));
    viewEl.appendChild(acts);
  }

  // ---------- routing ----------
  function render(snapshot) {
    var s = snapshot;
    titleEl.textContent = VIEW_TITLES[s.view] || 'DSH';
    dotEl.className = 'dot ' + (s.connected ? 'ok' : 'bad');
    connEl.textContent = s.connected ? '已连接' : '未连接';
    backBtn.style.visibility = s.view === 'home' ? 'hidden' : 'visible';
    var v = s.view;
    if (v === 'home' && s.home) renderHome(s.home, s.connected);
    else if (v === 'sessions' && s.sessions) renderSessions(s.sessions);
    else if (v === 'service' && s.service) renderService(s.service);
    else if (v === 'settings' && s.settings) renderSettings(s.settings);
    else if (v === 'plugins' && s.plugins) renderPlugins(s.plugins);
    else if (v === 'presets' && s.presets) renderPresets(s.presets);
    viewEl.scrollTop = 0;
  }

  // ---------- events ----------
  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (msg && msg.type === 'snapshot' && msg.snapshot) render(msg.snapshot);
  });
  backBtn.addEventListener('click', function () { post('dsh.sidebarBack'); });
  viewEl.addEventListener('click', function (ev) {
    var node = ev.target;
    while (node && node !== viewEl) {
      if (node.getAttribute && node.hasAttribute('data-cmd')) {
        var cmd = node.getAttribute('data-cmd');
        var argRaw = node.getAttribute('data-arg');
        var arg = undefined;
        if (argRaw) { try { arg = JSON.parse(argRaw); } catch (e) { arg = undefined; } }
        if (cmd === 'nav') {
          post('dsh.sidebarNavigate', node.getAttribute('data-nav'));
        } else {
          post(cmd, arg);
        }
        return;
      }
      node = node.parentNode;
    }
  });
  footEl.addEventListener('click', function (ev) {
    var node = ev.target;
    while (node && node !== footEl) {
      if (node.getAttribute && node.hasAttribute('data-cmd')) {
        var argRaw = node.getAttribute('data-arg');
        var arg = undefined;
        if (argRaw) { try { arg = JSON.parse(argRaw); } catch (e) { arg = undefined; } }
        post(node.getAttribute('data-cmd'), arg);
        return;
      }
      node = node.parentNode;
    }
  });
})();
</script>
</body>
</html>`
}
