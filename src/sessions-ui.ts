export function getSessionsHtml(): string {
	return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Sessions</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      background: #161b22;
      border-bottom: 1px solid #30363d;
      padding: 10px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    header h1 { font-size: 15px; font-weight: 600; }
    #status { font-size: 12px; color: #8b949e; }
    #auth-bar { display: flex; align-items: center; gap: 6px; margin-left: auto; }
    input[type=password], input[type=text] {
      background: #0d1117;
      border: 1px solid #30363d;
      color: #c9d1d9;
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 13px;
    }
    input:focus { outline: none; border-color: #1f6feb; }
    #token-input { width: 180px; }
    button {
      background: #21262d;
      border: 1px solid #30363d;
      color: #c9d1d9;
      padding: 5px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
    }
    button:hover { background: #30363d; }
    button:disabled { opacity: 0.4; cursor: default; }
    button.danger { border-color: #da3633; color: #f85149; }
    button.danger:hover { background: #1c0d0d; }
    button.primary { background: #238636; border-color: #2ea043; color: #fff; }
    button.primary:hover { background: #2ea043; }
    #main { display: flex; flex: 1; overflow: hidden; }
    #sidebar {
      width: 210px;
      flex-shrink: 0;
      background: #161b22;
      border-right: 1px solid #30363d;
      display: flex;
      flex-direction: column;
    }
    #sidebar-header {
      padding: 8px 10px;
      border-bottom: 1px solid #30363d;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #sidebar-header span { font-size: 12px; color: #8b949e; flex: 1; }
    #session-list { flex: 1; overflow-y: auto; padding: 4px; }
    .session-item {
      padding: 7px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
      color: #c9d1d9;
      border: 1px solid transparent;
    }
    .session-item:hover { background: #21262d; }
    .session-item.active { background: #1f2d4a; border-color: #1f6feb55; }
    .session-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #3fb950; flex-shrink: 0;
    }
    .session-dot.detached { background: #484f58; }
    .session-name {
      font-family: 'SF Mono', Menlo, monospace;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #content { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    #content-header {
      padding: 8px 14px;
      border-bottom: 1px solid #30363d;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
      background: #161b22;
    }
    #session-title {
      font-size: 12px;
      font-family: 'SF Mono', Menlo, monospace;
      color: #8b949e;
    }
    #terminal-wrap { flex: 1; overflow: hidden; }
    #terminal {
      width: 100%;
      height: 100%;
      overflow-y: auto;
      padding: 12px 14px;
      font-family: 'SF Mono', Menlo, 'Cascadia Code', 'Fira Code', monospace;
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-all;
      background: #0d1117;
      color: #c9d1d9;
    }
    #input-bar {
      padding: 8px 14px;
      border-top: 1px solid #30363d;
      display: flex;
      gap: 6px;
      align-items: center;
      background: #161b22;
      flex-shrink: 0;
    }
    #msg-input { flex: 1; font-family: monospace; }
  </style>
</head>
<body>
<header>
  <h1>Claude Sessions</h1>
  <span id="status">—</span>
  <div id="auth-bar">
    <input id="token-input" type="password" placeholder="Proxy token…">
    <button onclick="setToken()">Connect</button>
  </div>
</header>
<div id="main">
  <div id="sidebar">
    <div id="sidebar-header">
      <span id="session-count">Sessions</span>
      <button onclick="listSessions()" title="Refresh session list">↻</button>
    </div>
    <div id="session-list">
      <div style="padding:10px;font-size:12px;color:#484f58">Enter token to connect</div>
    </div>
  </div>
  <div id="content">
    <div id="content-header">
      <span id="session-title">No session selected</span>
      <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
        <span id="refresh-label" style="font-size:11px;color:#484f58"></span>
        <button id="kill-btn" class="danger" onclick="killSession()" style="display:none">Kill session</button>
      </div>
    </div>
    <div id="terminal-wrap">
      <div id="terminal"><span style="color:#484f58">Select a session from the left panel.</span></div>
    </div>
    <div id="input-bar">
      <input id="msg-input" type="text" placeholder="Send keys to session… (Enter to send)"
             onkeydown="if(event.key==='Enter'){event.preventDefault();sendText()}" disabled>
      <button id="send-btn" class="primary" onclick="sendText()" disabled>Send</button>
    </div>
  </div>
</div>
<script>
  let token = '';
  let selectedSession = '';
  let refreshTimer = null;

  // On load: try token from ?token= URL param, then sessionStorage
  (function init() {
    const params = new URLSearchParams(location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      token = urlToken;
      sessionStorage.setItem('proxy_token', token);
      params.delete('token');
      const cleaned = location.pathname + (params.toString() ? '?' + params : '');
      history.replaceState(null, '', cleaned);
    } else {
      token = sessionStorage.getItem('proxy_token') || '';
    }
    if (token) {
      document.getElementById('token-input').value = token;
      onConnected();
    }
  })();

  function setToken() {
    token = document.getElementById('token-input').value.trim();
    if (!token) return;
    sessionStorage.setItem('proxy_token', token);
    onConnected();
  }

  function onConnected() {
    setStatus('Connecting…');
    listSessions();
  }

  function setStatus(msg) {
    document.getElementById('status').textContent = msg;
  }

  async function apiFetch(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(body || {}),
    });
    if (r.status === 401) {
      setStatus('Auth failed — check token');
      throw Object.assign(new Error('Unauthorized'), { isAuth: true });
    }
    return r.json();
  }

  async function listSessions() {
    try {
      const data = await apiFetch('/sessions/list');
      const sessions = (data.sessions || []);
      const list = document.getElementById('session-list');
      list.innerHTML = '';
      if (sessions.length === 0) {
        list.innerHTML = '<div style="padding:10px;font-size:12px;color:#484f58">No active cproxy sessions</div>';
        document.getElementById('session-count').textContent = 'Sessions (0)';
        setStatus('Connected');
        return;
      }
      document.getElementById('session-count').textContent = \`Sessions (\${sessions.length})\`;
      setStatus('Connected');
      for (const s of sessions) {
        const el = document.createElement('div');
        el.className = 'session-item' + (s.name === selectedSession ? ' active' : '');
        el.dataset.name = s.name;
        el.onclick = () => selectSession(s.name);
        const dot = document.createElement('div');
        dot.className = 'session-dot' + (s.attached ? '' : ' detached');
        dot.title = s.attached ? 'attached' : 'detached';
        const nameEl = document.createElement('div');
        nameEl.className = 'session-name';
        nameEl.textContent = s.name.replace(/^cproxy_/, '');
        nameEl.title = s.name;
        el.appendChild(dot);
        el.appendChild(nameEl);
        list.appendChild(el);
      }
    } catch (e) {
      if (!e.isAuth) setStatus('Error listing sessions');
    }
  }

  function selectSession(name) {
    selectedSession = name;
    document.getElementById('session-title').textContent = name;
    document.getElementById('kill-btn').style.display = '';
    document.getElementById('msg-input').disabled = false;
    document.getElementById('send-btn').disabled = false;
    document.querySelectorAll('.session-item').forEach(el => {
      el.classList.toggle('active', el.dataset.name === name);
    });
    captureSession();
    startAutoRefresh();
  }

  async function captureSession() {
    if (!selectedSession) return;
    try {
      const data = await apiFetch('/sessions/capture', { session: selectedSession });
      if (data.status === 'error') {
        document.getElementById('terminal').textContent = 'Error: ' + data.error;
        return;
      }
      const term = document.getElementById('terminal');
      const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 60;
      // textContent auto-escapes HTML — safe against XSS from tmux output
      term.textContent = data.output || '';
      if (atBottom) term.scrollTop = term.scrollHeight;
      const now = new Date().toLocaleTimeString();
      document.getElementById('refresh-label').textContent = 'updated ' + now;
    } catch (e) {
      if (!e.isAuth) console.warn('capture error:', e.message);
    }
  }

  async function sendText() {
    if (!selectedSession) return;
    const input = document.getElementById('msg-input');
    const text = input.value;
    if (!text) return;
    input.value = '';
    input.disabled = true;
    document.getElementById('send-btn').disabled = true;
    try {
      const data = await apiFetch('/sessions/send', { session: selectedSession, text });
      if (data.status === 'error') setStatus('Send error: ' + data.error);
      // Brief delay so tmux can process the keypress before we capture
      setTimeout(captureSession, 350);
    } catch (e) {
      if (!e.isAuth) setStatus('Send failed');
    } finally {
      input.disabled = false;
      document.getElementById('send-btn').disabled = false;
      input.focus();
    }
  }

  async function killSession() {
    if (!selectedSession) return;
    if (!confirm(\`Kill session "\${selectedSession}"?\\n\\nThis will terminate the running Claude session.\`)) return;
    const name = selectedSession;
    stopAutoRefresh();
    selectedSession = '';
    document.getElementById('session-title').textContent = 'No session selected';
    document.getElementById('kill-btn').style.display = 'none';
    document.getElementById('msg-input').disabled = true;
    document.getElementById('send-btn').disabled = true;
    document.getElementById('terminal').textContent = '';
    document.getElementById('refresh-label').textContent = '';
    try {
      const data = await apiFetch('/sessions/kill', { session: name });
      if (data.status === 'error') setStatus('Kill error: ' + data.error);
      else setStatus('Session killed');
    } catch (e) {
      if (!e.isAuth) setStatus('Kill failed');
    }
    listSessions();
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(captureSession, 2000);
  }

  function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  // Refresh session list every 30s in the background
  setInterval(listSessions, 30_000);
</script>
</body>
</html>`;
}
