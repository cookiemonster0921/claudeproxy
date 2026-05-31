// Minimal HTML dashboard — no framework, no build step, no external deps.
// Fetches /analytics/summary and /analytics/recent via JS on load.
// Recent Requests shows AI calls only: snapshots plus separated context/billable accounting.

export function getDashboardHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Proxy — Analytics</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#0d1117;color:#c9d1d9;min-height:100vh;padding:24px}
  h1{font-size:18px;color:#58a6ff;margin-bottom:4px}
  .subtitle{color:#6e7681;margin-bottom:24px;font-size:12px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
  .stat{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:14px}
  .stat-label{color:#6e7681;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
  .stat-value{color:#e6edf3;font-size:22px;font-weight:700}
  .stat-value.green{color:#3fb950}
  .stat-value.red{color:#f85149}
  .stat-value.yellow{color:#d29922}
  .section{margin-bottom:24px}
  .section-title{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;border-bottom:1px solid #21262d;padding-bottom:6px}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;color:#6e7681;font-weight:normal;font-size:11px;padding:6px 8px;border-bottom:1px solid #21262d}
  td{padding:7px 8px;border-bottom:1px solid #161b22;vertical-align:middle}
  tr:hover td{background:#161b22}
  .pill{display:inline-block;padding:1px 6px;border-radius:10px;font-size:11px;font-weight:600}
  .pill-green{background:#1a3a1a;color:#3fb950}
  .pill-red{background:#3a1a1a;color:#f85149}
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .error{color:#f85149;padding:12px;background:#1c1010;border-radius:6px;margin-top:8px}
  .loading{color:#6e7681;font-style:italic}
  .refresh-info{color:#6e7681;font-size:11px;margin-top:16px;text-align:right}
  /* Token progress bar */
  .tok-wrap{display:flex;align-items:center;gap:6px;min-width:110px}
  .tok-bar{background:#1c2128;border-radius:3px;height:5px;width:80px;flex-shrink:0}
  .tok-fill{height:5px;border-radius:3px;background:linear-gradient(90deg,#388bfd,#3fb950);transition:width .3s}
  .tok-label{color:#8b949e;font-size:11px;white-space:nowrap}
  /* Snapshot cells */
  .snap{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8b949e;font-size:12px;cursor:default;display:block}
  .snap-tool{color:#d29922}
  .snap em{color:#6e7681;font-style:normal}
  /* Model+provider cell */
  .mp-model{color:#c9d1d9}
  .mp-prov{color:#6e7681;font-size:11px}
  @media(max-width:700px){.two-col{grid-template-columns:1fr}}
</style>
</head>
<body>
<h1>Claude Proxy Analytics</h1>
<p class="subtitle">AI calls only — prompts/responses stored as 200-char snapshots. Hover cells to see full text. Auto-refreshes every 30 s.</p>

<div class="stats" id="stats"><p class="loading">Loading stats…</p></div>

<div class="two-col">
  <div class="section">
    <div class="section-title">By Model</div>
    <table id="tbl-model"><tr><th>Model</th><th>Requests</th><th>Billable</th><th>Context Est.</th><th>Est. Cost</th></tr></table>
  </div>
  <div class="section">
    <div class="section-title">By Provider</div>
    <table id="tbl-provider"><tr><th>Provider</th><th>Requests</th><th>Billable</th><th>Context Est.</th><th>Est. Cost</th></tr></table>
  </div>
</div>

<div class="section">
  <div class="section-title">Recent AI Requests</div>
  <table id="tbl-recent">
    <tr>
      <th>Time</th>
      <th>Model / Provider</th>
      <th>Status</th>
      <th>Context estimate</th>
      <th>Billable tokens</th>
      <th>Output tokens</th>
      <th>Request kind</th>
      <th>Prompt</th>
      <th>Response / Tool</th>
    </tr>
  </table>
</div>

<div class="section" id="errors-section" style="display:none">
  <div class="section-title">Recent Errors</div>
  <table id="tbl-errors"><tr><th>Time</th><th>Path</th><th>Status</th><th>Type</th></tr></table>
</div>

<p class="refresh-info" id="refresh-info"></p>

<script>
// Simple HTML escape to prevent XSS in snapshot text
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const fmt = {
  cost: v => '$' + Number(v).toFixed(6),
  ts: s => { try { return new Date(s).toLocaleTimeString(); } catch { return s; } },
};

function pill(ok, label) {
  return '<span class="pill ' + (ok ? 'pill-green' : 'pill-red') + '">' + label + '</span>';
}

// Token bar: 200K context = 100%
const TOKEN_MAX = 200_000;
function tokenBar(total) {
  const pct = Math.min(100, total / TOKEN_MAX * 100).toFixed(1);
  let label;
  if (total >= 1000) label = (total/1000).toFixed(1) + 'K';
  else label = String(total);
  return '<div class="tok-wrap">' +
    '<div class="tok-bar"><div class="tok-fill" style="width:' + pct + '%"></div></div>' +
    '<span class="tok-label">' + label + '</span>' +
    '</div>';
}

function renderStats(s) {
  const rate = s.total_requests === 0 ? 0 : s.successful_requests / s.total_requests * 100;
  const rateClass = rate >= 95 ? 'green' : rate >= 80 ? 'yellow' : 'red';
  document.getElementById('stats').innerHTML = [
    ['AI Requests',      s.total_requests.toLocaleString(),          ''],
    ['Success Rate',     rate.toFixed(1) + '%',                      rateClass],
    ['Billable Tokens',  Number(s.total_billable_tokens).toLocaleString(), ''],
    ['Est. Context',     Number(s.total_estimated_context_tokens).toLocaleString(), ''],
    ['Output Tokens',    Number(s.total_output_tokens).toLocaleString(), ''],
    ['Failed / Limited', Number(s.failed_or_rate_limited_requests).toLocaleString(), 'red'],
    ['Est. Cost',        fmt.cost(s.total_estimated_cost_usd),       ''],
    ['Avg Latency',      Number(s.avg_duration_ms).toFixed(0) + 'ms',
      s.avg_duration_ms > 5000 ? 'red' : s.avg_duration_ms > 2000 ? 'yellow' : 'green'],
  ].map(([label, value, cls]) =>
    '<div class="stat"><div class="stat-label">'+label+'</div><div class="stat-value '+cls+'">'+value+'</div></div>'
  ).join('');
}

function renderDim(tableId, rows) {
  const tbl = document.getElementById(tableId);
  const hdr = tbl.querySelector('tr');
  tbl.innerHTML = '';
  tbl.appendChild(hdr);
  if (!rows.length) {
    tbl.innerHTML += '<tr><td colspan="5" style="color:#6e7681">No data yet</td></tr>';
    return;
  }
  rows.forEach(r => {
    tbl.innerHTML += '<tr>' +
      '<td>' + esc(r.key) + '</td>' +
      '<td>' + Number(r.count).toLocaleString() + '</td>' +
      '<td>' + Number(r.billable_tokens ?? r.total_tokens ?? 0).toLocaleString() + '</td>' +
      '<td>' + Number(r.estimated_context_tokens ?? 0).toLocaleString() + '</td>' +
      '<td>' + fmt.cost(r.total_cost_usd) + '</td></tr>';
  });
}

function renderRecent(rows) {
  const tbl = document.getElementById('tbl-recent');
  const hdr = tbl.querySelector('tr');
  tbl.innerHTML = '';
  tbl.appendChild(hdr);
  if (!rows.length) {
    tbl.innerHTML += '<tr><td colspan="9" style="color:#6e7681">No AI requests yet — start Claude Code via the proxy to see data here.</td></tr>';
    return;
  }
  rows.slice(0, 50).forEach(r => {
    const statusCell = pill(r.success, r.status_code) +
      ' <span style="color:#6e7681;font-size:11px">' + (r.duration_ms||0) + 'ms</span>';

    const modelCell = '<span class="mp-model">' + esc(r.model||'—') + '</span>' +
      (r.provider ? '<br><span class="mp-prov">' + esc(r.provider) + '</span>' : '');

    const contextCell = tokenBar(Number(r.estimated_context_tokens ?? r.approximate_input_tokens ?? 0));
    const billableCell = Number((r.billable_input_tokens ?? 0) + (r.billable_output_tokens ?? 0)).toLocaleString();
    const outputCell = Number(r.approximate_output_tokens ?? r.billable_output_tokens ?? 0).toLocaleString();
    const kindCell = '<span class="pill ' + (r.request_kind === 'rate_limited' || r.request_kind === 'failed' ? 'pill-red' : 'pill-green') + '">' + esc(r.request_kind || 'normal') + '</span>' +
      (r.was_retry ? ' <span style="color:#d29922;font-size:11px">retry ' + Number(r.retry_count || 1) + '</span>' : '');

    // Prompt snapshot
    const ps = r.prompt_snapshot || '';
    const promptCell = ps
      ? '<span class="snap" title="' + esc(ps) + '">' + esc(ps.slice(0, 80)) + (ps.length > 80 ? '…' : '') + '</span>'
      : '<em class="snap">—</em>';

    // Response or tool snapshot
    let replyCell;
    if (r.tool_snapshot) {
      let tools = [];
      try { tools = JSON.parse(r.tool_snapshot); } catch {}
      replyCell = tools.map(t =>
        '<span class="snap snap-tool" title="' + esc(t.args) + '">🔧 ' + esc(t.name) + '</span>'
      ).join('<br>') || '<em class="snap">—</em>';
    } else if (r.response_snapshot) {
      const rs = r.response_snapshot;
      replyCell = '<span class="snap" title="' + esc(rs) + '">' + esc(rs.slice(0, 80)) + (rs.length > 80 ? '…' : '') + '</span>';
    } else {
      replyCell = '<em class="snap" style="color:#6e7681">streaming / no snapshot</em>';
    }

    tbl.innerHTML += '<tr>' +
      '<td style="white-space:nowrap;color:#8b949e">' + fmt.ts(r.timestamp) + '</td>' +
      '<td>' + modelCell + '</td>' +
      '<td>' + statusCell + '</td>' +
      '<td>' + contextCell + '</td>' +
      '<td>' + billableCell + '</td>' +
      '<td>' + outputCell + '</td>' +
      '<td>' + kindCell + '</td>' +
      '<td>' + promptCell + '</td>' +
      '<td>' + replyCell + '</td>' +
      '</tr>';
  });
}

function renderErrors(errors) {
  const sec = document.getElementById('errors-section');
  if (!errors.length) { sec.style.display = 'none'; return; }
  sec.style.display = '';
  const tbl = document.getElementById('tbl-errors');
  const hdr = tbl.querySelector('tr');
  tbl.innerHTML = '';
  tbl.appendChild(hdr);
  errors.forEach(e => {
    tbl.innerHTML += '<tr>' +
      '<td>' + fmt.ts(e.timestamp) + '</td>' +
      '<td>' + esc(e.path) + '</td>' +
      '<td>' + pill(false, e.status_code) + '</td>' +
      '<td>' + esc(e.error_type || '—') + '</td></tr>';
  });
}

async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || JSON.stringify(data);
    const hint = msg.includes('no such table')
      ? '<br><br><b>Run the migration to create the analytics table:</b><br>' +
        '<code>npm run db:migrate:local</code> &nbsp;(local dev)<br>' +
        '<code>npm run db:migrate:remote</code> &nbsp;(deployed worker)'
      : '';
    throw new Error(msg + hint);
  }
  return data;
}

async function refresh() {
  try {
    const [summary, recent] = await Promise.all([
      fetchJson('/analytics/summary'),
      fetchJson('/analytics/recent?limit=50'),
    ]);
    const s = {
      total_requests:           Number(summary.total_requests           ?? 0),
      successful_requests:      Number(summary.successful_requests      ?? 0),
      failed_requests:          Number(summary.failed_requests          ?? 0),
      failed_or_rate_limited_requests: Number(summary.failed_or_rate_limited_requests ?? 0),
      total_estimated_cost_usd: Number(summary.total_estimated_cost_usd ?? 0),
      total_input_tokens:       Number(summary.total_input_tokens       ?? 0),
      total_output_tokens:      Number(summary.total_output_tokens      ?? 0),
      total_billable_tokens:    Number(summary.total_billable_tokens    ?? 0),
      total_estimated_context_tokens: Number(summary.total_estimated_context_tokens ?? 0),
      avg_duration_ms:          Number(summary.avg_duration_ms          ?? 0),
      by_model:    Array.isArray(summary.by_model)     ? summary.by_model     : [],
      by_provider: Array.isArray(summary.by_provider)  ? summary.by_provider  : [],
      recent_errors: Array.isArray(summary.recent_errors) ? summary.recent_errors : [],
    };
    renderStats(s);
    renderDim('tbl-model', s.by_model);
    renderDim('tbl-provider', s.by_provider);
    renderRecent(Array.isArray(recent.results) ? recent.results : []);
    renderErrors(s.recent_errors);
    document.getElementById('refresh-info').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
  } catch (err) {
    document.getElementById('stats').innerHTML =
      '<div class="error">⚠ ' + (err.message || String(err)) + '</div>';
  }
}

refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`;
}
