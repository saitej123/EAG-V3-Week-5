/* JEE-Solver frontend
 * SSE consumer, timeline renderer, clipboard paste for images,
 * copy answer button, live loguru log panel.
 */

const $ = (s) => document.querySelector(s);

const els = {
  question:      $('#question'),
  imageFile:     $('#image-file'),
  imageLabel:    $('#image-label'),
  pastePreview:  $('#paste-preview'),
  previewImg:    $('#preview-img'),
  previewName:   $('#preview-name'),
  previewRemove: $('#preview-remove'),
  pasteImageBtn: $('#paste-image-btn'),
  solveBtn:      $('#solve-btn'),
  clearBtn:      $('#clear-btn'),
  solveLabel:    $('#solve-label'),
  solveSpinner:  $('#solve-spinner'),
  timeline:      $('#timeline'),
  timelineMeta:  $('#timeline-meta'),
  logs:          $('#logs'),
  logsToggle:    $('#logs-toggle'),
  logsClear:     $('#logs-clear'),
  statusBadge:   $('#status-badge'),
  healthDot:     $('#health-dot'),
  healthText:    $('#health-text'),
  topBar:        $('#top-bar'),
  emptyState:    $('#empty-state'),
  inputZone:     $('#input-zone'),
};

let pickedImage = null;
let activeShimmer = null;
let stepCount = 0;
let startedAt = 0;

const IMAGE_MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/* ---- helpers ---- */

const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function renderMath(node) {
  if (!window.renderMathInElement) return;
  try {
    renderMathInElement(node, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true },
      ],
      throwOnError: false,
    });
  } catch (_) {}
}

function setStatus(text, kind) {
  els.statusBadge.textContent = text;
  els.statusBadge.className =
    'shrink-0 inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold tracking-wide status-' + kind;
}

function setBusy(b) {
  els.solveBtn.disabled = b;
  els.solveLabel.classList.toggle('hidden', b);
  els.solveSpinner.classList.toggle('hidden', !b);
  els.topBar.classList.toggle('hidden', !b);
}

/* ---- image handling (file + clipboard paste + drag) ---- */

function setImage(b64, mime, name) {
  pickedImage = { b64, mime, name };
  els.previewImg.src = `data:${mime};base64,${b64}`;
  els.previewName.textContent = name;
  els.pastePreview.classList.remove('is-hidden');
  els.pastePreview.style.display = 'flex';
  els.imageLabel.textContent = name;
  pushLog({ level: 'SUCCESS', name: 'ui', msg: `image attached (${mime}, ${Math.round((b64.length * 3 / 4) / 1024)} KB)` });
}

function clearImage() {
  pickedImage = null;
  els.imageFile.value = '';
  els.imageLabel.textContent = 'Upload image';
  els.previewImg.removeAttribute('src');
  els.pastePreview.classList.add('is-hidden');
  els.pastePreview.style.display = 'none';
}

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',', 2)[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error || new Error('failed to read file'));
    reader.readAsDataURL(file);
  });
}

async function handleImageFile(file) {
  const inferredMime = inferImageMime(file);
  if (!file || !inferredMime) {
    pushLog({ level: 'WARNING', name: 'ui', msg: 'clipboard/drop did not contain an image' });
    return false;
  }
  if (file.size > 8 * 1024 * 1024) {
    pushLog({ level: 'ERROR', name: 'ui', msg: 'Image too large (>8 MB)' });
    return false;
  }
  try {
    const b64 = await fileToB64(file);
    setImage(b64, inferredMime, file.name || `pasted-image.${inferredMime.split('/')[1] || 'png'}`);
    return true;
  } catch (e) {
    pushLog({ level: 'ERROR', name: 'ui', msg: `could not read image: ${e?.message || e}` });
    return false;
  }
}

function inferImageMime(file) {
  const type = (file?.type || '').toLowerCase();
  if (type === 'image/jpg') return 'image/jpeg';
  if (type.startsWith('image/')) return type;

  const ext = String(file?.name || '').split('.').pop()?.toLowerCase();
  return ext ? IMAGE_MIME_BY_EXT[ext] || '' : '';
}

function setImageFromDataUrl(dataUrl, name = 'pasted-image') {
  const match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  if (!match) return false;
  setImage(match[2], match[1], name);
  return true;
}

function findDataUrlInText(text) {
  const match = String(text || '').match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/);
  return match?.[0] || null;
}

async function handleClipboardData(clipboardData) {
  if (!clipboardData) return false;

  // Some browsers expose pasted files here (screenshots, copied files).
  for (const file of Array.from(clipboardData.files || [])) {
    if (inferImageMime(file) && await handleImageFile(file)) return true;
  }

  // Standard screenshot paste path.
  for (const item of Array.from(clipboardData.items || [])) {
    if (item.type?.startsWith('image/')) {
      const file = item.getAsFile();
      if (file && await handleImageFile(file)) return true;
    }
  }

  // Data URL pasted as text or embedded in copied HTML.
  const plain = clipboardData.getData?.('text/plain');
  const html = clipboardData.getData?.('text/html');
  const dataUrl = findDataUrlInText(plain) || findDataUrlInText(html);
  if (dataUrl) return setImageFromDataUrl(dataUrl, 'pasted-data-url');

  return false;
}

/* ---- timeline ---- */

function clearTimeline() {
  els.timeline.innerHTML = '';
  els.timelineMeta.textContent = '';
  stepCount = 0;
  removeShimmer();
}

function clearAll() {
  clearTimeline();
  els.logs.innerHTML = '';
  setStatus('idle', 'idle');
  showEmptyState();
}

function showEmptyState() {
  if ($('#empty-state')) return;
  const div = document.createElement('div');
  div.id = 'empty-state';
  div.className = 'relative grid place-items-center text-center text-sm text-gray-400 py-14 rounded-xl border-2 border-dashed border-gray-200 bg-gray-50/50';
  div.innerHTML = `<div>
    <svg viewBox="0 0 24 24" class="w-8 h-8 mx-auto mb-3 text-gray-300" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
    </svg>Submit a problem to see reasoning unfold</div>`;
  els.timeline.appendChild(div);
}

function removeEmptyState() {
  const e = $('#empty-state');
  if (e) e.remove();
}

function showShimmer(label) {
  removeShimmer();
  const d = document.createElement('div');
  d.className = 'shimmer-card';
  d.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px;color:#9ca3af;">
      <span class="dot-pulse"></span><span id="shimmer-label">${esc(label || 'thinking…')}</span>
    </div>
    <div id="shimmer-lines">
      <div class="shimmer-line" style="width:75%"></div>
      <div class="shimmer-line" style="width:50%;margin-top:8px"></div>
      <div class="shimmer-line" style="width:65%;margin-top:8px"></div>
    </div>
    <pre id="live-stream-box" class="live-stream-box hidden"></pre>`;
  els.timeline.appendChild(d);
  activeShimmer = d;
}

function removeShimmer() {
  if (activeShimmer) { activeShimmer.remove(); activeShimmer = null; }
}

function updateMeta() {
  const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
  els.timelineMeta.textContent = `${stepCount} steps · ${elapsed}s`;
}

function appendStep(stage, payload) {
  removeEmptyState();
  removeShimmer();

  const card = document.createElement('div');
  card.className = 'step-card';
  card.dataset.stage = stage;

  const titles = { parse: '1 · Parse', plan: '2 · Plan', solve: '3 · Solve', verify: '4 · Verify', final: '5 · Final Answer' };
  const title = titles[stage] || stage;
  let body = '';

  if (stage === 'parse') {
    const topic = payload.topic ? `<span class="step-tag">${esc(payload.topic)}</span>` : '';
    body = `
      <div class="step-header"><span class="step-title">${title}</span>${topic}</div>
      <div class="step-body">${esc(payload.restated || '')}</div>
      <dl class="kv">
        <dt>Given</dt><dd>${(payload.given||[]).map(esc).join('; ')||'—'}</dd>
        <dt>Unknown</dt><dd>${(payload.unknown||[]).map(esc).join('; ')||'—'}</dd>
        <dt>Constraints</dt><dd>${(payload.constraints||[]).map(esc).join('; ')||'—'}</dd>
      </dl>`;
  } else if (stage === 'plan') {
    body = `
      <div class="step-header"><span class="step-title">${title}</span><span class="step-tag">${esc(payload.reasoning_type||'logic')}</span></div>
      <div class="step-body">${esc(payload.approach||'')}</div>
      <dl class="kv"><dt>Tools</dt><dd>${(payload.tools||[]).map(esc).join(' · ')||'—'}</dd></dl>`;
  } else if (stage === 'solve') {
    body = `
      <div class="step-header"><span class="step-title">${title} · step ${payload.n??''}</span><span class="step-tag">${esc(payload.reasoning_type||'')}</span></div>
      <div class="step-body"><strong>${esc(payload.action||'')}</strong></div>
      ${payload.math ? `<div class="step-math">${esc(payload.math)}</div>` : ''}
      ${payload.result ? `<dl class="kv"><dt>Result</dt><dd>${esc(payload.result)}</dd></dl>` : ''}`;
  } else if (stage === 'verify') {
    const ok = payload.passed, cls = ok ? 'badge-ok' : 'badge-error';
    body = `
      <div class="step-header"><span class="step-title">${title}</span><span class="${cls}">${ok?'passed':'failed'}</span></div>
      <div class="step-body">${esc(payload.method||'')}</div>
      ${payload.details ? `<dl class="kv"><dt>Details</dt><dd>${esc(payload.details)}</dd></dl>` : ''}`;
  } else if (stage === 'final') {
    body = `
      <div class="step-header">
        <span class="step-title">${title}</span>
        <span class="step-tag">confidence ${(payload.confidence??0).toFixed(2)}</span>
      </div>
      <div class="final-answer">${esc(payload.answer||'')}</div>
      <div class="step-body" style="color:#6b7280">${esc(payload.summary||'')}</div>
      <button class="copy-answer" title="Copy answer" data-answer="${esc(payload.answer||'')}">
        <svg viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.12A1.5 1.5 0 0117 6.622V12.5a1.5 1.5 0 01-1.5 1.5h-1v-3.379a3 3 0 00-.879-2.121L10.5 5.379A3 3 0 008.379 4.5H7v-1z"/><path d="M4.5 6A1.5 1.5 0 003 7.5v9A1.5 1.5 0 004.5 18h7a1.5 1.5 0 001.5-1.5v-5.879a1.5 1.5 0 00-.44-1.06L9.44 6.439A1.5 1.5 0 008.378 6H4.5z"/></svg>
        <span>Copy</span>
      </button>`;
  }

  card.innerHTML = body;
  els.timeline.appendChild(card);
  renderMath(card);

  const copyBtn = card.querySelector('.copy-answer');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(copyBtn.dataset.answer).then(() => {
        copyBtn.querySelector('span').textContent = 'Copied!';
        setTimeout(() => { copyBtn.querySelector('span').textContent = 'Copy'; }, 1500);
      });
    });
  }

  stepCount++;
  updateMeta();
}

/* ---- logs ---- */

function pushLog(entry) {
  const lv   = (entry?.level || 'INFO').toUpperCase();
  const time = entry?.time  || new Date().toLocaleTimeString('en', {hour12:false}).slice(0,8);
  const name = entry?.name  || '';
  const msg  = entry?.msg   || entry?.message || '';

  const row = document.createElement('div');
  row.className = `log-row l-${lv}`;
  row.innerHTML = `
    <span class="log-time">${esc(time)}</span>
    <span class="log-level">${esc(lv)}</span>
    <span class="log-msg">${esc(msg)}</span>`;
  els.logs.appendChild(row);
  els.logs.scrollTop = els.logs.scrollHeight;
}

/* ---- SSE ---- */

async function streamSolve(req) {
  const resp = await fetch('/api/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${text || resp.statusText}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try { handleEvent(JSON.parse(line.slice(5).trim())); } catch {}
    }
  }
}

function handleEvent(ev) {
  if (ev.type === 'log') {
    pushLog(ev.payload && Object.keys(ev.payload).length ? ev.payload : { msg: ev.message });
  } else if (ev.type === 'stream_chunk') {
    const box = document.getElementById('live-stream-box');
    const lines = document.getElementById('shimmer-lines');
    if (box) {
      if (box.classList.contains('hidden')) {
        box.classList.remove('hidden');
        if (lines) lines.style.display = 'none';
        const lbl = document.getElementById('shimmer-label');
        if (lbl) lbl.textContent = 'receiving raw JSON stream…';
      }
      box.textContent += ev.message;
      box.scrollTop = box.scrollHeight;
    }
  } else if (ev.type === 'stage') {
    if (ev.payload && Object.keys(ev.payload).length) appendStep(ev.stage, ev.payload);
    else if (ev.message) showShimmer(ev.message);
  } else if (ev.type === 'heartbeat') {
    updateMeta();
    if (!activeShimmer) showShimmer(`thinking · ${ev.payload?.elapsed_s ?? '?'}s`);
  } else if (ev.type === 'result') {
    appendStep('final', ev.payload.final || {});
    if (ev.payload.fallback) pushLog({ level: 'WARNING', name: 'solver', msg: `fallback: ${ev.payload.fallback}` });
    setStatus(ev.payload.status === 'ok' ? 'done' : ev.payload.status, ev.payload.status === 'ok' ? 'ok' : 'error');
  } else if (ev.type === 'error') {
    removeShimmer();
    pushLog({ level: 'ERROR', name: 'solver', msg: ev.message || 'error' });
    setStatus('error', 'error');
  } else if (ev.type === 'done') {
    setBusy(false);
    updateMeta();
  }
}

/* ---- wiring ---- */

async function onSolve() {
  const q = els.question.value.trim();
  if (!q && !pickedImage) {
    pushLog({ level: 'WARNING', name: 'ui', msg: 'Enter text or paste an image first' });
    return;
  }
  clearTimeline();
  setBusy(true);
  setStatus('solving', 'running');
  startedAt = performance.now();
  pushLog({ level: 'INFO', name: 'ui', msg: 'submitting…' });
  try {
    await streamSolve({
      question: q,
      image_b64: pickedImage?.b64 || null,
      image_mime: pickedImage?.mime || null,
      image_name: pickedImage?.name || null,
    });
  } catch (e) {
    pushLog({ level: 'ERROR', name: 'ui', msg: String(e?.message || e) });
    setStatus('error', 'error');
  } finally {
    setBusy(false);
  }
}

function init() {
  els.solveBtn.addEventListener('click', onSolve);
  els.clearBtn.addEventListener('click', () => { els.question.value = ''; clearImage(); clearAll(); });
  els.previewRemove.addEventListener('click', clearImage);
  els.imageFile.addEventListener('change', (ev) => {
    const f = ev.target.files?.[0];
    if (f) handleImageFile(f);
  });
  els.pasteImageBtn.addEventListener('click', async () => {
    if (!navigator.clipboard?.read) {
      pushLog({ level: 'WARNING', name: 'ui', msg: 'Browser does not support clipboard image read. Use Ctrl+V or upload instead.' });
      els.question.focus();
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith('image/'));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        const file = new File([blob], `clipboard.${imageType.split('/')[1] || 'png'}`, { type: imageType });
        if (await handleImageFile(file)) return;
      }
      pushLog({ level: 'WARNING', name: 'ui', msg: 'Clipboard has no image. Try copying a screenshot first.' });
    } catch (e) {
      pushLog({ level: 'WARNING', name: 'ui', msg: `Clipboard read blocked: ${e?.message || e}. Use Ctrl+V or upload instead.` });
      els.question.focus();
    }
  });

  // Ctrl+Enter to solve
  els.question.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') onSolve();
  });

  // Clipboard paste for images (works anywhere on page)
  document.addEventListener('paste', async (e) => {
    const handled = await handleClipboardData(e.clipboardData);
    if (handled) {
      e.preventDefault();
      return;
    }
    // Text paste falls through to default behavior (textarea handles it).
  });

  // Drag & drop on input zone
  els.inputZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.inputZone.classList.add('drop-active');
  });
  els.inputZone.addEventListener('dragleave', () => {
    els.inputZone.classList.remove('drop-active');
  });
  els.inputZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    els.inputZone.classList.remove('drop-active');
    for (const file of (e.dataTransfer?.files || [])) {
      if (inferImageMime(file)) { await handleImageFile(file); return; }
    }
    pushLog({ level: 'WARNING', name: 'ui', msg: 'Dropped item was not an image' });
  });

  // Logs toggle / clear
  els.logsToggle.addEventListener('click', () => {
    const collapsed = els.logs.classList.toggle('collapsed');
    els.logsToggle.textContent = collapsed ? 'expand' : 'collapse';
  });
  els.logsClear.addEventListener('click', () => { els.logs.innerHTML = ''; });

  // Example chips
  document.querySelectorAll('.chip').forEach((b) => {
    b.addEventListener('click', () => { els.question.value = b.dataset.q; els.question.focus(); });
  });

  // Health check
  fetch('/healthz').then(r => r.json()).then(j => {
    const ok = j.api_key_loaded;
    els.healthDot.style.background = ok ? '#22c55e' : '#f59e0b';
    els.healthText.textContent = ok ? `ready · ${j.model}` : 'no API key';
  }).catch(() => {
    els.healthDot.style.background = '#ef4444';
    els.healthText.textContent = 'offline';
  });
}

init();

/* ---- prompt qualification drawer ---- */
const qualBtn = document.getElementById('qual-btn');
const qualDrawer = document.getElementById('qual-drawer');
const qualOverlay = document.getElementById('qual-overlay');
const qualClose = document.getElementById('qual-close');

if (qualBtn && qualDrawer && qualOverlay && qualClose) {
  const openDrawer = () => {
    qualDrawer.classList.add('open');
    qualOverlay.classList.add('open');
  };
  const closeDrawer = () => {
    qualDrawer.classList.remove('open');
    qualOverlay.classList.remove('open');
  };

  qualBtn.addEventListener('click', openDrawer);
  qualClose.addEventListener('click', closeDrawer);
  qualOverlay.addEventListener('click', closeDrawer);
}
