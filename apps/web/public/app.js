/* FinPilot dashboard SPA — zero dependencies, fetches only the real API.
   Defensive by design: every API payload is normalized before rendering so a
   partial/failed response can never crash a page. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const state = { page: 'overview', user: null, users: [], run: null, tasks: [], metrics: null, pending: [], es: null };

/* ---------------- normalizers (defensive data access) ---------------- */
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v, d = '') => (v == null ? d : String(v));
const rowsOf = (v, keys) => { const a = arr(v); return keys && a.length && typeof a[0] !== 'object' ? [] : a; };

const fmtINR = (n) => {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  const neg = Number(n) < 0; const abs = Math.abs(Number(n));
  const s = abs.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  return (neg ? '-₹' : '₹') + s;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jarr = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(state.user ? { 'X-Finpilot-User': state.user.email } : {}), ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body && typeof body === 'object' ? body : {};
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = ''; }, 3800);
}

function errorCard(e) {
  return `<div class="card error-card"><h3>Something went wrong</h3>
    <div class="small muted">${esc(e?.message ?? String(e))}</div>
    <div class="tiny" style="margin-top:8px">The API may still be running a step — try again in a moment.</div></div>`;
}

const emptyState = (icon, title, sub) => `<div class="empty"><div class="empty-icon">${icon}</div><div>${esc(title)}</div><div class="small">${esc(sub ?? '')}</div></div>`;

/* ---------------- navigation ---------------- */
const PAGES = {
  overview: { title: 'Overview', sub: 'September 2026 close — live metrics from the database', render: renderOverview },
  close: { title: 'Close Progress', sub: 'Orchestrator state machine — checkpoints after every task', render: renderClose },
  reconciliation: { title: 'Reconciliation', sub: 'Bank ↔ ledger matching — deterministic + fuzzy passes', render: renderReconciliation },
  exceptions: { title: 'Exceptions', sub: 'Detected anomalies with evidence, policy and risk analysis', render: renderExceptions },
  journals: { title: 'Journal Entries', sub: 'Balanced, idempotent, human-approved before posting', render: renderJournals },
  evidence: { title: 'Evidence Graph', sub: 'Vendor → Contract → PO → Invoice → Payment → Bank → GL → Policy', render: renderEvidence },
  forecast: { title: 'Forecast', sub: 'Deterministic cash projection with disclosed assumptions', render: renderForecast },
  audit: { title: 'Audit Package', sub: 'Close certification with evidence-linked conclusions', render: renderAudit },
  agent: { title: 'Agent Activity', sub: 'Every persisted agent run, tool call and decision', render: renderAgent },
  policies: { title: 'Policies', sub: 'Configurable autonomy thresholds — enforced server-side', render: renderPolicies },
  settings: { title: 'Settings', sub: 'Environment, roles and demo controls', render: renderSettings },
  ao: { title: 'Build With AO', sub: 'Actual AI-assisted development evidence — nothing fabricated', render: renderAO },
};

function nav(page) {
  if (!PAGES[page]) page = 'overview';
  state.page = page;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  $('#page-title').textContent = PAGES[page].title;
  $('#page-sub').textContent = PAGES[page].sub;
  PAGES[page].render().catch((e) => { $('#page').innerHTML = errorCard(e); });
}

/* ---------------- data loaders ---------------- */
async function loadState() {
  const d = await api('/api/state');
  state.run = d.run ?? null;
  state.tasks = arr(d.tasks);
  state.metrics = d.metrics && typeof d.metrics === 'object' ? d.metrics : {};
  state.pending = arr(d.pending_approvals);
  renderRunStatus();
  return d;
}

function renderRunStatus() {
  const el = $('#run-status');
  if (!el) return;
  const fill = $('#mini-progress-fill');
  const p = num(state.run?.progress, 0);
  if (fill) fill.style.width = `${p}%`;
  if (!state.run) { el.innerHTML = '<span class="chip">NO CLOSE RUN</span>'; return; }
  const s = str(state.run.status);
  const cls = s === 'COMPLETED' ? 'ok' : s === 'FAILED' ? 'err' : s === 'AWAITING_HUMAN' ? 'warn' : 'run';
  el.innerHTML = `<span class="chip ${cls}">${esc(s)}</span><span>${p}% · ${esc(str(state.run.period))}</span>`;
}

function pausedBanner(d) {
  const pend = arr(d?.pending_approvals);
  if (!d?.paused || pend.length === 0) return '';
  const p0 = pend[0] ?? {};
  return `<div class="paused-banner">⏸ <span>Workflow paused for human approval — <b>${esc(str(p0.exc_title))}</b>
    (${fmtINR(p0.exc_amount)}${p0.required_role ? `, needs ${esc(str(p0.required_role))}` : ''}).
    Open <a href="#" data-goto="exceptions" style="color:inherit;font-weight:600">Exceptions</a> to review.</span></div>`;
}

/* ---------------- pages ---------------- */
async function renderOverview() {
  const d = await loadState();
  const m = state.metrics;
  const sev = m.exception_severity_counts && typeof m.exception_severity_counts === 'object' ? m.exception_severity_counts : {};
  const js = m.journal_stats && typeof m.journal_stats === 'object' ? m.journal_stats : {};
  const humanReview = num(m.human_review_count) + state.pending.length;
  const kpi = (label, value, sub, cls = '') => `<div class="card kpi ${cls}"><h3>${label}</h3><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;

  $('#page').innerHTML = `
    ${pausedBanner(d)}
    <div class="grid cols-4">
      ${kpi('Close progress', `${num(m.close_progress)}%`, esc(state.run?.title ?? 'Not started'))}
      ${kpi('Transactions processed', num(m.transactions_processed).toLocaleString('en-IN'), 'bank + ledger rows (synthetic)')}
      ${kpi('Auto-matched', num(m.matched_count).toLocaleString('en-IN'), 'deterministic reconciliation')}
      ${kpi('Auto-resolved by agent', num(m.auto_resolved_count), 'controlled autonomy policy', num(m.auto_resolved_count) ? 'pos' : '')}
    </div>
    <div class="grid cols-4 section-gap">
      ${kpi('Human review', humanReview, humanReview ? 'awaiting finance team' : 'queue clear', humanReview ? '' : 'pos')}
      ${kpi('Unresolved / escalated', num(m.unresolved_count), num(m.unresolved_count) ? 'see exceptions' : 'none — clean close', num(m.unresolved_count) ? '' : 'pos')}
      ${kpi('Journals posted', `${num(js.posted)}/${num(js.total)}`, 'balanced Dr = Cr, idempotent')}
      ${kpi('Cash position', fmtINR(m.cash_position), `change ${fmtINR(m.cash_change)} this month`, num(m.cash_change) < 0 ? 'neg' : 'pos')}
    </div>
    <div class="grid cols-2 section-gap">
      <div class="card"><h3>Risk & severity mix</h3>
        <div class="grid cols-4">
          ${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => `<div><div class="kpi-sub">${s}</div><div class="kpi-value" style="font-size:1.35rem">${num(sev[s])}</div></div>`).join('')}
        </div>
        <div class="tiny" style="margin-top:12px">Forecast next month ${fmtINR(m.forecast_next_month)} · risk score ${num(m.risk_score)}/100</div>
      </div>
      <div class="card"><h3>Agent activity (live)</h3><div id="ov-agent" class="small muted">Loading…</div></div>
    </div>
    <div class="card"><h3>Recent exceptions</h3><div id="ov-exc" class="small muted">Loading…</div></div>`;

  api('/api/agent-activity').then((a) => {
    const acts = arr(a?.actions).slice(0, 6);
    $('#ov-agent').innerHTML = acts.length
      ? acts.map((x) => `<div class="small">• <b>${esc(str(x.agent))}</b> ${esc(str(x.action))} — ${esc(str(x.output_summary).slice(0, 90))} <span class="tiny">${x.created_at ? new Date(x.created_at).toLocaleTimeString() : ''}</span></div>`).join('')
      : 'No agent activity yet — start the close.';
  }).catch(() => { $('#ov-agent').innerHTML = 'Agent activity unavailable.'; });

  api('/api/exceptions').then((e) => {
    const exs = arr(e?.exceptions).slice(0, 6);
    $('#ov-exc').innerHTML = exs.length
      ? exs.map((x) => `<div class="small" style="display:flex;justify-content:space-between;gap:10px;align-items:center"><span>• <b>${esc(str(x.code))}</b> ${esc(str(x.title))}</span><span style="display:flex;gap:6px"><span class="chip ${esc(str(x.severity))}">${esc(str(x.severity))}</span><span class="chip">${esc(str(x.status))}</span></span></div>`).join('')
      : 'No exceptions.';
  }).catch(() => { $('#ov-exc').innerHTML = 'Exceptions unavailable.'; });
}

async function renderClose() {
  const d = await loadState();
  const items = state.tasks.map((t) => `
    <div class="tl-item ${t.status === 'DONE' ? 'done' : t.status === 'RUNNING' ? 'running' : t.status === 'FAILED' ? 'failed' : t.status === 'PAUSED' ? 'paused' : ''}">
      <div class="tl-title">${esc(str(t.title))} <span class="chip">${esc(str(t.status))}</span>${num(t.attempt) > 1 ? ` <span class="chip warn">attempt ${num(t.attempt)}</span>` : ''}</div>
      ${t.detail ? `<div class="tl-detail">${esc(str(t.detail))}</div>` : ''}
    </div>`).join('');
  const p = num(state.run?.progress, 0);
  const s = str(state.run?.status, 'NOT STARTED');
  $('#page').innerHTML = `
    ${pausedBanner(d)}
    <div class="grid cols-3">
      <div class="card"><h3>Workflow progress</h3>
        <div class="progress-track"><div class="progress-fill" style="width:${p}%"></div></div>
        <div class="kpi-sub" style="margin-top:10px"><b>${s}</b> — ${p}% · checkpoint saved after every task; safe to resume</div>
      </div>
      <div class="card"><h3>Connector resilience (Case 4)</h3><div class="small muted">Synthetic bank connector times out on batch <span class="mono">fx-2026</span> (2 failed attempts, exponential backoff, then success). The workflow resumes from its checkpoint — no duplicate fetches, no duplicate postings.</div></div>
      <div class="card"><h3>Human gate</h3><div class="small">${state.pending.length ? `<b>${state.pending.length}</b> item(s) pending — material items pause the workflow; others wait in the review queue.` : 'No pending approvals.'}</div></div>
    </div>
    <div class="card"><h3>Close plan (Orchestrator Agent)</h3><div class="timeline">${items || emptyState('⏱', 'No close run yet', 'Start the September close from the sidebar.')}</div></div>`;
}

async function renderReconciliation() {
  let d;
  try { d = await api('/api/reconciliation'); } catch (e) { $('#page').innerHTML = errorCard(e); return; }
  const byType = arr(d?.by_type);
  const samples = arr(d?.samples);
  $('#page').innerHTML = `
    <div class="grid cols-2">
      <div class="card"><h3>Match composition</h3>
        <table><tr><th>Type</th><th>Status</th><th class="num">Count</th><th class="num">Amount</th></tr>
        ${byType.map((r) => `<tr><td><span class="chip">${esc(str(r.match_type))}</span></td><td>${esc(str(r.status))}</td><td class="num">${num(r.c)}</td><td class="num">${fmtINR(r.total)}</td></tr>`).join('') || `<tr><td colspan="4">${emptyState('⇄', 'No reconciliation yet', 'Start the close to run the matching passes.')}</td></tr>`}
        </table></div>
      <div class="card"><h3>How matching works</h3><div class="small muted">
        <b>Pass 1</b> — exact reference + amount.<br><br><b>Pass 2</b> — amount + date window + counterparty.<br><br><b>Pass 3</b> — fuzzy within 1.5% (flags mismatches / FX variance).<br><br>Unmatched rows go to the exception engine; designed anomalies become typed exceptions, benign feed noise is summarized in the audit package.</div></div>
    </div>
    <div class="card"><h3>Matched pairs (sample)</h3>
      ${samples.length ? `<div class="table-wrap"><table><tr><th>Date</th><th>Bank description</th><th>Ledger description</th><th>Ref</th><th>Type</th><th class="num">Score</th><th class="num">Amount</th></tr>
      ${samples.map((sm) => `<tr><td class="small muted">${esc(str(sm.bank_date))}</td><td class="small">${esc(str(sm.bank_desc).slice(0, 44))}</td><td class="small muted">${esc(str(sm.ledger_desc).slice(0, 44))}</td><td class="mono tiny">${esc(str(sm.reference))}</td><td><span class="chip">${esc(str(sm.match_type))}</span></td><td class="num">${(num(sm.score) * 100).toFixed(0)}%</td><td class="num">${fmtINR(sm.amount)}</td></tr>`).join('')}
      </table></div>` : emptyState('⇄', 'No matches recorded yet', 'Run the close first.')}</div>
    ${d?.unmatched_note ? `<div class="card"><h3>Unmatched rows</h3><div class="small muted">${esc(str(d.unmatched_note))}</div></div>` : ''}`;
}

async function renderExceptions() {
  const [d, st] = await Promise.all([api('/api/exceptions').catch(() => ({})), loadState()]);
  const exs = arr(d?.exceptions);
  const rows = exs.map((x) => `
    <tr data-exc="${esc(str(x.id))}">
      <td class="mono tiny">${esc(str(x.code))}</td>
      <td>${esc(str(x.title))}<div class="tiny">${esc(str(x.type))}${x.demo_case ? ` · <span style="color:var(--warn)">DEMO ${esc(str(x.demo_case))}</span>` : ''}</div></td>
      <td class="num">${fmtINR(x.amount)}</td>
      <td><span class="chip ${esc(str(x.severity))}">${esc(str(x.severity))}</span></td>
      <td><span class="chip ${str(x.status) === 'RESOLVED_AUTO' ? 'ok' : str(x.status) === 'RESOLVED_HUMAN' ? 'run' : str(x.status) === 'REJECTED' ? 'err' : 'warn'}">${esc(str(x.status))}</span></td>
      <td class="num">${num(x.confidence).toFixed(0)}%</td>
      <td><span class="chip ${esc(str(x.risk_level))}">${esc(str(x.risk_level))}</span></td>
      <td class="tiny muted">${esc(str(x.materiality_level))}</td>
    </tr>`).join('');
  $('#page').innerHTML = `
    ${pausedBanner(st)}
    <div class="card"><h3>Exception queue — ${exs.length} item(s) (click a row to investigate)</h3>
    ${exs.length ? `<div class="table-wrap"><table><tr><th>Code</th><th>Title</th><th class="num">Amount</th><th>Severity</th><th>Status</th><th class="num">Conf</th><th>Risk</th><th>Materiality</th></tr>${rows}</table></div>` : emptyState('✓', 'No exceptions', 'Run the close — detected anomalies will appear here.')}</div>`;
  $$('#page tr[data-exc]').forEach((tr) => tr.addEventListener('click', () => openException(tr.dataset.exc)));
}

async function openException(id) {
  let d;
  try { d = await api(`/api/exceptions/${encodeURIComponent(id)}`); } catch (e) { toast(e.message, true); return; }
  const x = d?.exception ?? {};
  const pj = x.proposed_journal_json ? jarr(x.proposed_journal_json) === null ? null : safeObj(x.proposed_journal_json) : null;
  const g = d?.graph && typeof d.graph === 'object' ? d.graph : { nodes: [], edges: [] };
  const evidence = arr(d?.evidence);
  const journal = d?.journal ?? null;
  const approval = d?.approval ?? null;
  $('#drawer-content').innerHTML = `
    <h2 style="margin-bottom:4px">${esc(str(x.code))} — ${esc(str(x.title))}</h2>
    <div class="tiny" style="margin-bottom:12px">${esc(str(x.type))}${x.created_at ? ` · created ${new Date(x.created_at).toLocaleString()}` : ''}</div>
    <div class="review">
      <div class="head"><div class="amount">${fmtINR(x.amount)}</div>
        <div><span class="chip ${esc(str(x.severity))}">${esc(str(x.severity))}</span> <span class="chip ${esc(str(x.risk_level))}">risk ${esc(str(x.risk_level))} ${num(x.risk_score)}</span> <span class="chip">${esc(str(x.materiality_level))}</span></div></div>
      <div class="meta"><span class="chip ${str(x.status) === 'RESOLVED_AUTO' ? 'ok' : 'warn'}">${esc(str(x.status))}</span><span class="chip run">confidence ${num(x.confidence).toFixed(0)}%</span>${x.demo_case ? `<span class="chip warn">DEMO ${esc(str(x.demo_case))}</span>` : ''}</div>
      ${x.finding ? `<div class="finding"><b>AI finding:</b> ${esc(str(x.finding))}</div>` : ''}
      ${x.likely_cause ? `<div class="finding"><b>Likely cause:</b> ${esc(str(x.likely_cause))}</div>` : ''}
      ${x.recommendation ? `<div class="finding"><b>Recommendation:</b> ${esc(str(x.recommendation))}</div>` : ''}
      ${jarr(x.risk_factors_json).map((f) => `<div class="tiny">• ${esc(str(f))}</div>`).join('')}
      ${jarr(x.policy_results_json).map((p) => `<div class="small" style="margin-top:6px"><span class="chip ${p?.passed ? 'ok' : 'err'}">${p?.passed ? 'PASS' : 'FAIL'}</span> <b>${esc(str(p?.policy_code))}</b> — <span class="muted">${esc(str(p?.detail))}</span></div>`).join('')}
      ${x.resolution ? `<div class="finding" style="color:var(--ok)"><b>Resolution:</b> ${esc(str(x.resolution))}</div>` : ''}
    </div>
    ${pj ? `<div class="card"><h3>Proposed journal entry</h3><div class="mono tiny">${esc(str(pj.description))}</div>
      <table><tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr>
      ${arr(pj.lines).map((l) => `<tr><td>${esc(str(l?.account_code))} ${esc(str(l?.account_name))}<div class="tiny muted">${esc(str(l?.description))}</div></td><td class="num">${l?.debit ? fmtINR(l.debit) : ''}</td><td class="num">${l?.credit ? fmtINR(l.credit) : ''}</td></tr>`).join('')}
      <tr><td><b>Total</b></td><td class="num"><b>${fmtINR(pj.total_debit)}</b></td><td class="num"><b>${fmtINR(pj.total_credit)}</b></td></tr></table>
      <div class="tiny" style="margin-top:8px">balanced: ${pj.balanced ? 'YES ✓' : 'NO'} · idempotency <span class="mono">${esc(str(pj.idempotency_key))}</span></div></div>` : ''}
    ${journal ? `<div class="card"><h3>Journal ${esc(str(journal.journal_number))} — ${esc(str(journal.status))}</h3>
      ${arr(journal.lines).map((l) => `<div class="je-lines">${esc(str(l?.account))} — Dr ${fmtINR(l?.debit)} / Cr ${fmtINR(l?.credit)}</div>`).join('')}</div>` : ''}
    <div class="card"><h3>Evidence (${evidence.length})</h3>
      ${evidence.map((e) => `<div class="enode"><b>${esc(str(e.relationship))}</b>${esc(str(e.label))}<div class="tiny muted">${esc(str(e.summary))}</div></div>`).join('') || '<span class="tiny">No evidence linked.</span>'}</div>
    <div class="card egraph"><h3>Evidence graph</h3>
      ${arr(g.nodes).map((n) => `<div class="enode"><b>${esc(str(n.entity_type))}</b>${esc(str(n.label))}${n.amount != null ? ` · ${fmtINR(n.amount)}` : ''}</div>`).join('') || '<span class="tiny">Graph unavailable.</span>'}</div>
    ${approval && approval.status === 'PENDING' ? `
      <div class="card"><h3>Human decision (acting as ${esc(str(state.user?.role))})</h3>
        <textarea id="dec-note" class="mono" rows="2" style="width:100%;background:var(--panel-2);color:var(--text);border:1px solid var(--border-strong);border-radius:8px;padding:8px;font-size:12px" placeholder="Decision note (recorded in audit trail)"></textarea>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn approve" data-dec="APPROVE">APPROVE</button>
          <button class="btn reject" data-dec="REJECT">REJECT</button>
          <button class="btn" data-dec="MODIFY">MODIFY</button>
          <button class="btn ghost" data-dec="REQUEST_MORE_EVIDENCE">REQUEST EVIDENCE</button>
        </div></div>` : approval ? `<div class="card"><h3>Decision recorded</h3><div class="small">${esc(str(approval.status))} by ${esc(str(approval.decided_by))}${approval.decision_note ? ` — ${esc(str(approval.decision_note))}` : ''}</div></div>` : ''}
  `;
  $$('#drawer-content [data-dec]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const note = $('#dec-note')?.value ?? '';
      const r = await api(`/api/approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', body: JSON.stringify({ decision: b.dataset.dec, note }) });
      toast(str(r.summary, 'Decision recorded'));
      $('#drawer').classList.add('hidden');
      nav(state.page);
    } catch (e) { toast(e.message, true); }
  }));
  $('#drawer').classList.remove('hidden');
}

function safeObj(s) { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { return null; } }

async function renderJournals() {
  let d;
  try { d = await api('/api/journals'); } catch (e) { $('#page').innerHTML = errorCard(e); return; }
  const js = arr(d?.journals);
  $('#page').innerHTML = `<div class="card"><h3>Journal entries (${js.length}) — balanced & idempotent</h3>
    ${js.length ? `<div class="table-wrap"><table><tr><th>#</th><th>Description</th><th>Status</th><th class="num">Total (Dr = Cr)</th><th>Idempotency key</th><th>Lines</th></tr>
    ${js.map((j) => `<tr>
      <td class="mono tiny">${esc(str(j.journal_number))}</td><td class="small">${esc(str(j.description))}</td>
      <td><span class="chip ${str(j.status) === 'POSTED' ? 'ok' : str(j.status) === 'REJECTED' ? 'err' : 'warn'}">${esc(str(j.status))}</span></td>
      <td class="num">${fmtINR(j.total_debit)}</td>
      <td class="mono tiny">${esc(str(j.idempotency_key))}</td>
      <td><div class="je-lines">${arr(j.lines).map((l) => `<div>${esc(str(l?.account))} — Dr ${fmtINR(l?.debit)} / Cr ${fmtINR(l?.credit)}</div>`).join('')}</div></td>
    </tr>`).join('')}</table></div>` : emptyState('≡', 'No journals yet', 'Journals are created and posted as part of the close.')}</div>`;
}

async function renderEvidence() {
  let d;
  try { d = await api('/api/exceptions'); } catch (e) { $('#page').innerHTML = errorCard(e); return; }
  const exc = arr(d?.exceptions).filter((x) => x.demo_case);
  $('#page').innerHTML = `
    <div class="card"><h3>Explore the financial evidence graph</h3><div class="small muted">Vendor → Contract → Purchase Order → Invoice → Payment → Bank Transaction → GL Transaction → Journal Entry → Accounting Policy. Open a case below, or click any exception row on the Exceptions page for its full neighborhood.</div>
    <div class="section-gap" id="ev-buttons" style="margin-top:14px;display:flex;flex-wrap:wrap;gap:8px">${exc.map((x) => `<button class="btn" data-exc="${esc(str(x.id))}">${esc(str(x.code))} · ${esc(str(x.title).slice(0, 44))}</button>`).join('') || '<span class="small muted">Run the close to generate demo-case evidence.</span>'}</div></div>
    <div class="card" id="ev-view"><h3>Pick a case</h3><div class="small muted">The graph neighborhood (2 hops) for the selected case renders here, straight from financial_entities / financial_relationships.</div></div>`;
  $$('#ev-buttons [data-exc]').forEach((b) => b.addEventListener('click', () => openException(b.dataset.exc)));
}

async function renderForecast() {
  let d;
  try { d = await api('/api/forecast'); } catch (e) { $('#page').innerHTML = errorCard(e); return; }
  const assumptions = arr(d?.assumptions);
  $('#page').innerHTML = `
    <div class="grid cols-3">
      <div class="card kpi"><h3>Cash position</h3><div class="kpi-value">${fmtINR(d?.cash_position)}</div><div class="kpi-sub">opening ${fmtINR(d?.cash_start)} · movement ${fmtINR(d?.cash_change)}</div></div>
      <div class="card kpi pos"><h3>Next-month forecast</h3><div class="kpi-value">${fmtINR(d?.forecast_next_month)}</div><div class="kpi-sub">deterministic model — outflow pace + scheduled receipts</div></div>
      <div class="card kpi ${num(d?.risk_score) > 50 ? 'neg' : 'pos'}"><h3>Risk score</h3><div class="kpi-value">${num(d?.risk_score)}/100</div><div class="kpi-sub">from exception severity mix</div></div>
    </div>
    <div class="card"><h3>Assumptions (grounded, disclosed)</h3>${assumptions.map((a) => `<div class="small muted" style="margin-bottom:6px">• ${esc(str(a))}</div>`).join('') || '<span class="tiny">No assumptions recorded.</span>'}</div>`;
}

async function renderAudit() {
  let d;
  try { d = await api('/api/audit'); } catch (e) { $('#page').innerHTML = errorCard(e); return; }
  const p = d?.package;
  if (!p || typeof p !== 'object') { $('#page').innerHTML = `<div class="card">${emptyState('📦', 'No close run yet', 'Generate the audit package by completing a close.')}</div>`; return; }
  const pc = p.close_certification && typeof p.close_certification === 'object' ? p.close_certification : {};
  const cs = p.close_summary && typeof p.close_summary === 'object' ? p.close_summary : {};
  const rr = p.reconciliation_report && typeof p.reconciliation_report === 'object' ? p.reconciliation_report : {};
  const policyChecks = arr(p.policy_checks);
  $('#page').innerHTML = `
    <div class="grid cols-3">
      <div class="card kpi"><h3>Close status</h3><div class="kpi-value">${esc(str(cs.status, '—'))}</div><div class="kpi-sub">${esc(str(cs.title))}</div></div>
      <div class="card kpi"><h3>Evidence index</h3><div class="kpi-value">${arr(p.evidence_index).length}</div><div class="kpi-sub">evidence items linked to conclusions</div></div>
      <div class="card kpi ${pc.certified ? 'pos' : ''}"><h3>Certification</h3><div class="kpi-value">${pc.certified ? 'CERTIFIED' : 'PENDING'}</div><div class="kpi-sub">${pc.certified ? 'close completed under controlled autonomy' : 'complete the close to certify'}</div></div>
    </div>
    <div class="card"><h3>Package contents</h3>
      <div class="table-wrap"><table>
        <tr><th>Section</th><th class="num">Items</th></tr>
        <tr><td>Reconciliation report</td><td class="num">${num(rr.total_matches)} matches</td></tr>
        <tr><td>Exception report</td><td class="num">${arr(p.exception_report).length}</td></tr>
        <tr><td>Journal entries</td><td class="num">${arr(p.journal_entries).length}</td></tr>
        <tr><td>Human approvals</td><td class="num">${arr(p.human_approvals).length}</td></tr>
        <tr><td>Agent decision log</td><td class="num">${arr(p.agent_decision_log).length}</td></tr>
        <tr><td>Evidence index</td><td class="num">${arr(p.evidence_index).length}</td></tr>
        <tr><td>Policy checks</td><td class="num">${policyChecks.length}</td></tr>
      </table></div></div>
    ${policyChecks.length ? `<div class="card"><h3>Policy check results</h3>
      ${policyChecks.slice(0, 14).map((c) => `<div class="small" style="margin-bottom:6px"><span class="chip ${c?.passed ? 'ok' : 'err'}">${c?.passed ? 'PASS' : 'FAIL'}</span> <b>${esc(str(c?.exception_code))}</b> ${esc(str(c?.policy_code))} — <span class="muted">${esc(str(c?.detail).slice(0, 110))}</span></div>`).join('')}</div>` : ''}
    ${pc.statement ? `<div class="card"><h3>Close certification</h3><div class="small">${esc(str(pc.statement))}</div></div>` : ''}
    <div class="card"><h3>Download</h3><a class="btn" href="/api/audit/markdown" download>⬇ audit-package.md</a></div>`;
}

async function renderAgent() {
  let d;
  try { d = await api('/api/agent-activity'); } catch (e) { $('#page').innerHTML = errorCard(e); return; }
  const runs = arr(d?.runs);
  const steps = arr(d?.steps);
  const actions = arr(d?.actions);
  $('#page').innerHTML = `
    <div class="grid cols-2">
      <div class="card"><h3>Agent runs (${runs.length})</h3>
        ${runs.length ? `<div class="table-wrap"><table><tr><th>Agent</th><th>Purpose</th><th>Status</th><th>Started</th></tr>
        ${runs.slice(0, 12).map((r) => `<tr><td><span class="chip run">${esc(str(r.agent))}</span></td><td class="small">${esc(str(r.purpose))}</td><td><span class="chip ${str(r.status) === 'DONE' ? 'ok' : str(r.status) === 'FAILED' ? 'err' : 'warn'}">${esc(str(r.status))}</span></td><td class="tiny muted">${r.started_at ? new Date(r.started_at).toLocaleTimeString() : '—'}</td></tr>`).join('')}
        </table></div>` : emptyState('🤖', 'No agent runs yet', 'Start the close to see the orchestrator work.')}
        </div>
      <div class="card"><h3>Tool calls (typed executor)</h3>
        ${steps.length ? `<div class="table-wrap"><table><tr><th class="num">#</th><th>Kind</th><th>Detail</th><th>Time</th></tr>
        ${steps.slice(0, 18).map((sm) => `<tr><td class="num tiny">${num(sm.step_number)}</td><td><span class="chip">${esc(str(sm.kind))}</span></td><td class="small">${esc(str(sm.title))}<div class="tiny muted">${esc(str(sm.detail).slice(0, 110))}</div></td><td class="tiny muted">${sm.created_at ? new Date(sm.created_at).toLocaleTimeString() : '—'}</td></tr>`).join('')}
        </table></div>` : emptyState('🔧', 'No tool calls yet', 'The orchestrator records every typed tool execution.')}
        </div>
    </div>
    <div class="card"><h3>Decision log (${actions.length})</h3>
      ${actions.length ? `<div class="table-wrap"><table><tr><th>Time</th><th>Agent</th><th>Action</th><th>Input</th><th>Output</th><th class="num">Conf</th></tr>
      ${actions.slice(0, 24).map((a) => `<tr><td class="tiny muted">${a.created_at ? new Date(a.created_at).toLocaleTimeString() : '—'}</td><td><span class="chip run">${esc(str(a.agent))}</span></td><td class="mono tiny">${esc(str(a.action))}</td><td class="small">${esc(str(a.input_summary).slice(0, 80))}</td><td class="small">${esc(str(a.output_summary).slice(0, 90))}</td><td class="num tiny">${a.confidence != null ? num(a.confidence).toFixed(0) + '%' : '—'}</td></tr>`).join('')}
      </table></div>` : emptyState('📋', 'No decisions yet', 'Agent decisions persist here with confidence and evidence.')}</div>`;
}

async function renderPolicies() {
  let d;
  try { d = await api('/api/policies'); } catch (e) { $('#page').innerHTML = errorCard(e); return; }
  const pols = arr(d?.policies);
  const editable = state.user?.role === 'CFO';
  $('#page').innerHTML = `<div class="card"><h3>Accounting policies (${pols.length}) — configurable autonomy thresholds ${editable ? '' : '(read-only: CFO role required to edit)'}</h3>
    ${pols.length ? `<div class="table-wrap"><table><tr><th>Code</th><th>Name</th><th>Category</th><th>Parameters</th><th>Active</th>${editable ? '<th>Edit</th>' : ''}</tr>
    ${pols.map((p) => `<tr>
      <td class="mono tiny">${esc(str(p.code))}</td><td class="small">${esc(str(p.name))}<div class="tiny muted">${esc(str(p.description))}</div></td>
      <td><span class="chip">${esc(str(p.category))}</span></td>
      <td class="mono tiny">${esc(JSON.stringify(p.parameters ?? {}))}</td>
      <td><span class="chip ${p.active ? 'ok' : 'err'}">${p.active ? 'ACTIVE' : 'OFF'}</span></td>
      ${editable ? `<td><button class="btn ghost" data-edit="${esc(str(p.code))}">edit</button></td>` : ''}
    </tr>`).join('')}</table></div>` : emptyState('§', 'No policies loaded', 'Policies seed from data/policies/demo_policies.yaml.')}</div>`;
  if (editable) {
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const p = pols.find((x) => x.code === b.dataset.edit);
      if (!p) return;
      const raw = prompt(`Parameters JSON for ${p.code}:`, JSON.stringify(p.parameters ?? {}, null, 2));
      if (!raw) return;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { toast('Invalid JSON', true); return; }
      api(`/api/policies/${encodeURIComponent(p.code)}`, { method: 'PATCH', body: JSON.stringify({ parameters: parsed }) })
        .then(() => { toast('Policy updated'); renderPolicies(); })
        .catch((e) => toast(e.message, true));
    }));
  }
}

async function renderSettings() {
  let d;
  try { d = await loadState(); } catch (e) { $('#page').innerHTML = errorCard(e); return; }
  $('#page').innerHTML = `
    <div class="grid cols-2">
      <div class="card"><h3>Environment</h3>
        <table>
          <tr><td>Organization</td><td>${esc(str(d?.org?.name))}</td></tr>
          <tr><td>Currency</td><td>${esc(str(d?.org?.currency))}</td></tr>
          <tr><td>Data</td><td><span class="chip warn">SYNTHETIC — seed 2026</span></td></tr>
          <tr><td>Decision core</td><td class="small muted">deterministic (policy + risk + materiality engines)</td></tr>
          <tr><td>Connector</td><td class="small muted">synthetic bank/ERP — no external credentials</td></tr>
        </table></div>
      <div class="card"><h3>RBAC — demo roles</h3>
        <div class="table-wrap"><table><tr><th>Role</th><th>User</th><th>Can do</th></tr>
        <tr><td><span class="chip run">CFO</span></td><td>Priya Menon</td><td class="tiny muted">everything incl. policy edits, reset</td></tr>
        <tr><td><span class="chip run">CONTROLLER</span></td><td>Rahul Verma</td><td class="tiny muted">approvals, close start, reset</td></tr>
        <tr><td><span class="chip">ACCOUNTANT</span></td><td>Sneha Iyer</td><td class="tiny muted">start close, request evidence</td></tr>
        <tr><td><span class="chip">AUDITOR</span></td><td>Karan Rao</td><td class="tiny muted">read-only, incl. audit package</td></tr>
        </table></div>
        <div class="tiny section-gap" style="margin-top:12px">Switch roles in the sidebar. Write actions are enforced server-side (RBAC) and every decision lands in audit_events.</div></div>
    </div>
    <div class="card"><h3>Demo controls</h3>
      <div class="small muted" style="margin-bottom:12px">Reset restores the exact deterministic initial state (FINPILOT_DEMO_SEED=2026): 500 bank rows, 500 ledger rows, 100 invoices, designed anomalies and all demo cases.</div>
      <button id="btn-reset-2" class="btn ghost">↺ Reset Demo</button></div>`;
  $('#btn-reset-2')?.addEventListener('click', resetDemo);
}

async function renderAO() {
  let d;
  try { d = await api('/api/ao'); } catch (e) { $('#page').innerHTML = errorCard(e); return; }
  $('#page').innerHTML = `<div class="card"><h3>Build With AO — actual development evidence</h3>
    <div class="tiny" style="margin-bottom:12px">${esc(str(d?.note))}</div><pre class="doc">${esc(str(d?.content))}</pre></div>`;
}

/* ---------------- copilot ---------------- */
function copilotMsg(cls, html) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.innerHTML = html;
  $('#copilot-log').appendChild(div);
  $('#copilot-log').scrollTop = 1e9;
  return div;
}

async function askCopilot(q) {
  copilotMsg('user', esc(q));
  const thinking = copilotMsg('agent', '<span class="muted">Analyzing close data…</span>');
  try {
    const a = await api('/api/copilot', { method: 'POST', body: JSON.stringify({ question: q }) });
    const facts = arr(a?.facts);
    thinking.innerHTML = `${esc(str(a?.answer, 'No answer.'))}<div class="facts">${facts.map((f) => `<div><span>${esc(str(f?.label))}</span><b>${esc(str(f?.value))}</b></div>`).join('')}${facts.length ? `<div class="tiny" style="margin-top:4px">sources: ${[...new Set(facts.map((f) => str(f?.source)))].filter(Boolean).join(', ')}</div>` : ''}</div>`;
  } catch (e) {
    thinking.innerHTML = `<span style="color:var(--err)">${esc(e.message)}</span>`;
  }
}

/* ---------------- wiring ---------------- */
function resetDemo() {
  return api('/api/demo/reset', { method: 'POST', body: '{}' })
    .then(() => { toast('Demo reset — deterministic initial state restored (seed 2026)'); nav(state.page); })
    .catch((e) => toast(e.message, true));
}

$('#nav').addEventListener('click', (e) => { const a = e.target.closest('a'); if (a) nav(a.dataset.page); });
$('#drawer-close').addEventListener('click', () => $('#drawer').classList.add('hidden'));
$('.drawer-backdrop').addEventListener('click', () => $('#drawer').classList.add('hidden'));
$('#copilot-fab').addEventListener('click', () => $('#copilot').classList.toggle('hidden'));
$('#copilot-close').addEventListener('click', () => $('#copilot').classList.add('hidden'));
$('#copilot-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#copilot-input').value.trim();
  if (v) { askCopilot(v); $('#copilot-input').value = ''; }
});
document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); nav(g.dataset.goto); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#drawer').classList.add('hidden'); $('#copilot').classList.add('hidden'); } });

$('#btn-start').addEventListener('click', async () => {
  try {
    await loadState();
    const r = await api('/api/close/start', { method: 'POST', body: '{}' });
    toast(`Close ${str(r.status).toLowerCase()} — orchestrator running`);
    nav('close');
    pollUntilSettled();
  } catch (e) { toast(e.message, true); }
});
$('#btn-reset').addEventListener('click', resetDemo);

let pollTimer = null;
function pollUntilSettled() {
  clearInterval(pollTimer);
  let ticks = 0;
  pollTimer = setInterval(async () => {
    ticks += 1;
    await loadState().catch(() => {});
    if (state.page === 'overview' || state.page === 'close') nav(state.page);
    const settled = !state.run || ['COMPLETED', 'FAILED', 'AWAITING_HUMAN'].includes(str(state.run.status));
    if (settled || ticks > 60) {
      clearInterval(pollTimer);
      if (state.run?.status === 'AWAITING_HUMAN') {
        toast('⏸ Workflow paused — human approval required (Exceptions page)');
        nav('exceptions');
      }
    }
  }, 1500);
}

async function init() {
  const u = await api('/api/users');
  state.users = arr(u?.users);
  state.user = state.users[0] ?? null;
  $('#role-select').innerHTML = state.users.map((x) => `<option value="${esc(str(x.email))}">${esc(str(x.role))} — ${esc(str(x.name))}</option>`).join('');
  $('#role-select').addEventListener('change', (e) => {
    state.user = state.users.find((x) => x.email === e.target.value);
    toast(`Acting as ${str(state.user?.role)} — ${str(state.user?.name)}`);
    nav(state.page);
  });
  await loadState().catch(() => {});
  nav('overview');
  try {
    state.es = new EventSource('/api/events');
    state.es.addEventListener('progress', () => { loadState().catch(() => {}); });
    state.es.addEventListener('state', () => { if (state.page === 'overview' || state.page === 'close') nav(state.page); });
  } catch { /* polling fallback covers it */ }
  if (state.run && ['PLANNED', 'RUNNING', 'COMPLETING'].includes(str(state.run.status))) pollUntilSettled();
}

init().catch((e) => { $('#page').innerHTML = errorCard(e); });
