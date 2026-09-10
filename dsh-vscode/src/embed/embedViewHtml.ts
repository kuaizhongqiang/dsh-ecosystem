/**
 * embedViewHtml —— dsh.web WebviewView 宿主页面（iframe 内嵌 + 降级卡）。
 * 不含业务逻辑；所有状态由宿主侧 postMessage 驱动：
 *   {type:'load', url}          → iframe 内嵌 seam URL
 *   {type:'fallback', url, browserUrl, reason} → 显示降级卡
 *   {type:'busy', busy}         → 顶部状态
 * Webview 动作回宿主：
 *   {type:'ready'} / {type:'open-external', url} / {type:'retry'}
 */

export const embedViewHtml = (): string => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';
               frame-src http://127.0.0.1:* http://localhost:* https:;
               img-src 'self' data:; font-src 'self' data:;">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 10px;
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: 12px; color: var(--vscode-foreground);
    background: transparent;
  }
  .toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
  .toolbar .status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .75; }
  button {
    font: inherit; color: var(--vscode-button-foreground);
    background: var(--vscode-button-background); border: none; border-radius: 4px;
    padding: 3px 10px; cursor: pointer;
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button:disabled { opacity: .5; cursor: default; }
  .frame-wrap {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    border-radius: 6px; overflow: hidden; height: calc(100vh - 58px);
    background: var(--vscode-editor-background);
  }
  iframe { width: 100%; height: 100%; border: 0; display: block; }
  .card {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    border-radius: 8px; padding: 14px; margin-top: 4px;
    background: var(--vscode-editorWidget-background, transparent);
  }
  .card h3 { margin: 0 0 8px; font-size: 13px; }
  .card p { margin: 6px 0; opacity: .9; line-height: 1.5; }
  .card .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .hint { font-size: 11px; opacity: .65; margin-top: 8px; }
  code { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.15)); padding: 1px 5px; border-radius: 3px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <div class="toolbar">
    <button id="openBtn" title="在默认浏览器打开 dsh UI">在浏览器打开</button>
    <button id="refreshBtn" class="secondary" title="重新探测并加载">刷新</button>
    <span class="status" id="status">初始化…</span>
  </div>
  <div class="frame-wrap" id="frameWrap" hidden><iframe id="frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe></div>
  <div class="card" id="fallback" hidden>
    <h3>无法在侧栏内嵌 dsh 网页</h3>
    <p id="reasonText"></p>
    <div class="actions">
      <button id="openBtn2">在默认浏览器打开 dsh UI</button>
      <button id="retryBtn" class="secondary">重试探测</button>
    </div>
    <div class="hint" id="hint"></div>
  </div>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const status = $('status');
  const frame = $('frame');
  const frameWrap = $('frameWrap');
  const fallback = $('fallback');
  let browserUrl = '';

  function showBusy(text) { status.textContent = text; }
  function post(msg) { vscode.postMessage(msg); }

  function showLoad(url) {
    frameWrap.hidden = false;
    fallback.hidden = true;
    status.textContent = '内嵌加载中…（等待服务器 seam）';
    frame.src = url;
  }
  function showFallback(data) {
    frameWrap.hidden = true;
    fallback.hidden = false;
    browserUrl = data.browserUrl || data.url || '';
    const reasons = {
      'no-token': '当前连接没有可用令牌（launch-token）。',
      'no-seam': '当前 dsh server 版本未提供 embed 认证 seam（/api/embed/capability）。内嵌需要 dsh server 端 seam 支持。',
      unreachable: '尚未连接 dsh server，或无法访问。',
    };
    $('reasonText').textContent = reasons[data.reason] || '未知原因。';
    status.textContent = '降级：在浏览器打开';
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'load') showLoad(m.url);
    else if (m.type === 'fallback') showFallback(m);
    else if (m.type === 'busy') showBusy(m.busy ? '探测中…' : '就绪');
  });

  function openExternal() {
    const u = browserUrl || (frame.src && frame.src.startsWith('http') ? frame.src : '');
    if (u) post({ type: 'open-external', url: u });
  }
  $('openBtn').addEventListener('click', openExternal);
  $('openBtn2').addEventListener('click', openExternal);
  $('refreshBtn').addEventListener('click', () => post({ type: 'retry' }));
  $('retryBtn').addEventListener('click', () => post({ type: 'retry' }));

  // iframe 加载完成状态（嵌入成功时更新状态行）
  frame.addEventListener('load', () => {
    if (!frameWrap.hidden) status.textContent = '内嵌中…（若空白，说明服务器尚未允许 framing/seam）';
  });

  post({ type: 'ready' });
})();
</script>
</body>
</html>`
