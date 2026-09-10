// ─── Suggestion data ──────────────────────────────────────────────────────────
const X_SUGGESTIONS = [
  "organizing community action",
  "reducing personal carbon footprint",
  "teaching digital literacy",
  "building mutual aid networks",
  "running for local office",
  "funding grassroots organizations",
  "practicing nonviolent protest",
  "starting worker cooperatives",
  "conducting independent journalism",
  "developing open source software",
  "training the next generation",
  "bridging political divides",
  "boycotting harmful companies",
  "creating inclusive art",
  "reducing meat consumption",
  "supporting local businesses",
  "mentoring young people",
  "building accessible technology",
  "practicing restorative justice",
  "sharing knowledge openly",
  "lobbying elected officials",
  "striking and collective bargaining",
  "filing strategic lawsuits",
  "building alternative institutions",
  "growing your own food",
  "divesting from fossil fuels",
  "documenting injustice",
  "practicing civil disobedience",
  "creating free educational content",
  "starting a social enterprise",
];

const Y_SUGGESTIONS = [
  "climate stability",
  "economic equality",
  "racial justice",
  "democratic participation",
  "mental health improvement",
  "education access for all",
  "end of extreme poverty",
  "gender equality",
  "peace and conflict reduction",
  "clean water access",
  "food security",
  "LGBTQ+ rights",
  "criminal justice reform",
  "housing stability",
  "healthcare for all",
  "freedom of information",
  "animal welfare",
  "immigrant rights",
  "disability inclusion",
  "political accountability",
  "corporate accountability",
  "press freedom",
  "indigenous sovereignty",
  "drug policy reform",
  "child welfare",
  "worker rights",
  "biodiversity preservation",
  "digital privacy",
  "community resilience",
  "reduced political polarization",
];

// ─── Autocomplete ─────────────────────────────────────────────────────────────
function setupAutocomplete(inputEl, sugEl, data) {
  let activeIdx = -1;

  function filter(q) {
    if (!q.trim()) return data.slice(0, 8);
    const lq = q.toLowerCase();
    return data.filter(s => s.toLowerCase().includes(lq)).slice(0, 8);
  }

  function render(items, q) {
    sugEl.innerHTML = '';
    activeIdx = -1;
    if (!items.length) { sugEl.classList.remove('open'); return; }
    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.innerHTML = highlight(item, q);
      li.addEventListener('mousedown', e => { e.preventDefault(); pick(item); });
      sugEl.appendChild(li);
    });
    sugEl.classList.add('open');
  }

  function highlight(text, q) {
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return text;
    return text.slice(0, idx) + '<mark>' + text.slice(idx, idx + q.length) + '</mark>' + text.slice(idx + q.length);
  }

  function pick(value) {
    setFieldValue(inputEl, value);
    updateField(inputEl);
    sugEl.classList.remove('open');
    checkReady();
  }

  function close() { sugEl.classList.remove('open'); activeIdx = -1; }

  inputEl.addEventListener('input', () => {
    updateField(inputEl);
    const v = fieldValue(inputEl);
    const items = filter(v);
    render(items, v);
    checkReady();
  });

  inputEl.addEventListener('focus', () => {
    updateField(inputEl);
    const v = fieldValue(inputEl);
    const items = filter(v);
    if (items.length) render(items, v);
  });

  inputEl.addEventListener('blur', () => setTimeout(close, 150));

  inputEl.addEventListener('keydown', e => {
    const items = sugEl.querySelectorAll('li');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      items.forEach((li, i) => li.classList.toggle('active', i === activeIdx));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, -1);
      items.forEach((li, i) => li.classList.toggle('active', i === activeIdx));
    } else if (e.key === 'Enter') {
      if (activeIdx >= 0 && items[activeIdx]) {
        e.preventDefault();
        pick(items[activeIdx].textContent);
      }
    } else if (e.key === 'Escape') {
      close();
    }
  });
}

// Contenteditable helpers — keep an .value-like API to minimise downstream churn.
function fieldValue(el) {
  return (el.textContent || '').replace(/​/g, ''); // strip zero-width if any
}
function setFieldValue(el, v) {
  el.textContent = v || '';
}

function updateField(el) {
  const text = fieldValue(el);
  const len  = text.length;

  // Step-down font size for long inputs so users see their full text wrapped
  // onto a couple of lines instead of truncated.
  let fontScale = '';
  if (len > 40)      fontScale = '0.55em';
  else if (len > 25) fontScale = '0.7em';
  else if (len > 15) fontScale = '0.85em';
  el.style.fontSize = fontScale;

  const wrap = el.parentElement;
  // Dropdown width matches the wrap after layout settles.
  const sug = wrap.querySelector('.suggestions');
  if (sug) requestAnimationFrame(() => { sug.style.width = wrap.offsetWidth + 'px'; });

  wrap.classList.toggle('typing', text.length > 0);
}

const fieldX = document.getElementById('field-x');
const fieldY = document.getElementById('field-y');
const sugX   = document.getElementById('sug-x');
const sugY   = document.getElementById('sug-y');
const btn    = document.getElementById('analyze-btn');

setupAutocomplete(fieldX, sugX, X_SUGGESTIONS);
setupAutocomplete(fieldY, sugY, Y_SUGGESTIONS);
updateField(fieldX); updateField(fieldY);

// Clicking anywhere in the wrap (including the placeholder "action"/"change"
// word) focuses the contenteditable — replaces what <label for=…> used to do.
[fieldX, fieldY].forEach(f => {
  f.parentElement.addEventListener('click', e => {
    if (e.target !== f) {
      e.preventDefault();
      f.focus();
      // Place caret at end
      const range = document.createRange();
      range.selectNodeContents(f);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
});

// Insert blinking cursor spans before each field, shown when focused and empty
[fieldX, fieldY].forEach(f => {
  const cursor = document.createElement('span');
  cursor.className = 'blink-cursor';
  f.parentElement.insertBefore(cursor, f);
  f.addEventListener('focus', () => f.parentElement.classList.add('focused'));
  f.addEventListener('blur',  () => f.parentElement.classList.remove('focused'));
});

function checkReady() {
  btn.disabled = !fieldValue(fieldX).trim() || !fieldValue(fieldY).trim();
}

fieldX.addEventListener('input', checkReady);
fieldY.addEventListener('input', checkReady);


// ─── Strength colours ─────────────────────────────────────────────────────────
function strengthColor(label) {
  return { Strong: '#16A34A', Moderate: '#D97706', Weak: '#DC2626', Speculative: '#9CA3AF' }[label] || '#9CA3AF';
}

// ─── SVG text word-wrap ───────────────────────────────────────────────────────
function svgLines(text, charsPerLine) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > charsPerLine && line) {
      lines.push(line);
      line = w;
    } else {
      line = (line + ' ' + w).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

function svgWrappedText(text, x, cy, cls, charsPerLine = 16) {
  const lines = svgLines(text, charsPerLine);
  const lineH = 16;
  const totalH = lines.length * lineH;
  const startY = cy - totalH / 2 + lineH * 0.8;
  return lines.map((l, i) =>
    `<text x="${x}" y="${startY + i * lineH}" text-anchor="middle" class="${cls}">${escapeHtml(l)}</text>`
  ).join('\n');
}

// ─── SVG Diagram ──────────────────────────────────────────────────────────────
function buildDiagram(action, change, strength, label, vertical = false) {
  const color = strengthColor(label);
  const strokeW = Math.max(2.5, Math.round((strength / 100) * 14));
  const opacity = 0.4 + (strength / 100) * 0.55;     // 0.4 → 0.95
  const dash = label === 'Strong'   ? 'none'
             : label === 'Moderate' ? '14 4'
             : label === 'Weak'     ? '8 6'
             :                        '4 8';          // Speculative

  if (vertical) {
    const nw = 220, nh = 110;
    const W = 260, H = 510;
    const cx = W / 2;
    const topY = 20, botY = H - nh - 20;
    const arrowStartY = topY + nh + 8;
    const arrowEndY = botY - 8;
    const vStrokeW = strokeW * 1.5;
    const headH = Math.max(12, vStrokeW * 1.4);
    const headW = Math.max(10, vStrokeW * 1.2);
    const tipY = arrowEndY + 2;
    const baseY = tipY - headH;

    return `<svg class="diagram-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif">
  <!-- Action node -->
  <rect x="${cx - nw/2}" y="${topY}" width="${nw}" height="${nh}" rx="12" class="node-x"/>
  <text x="${cx}" y="${topY + 22}" text-anchor="middle" class="node-label">ACTION</text>
  ${svgWrappedText(action, cx, topY + 56, 'node-text-x', 20)}

  <!-- Change node -->
  <rect x="${cx - nw/2}" y="${botY}" width="${nw}" height="${nh}" rx="12" class="node-y"/>
  <text x="${cx}" y="${botY + 22}" text-anchor="middle" class="node-label">CHANGE</text>
  ${svgWrappedText(change, cx, botY + 56, 'node-text-y', 20)}

  <!-- Connection: vertical arrow -->
  <line
    x1="${cx}" y1="${arrowStartY}"
    x2="${cx}" y2="${baseY}"
    stroke="${color}" stroke-width="${vStrokeW}"
    stroke-dasharray="${dash}"
    stroke-linecap="butt"
    opacity="${opacity}"
  />
  <polygon
    points="${cx - headW/2},${baseY} ${cx + headW/2},${baseY} ${cx},${tipY}"
    fill="${color}" opacity="${opacity}"
  />
</svg>`;
  }

  const nw = 180;
  const pad = 60;
  const W = 640, H = 160;
  const lx = pad, rx = W - nw - pad;
  const cy = H / 2;
  const startX = lx + nw + 8;
  const endX = rx - 8;

  // Arrowhead drawn as a sibling polygon (not a stroke-scaled marker) so its
  // size is predictable. Line ends exactly at the arrowhead's base with butt
  // linecap, so each dash terminates flush against the triangle — like a
  // hand-drawn arrow where the dashes stop when they hit the head.
  const headW = Math.max(12, strokeW * 1.4);
  const headH = Math.max(10, strokeW * 1.2);
  const tipX = endX - 2;
  const baseX = tipX - headW;

  return `<svg class="diagram-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif">
  <!-- Action node -->
  <rect x="${lx}" y="${cy - 50}" width="${nw}" height="100" rx="12" class="node-x"/>
  <text x="${lx + nw/2}" y="${cy - 30}" text-anchor="middle" class="node-label">ACTION</text>
  ${svgWrappedText(action, lx + nw/2, cy + 8, 'node-text-x')}

  <!-- Change node -->
  <rect x="${rx}" y="${cy - 50}" width="${nw}" height="100" rx="12" class="node-y"/>
  <text x="${rx + nw/2}" y="${cy - 30}" text-anchor="middle" class="node-label">CHANGE</text>
  ${svgWrappedText(change, rx + nw/2, cy + 8, 'node-text-y')}

  <!-- Connection: dashes stop flush against the arrowhead -->
  <line
    x1="${startX}" y1="${cy}"
    x2="${baseX}" y2="${cy}"
    stroke="${color}" stroke-width="${strokeW}"
    stroke-dasharray="${dash}"
    stroke-linecap="butt"
    opacity="${opacity}"
  />
  <polygon
    points="${baseX},${cy - headH/2} ${tipX},${cy} ${baseX},${cy + headH/2}"
    fill="${color}" opacity="${opacity}"
  />
</svg>`;
}

function extractYear(period) {
  const m = (period || '').match(/\d{4}/);
  return m ? parseInt(m[0]) : 9999;
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// ─── Render results ───────────────────────────────────────────────────────────
// Per-section renderers — each is idempotent (safe to call twice with same data).
function renderDiagramSection(data, action, change) {
  const color = strengthColor(data.strength_label);
  // Split the summary into one paragraph per sentence so each idea breathes.
  // Regex captures runs ending in . ! or ? (incl. ellipses); falls back to
  // whole string if no sentence-terminator is found.
  const summaryText = data.summary || '';
  const sentences = summaryText.match(/[^.!?]+[.!?]+["')\]]*\s*/g) || [summaryText];
  const summaryHtml = sentences
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => `<p>${escapeHtml(s)}</p>`)
    .join('');

  const vertical = window.innerWidth < 640;
  document.getElementById('diagram').innerHTML = `
    ${buildDiagram(action, change, data.strength, data.strength_label, vertical)}
    <div class="strength-badge">
      <span class="strength-dot" style="background:${color}"></span>
      <span style="color:${color}">${escapeHtml(data.strength_label || '')} link</span>
    </div>
    <div class="diagram-summary">${summaryHtml}</div>
  `;
}

function renderMechanismsSection(mechanisms) {
  document.getElementById('mechanisms-list').innerHTML = (mechanisms || []).map((m, i) => `
    <div class="mechanism-node">
      <div class="mechanism-num">${i + 1}</div>
      <div class="mechanism-bubble">${escapeHtml(m)}</div>
    </div>
  `).join('');
}

function renderEvidenceColumn(elId, items) {
  document.getElementById(elId).innerHTML = (items || []).map(e => {
    const source = e.source || '';
    const context = `${e.title || ''} — ${e.description || ''}`;
    return `
    <div class="evidence-item">
      <div class="evidence-title">${escapeHtml(e.title || '')}</div>
      <div class="evidence-desc">${escapeHtml(e.description || '')}</div>
      <div class="evidence-source">
        <span class="source-name">${escapeHtml(source)}</span><span class="source-sep"> · </span><button type="button" class="source-lookup" data-source="${escapeHtml(source)}" data-context="${escapeHtml(context)}">source</button>
      </div>
    </div>
  `;
  }).join('');
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.source-lookup');
  if (!btn || btn.disabled) return;
  const source = btn.dataset.source || '';
  const context = btn.dataset.context || '';
  if (!source) return;

  btn.disabled = true;
  btn.textContent = 'looking up…';

  try {
    const res = await fetch('/api/source-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, context }),
    });
    const data = await res.json().catch(() => ({}));
    const url = typeof data.url === 'string' && /^https?:\/\//i.test(data.url) ? data.url : '';

    const wrap = btn.parentElement;
    const nameEl = wrap.querySelector('.source-name');
    const sepEl = wrap.querySelector('.source-sep');

    if (url) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
      a.textContent = nameEl.textContent;
      nameEl.replaceWith(a);
      if (sepEl) sepEl.remove();
      btn.remove();
    } else {
      btn.textContent = 'no source found';
      btn.classList.add('source-lookup-empty');
    }
  } catch {
    btn.textContent = 'lookup failed';
    btn.classList.add('source-lookup-empty');
  }
});

function renderHistorySection(examples) {
  const sorted = (examples || []).slice().sort((a, b) => extractYear(a.period) - extractYear(b.period));
  const items = sorted.map(h => `
    <div class="tl-item">
      <div class="tl-period">${escapeHtml(h.period)}</div>
      <div class="tl-spacer"></div>
      <div class="tl-dot"></div>
      <div class="tl-card">
        <div class="tl-name">${escapeHtml(h.name)}</div>
        <div class="tl-outcome">${escapeHtml(h.outcome)}</div>
        <div class="tl-relevance">${escapeHtml(h.relevance)}</div>
      </div>
    </div>
  `);
  const connector = '<div class="tl-connector"><div class="tl-conn-dot"></div></div>';
  document.getElementById('history-list').innerHTML = items.join(connector);
}

function renderQuestionsSection(questions, action, change) {
  const worksheetKey = `toc:${action}:${change}`;
  const saved = JSON.parse(localStorage.getItem(worksheetKey) || '{}');
  const qEl = document.getElementById('questions-list');
  qEl.innerHTML = (questions || []).slice(0, 3).map((q, i) => `
    <li data-i="${i}">
      <div class="q-text">
        <span class="q-num">${i + 1}</span>
        <span class="q-body">${escapeHtml(q)}</span>
      </div>
      <div class="q-answer-wrap">
        <textarea id="q-answer-${i}" name="question_${i}" class="q-answer" placeholder="Write your thinking here…" rows="4">${escapeHtml(saved[i] || '')}</textarea>
      </div>
    </li>
  `).join('');

  qEl.querySelectorAll('li').forEach(li => {
    const i = li.dataset.i;
    const ta = li.querySelector('.q-answer');
    const savedMsg = li.querySelector('.q-saved');

    function refreshSavedState(content) {
      if (content) {
        li.classList.add('answered');
      } else {
        li.classList.remove('answered');
      }
    }

    refreshSavedState(saved[i] || '');

    let saveTimer;
    ta.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const all = JSON.parse(localStorage.getItem(worksheetKey) || '{}');
        all[i] = ta.value;
        localStorage.setItem(worksheetKey, JSON.stringify(all));
        refreshSavedState(ta.value);
      }, 400);
    });
  });
}

function renderAssumptionsSection(assumptions) {
  const aEl = document.getElementById('assumptions-list');
  aEl.innerHTML = (assumptions || []).map(a => `<li>${escapeHtml(a)}</li>`).join('');
  aEl.querySelectorAll('li').forEach(li => {
    li.addEventListener('mouseenter', () => li.classList.add('revealed'));
    li.addEventListener('click', () => li.classList.toggle('revealed'));
  });
}

function renderResults(data, action, change) {
  renderDiagramSection(data, action, change);
  renderMechanismsSection(data.mechanisms);
  renderEvidenceColumn('evidence-for', data.evidence_for);
  renderEvidenceColumn('evidence-against', data.evidence_against);
  renderHistorySection(data.historical_examples);
  renderQuestionsSection(data.probing_questions, action, change);
  renderAssumptionsSection(data.assumptions);
}

// ─── Progressive render (streams sections as Claude emits them) ───────────────
const SECTIONS_IN_ORDER = [
  'strength', 'strength_label', 'summary',
  'assumptions', 'mechanisms', 'evidence_for', 'evidence_against',
  'historical_examples', 'probing_questions'
];
let _renderedSections = new Set();
let _partialData = {};

function resetProgressiveState() {
  _renderedSections = new Set();
  _partialData = {};
}

function injectSkeletons() {
  const bar = (h) => `<div class="skel" style="height:${h}px"></div>`;
  const liBar = (h) => `<li class="skel-li"><div class="skel" style="height:${h}px"></div></li>`;
  document.getElementById('diagram').innerHTML = bar(220);
  document.getElementById('mechanisms-list').innerHTML = bar(56) + bar(56) + bar(56);
  document.getElementById('assumptions-list').innerHTML = liBar(22).repeat(3);
  document.getElementById('evidence-for').innerHTML = bar(90) + bar(90) + bar(90);
  document.getElementById('evidence-against').innerHTML = bar(90) + bar(90) + bar(90);
  document.getElementById('history-list').innerHTML = bar(70) + bar(70) + bar(70);
  document.getElementById('questions-list').innerHTML = liBar(22).repeat(3);
}

// Extract a complete JSON value for a top-level key from the raw buffer.
// Returns the raw value string if complete, null if still streaming.
// Uses balanced-bracket scanning so it never reads truncated content.
function extractCompleteJsonValue(buf, key) {
  const prefix = `"${key}"`;
  let searchFrom = 0;
  let keyIdx = -1;
  while (searchFrom < buf.length) {
    const idx = buf.indexOf(prefix, searchFrom);
    if (idx < 0) break;
    // Verify the char before the key (ignoring whitespace) is { or , — top-level field only.
    let before = idx - 1;
    while (before >= 0 && /\s/.test(buf[before])) before--;
    if (before < 0 || buf[before] === '{' || buf[before] === ',') { keyIdx = idx; break; }
    searchFrom = idx + prefix.length;
  }
  if (keyIdx < 0) return null;

  let i = keyIdx + prefix.length;
  while (i < buf.length && /\s/.test(buf[i])) i++;
  if (i >= buf.length || buf[i] !== ':') return null;
  i++;
  while (i < buf.length && /\s/.test(buf[i])) i++;
  if (i >= buf.length) return null;

  const start = i;
  const ch = buf[i];

  if (ch === '[' || ch === '{') {
    const close = ch === '[' ? ']' : '}';
    let depth = 0, inStr = false;
    for (; i < buf.length; i++) {
      const c = buf[i];
      if (c === '\\' && inStr) { i++; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (c === ch) depth++;
        else if (c === close) { depth--; if (depth === 0) return buf.slice(start, i + 1); }
      }
    }
    return null;
  } else if (ch === '"') {
    i++;
    for (; i < buf.length; i++) {
      const c = buf[i];
      if (c === '\\') { i++; continue; }
      if (c === '"') return buf.slice(start, i + 1);
    }
    return null;
  } else {
    const match = buf.slice(i).match(/^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/);
    return match ? match[0] : null;
  }
}

function tryProgressiveRender(buffer, action, change) {
  const cleanBuf = buffer
    .replace(/^```(?:json)?\s*/, '')
    .replace(/```\s*$/, '');

  let renderedAny = false;
  for (let i = 0; i < SECTIONS_IN_ORDER.length; i++) {
    const key = SECTIONS_IN_ORDER[i];
    if (_renderedSections.has(key)) continue;
    const rawValue = extractCompleteJsonValue(cleanBuf, key);
    if (!rawValue) break;
    let sectionData;
    try { sectionData = JSON.parse(rawValue); } catch { break; }

    _partialData[key] = sectionData;
    _renderedSections.add(key);

    // Render the section now that it's complete.
    // Diagram needs strength + strength_label + summary together; render once when summary lands.
    if (key === 'strength' || key === 'strength_label') {
      // Wait for summary
    } else if (key === 'summary') {
      if ('strength' in _partialData && 'strength_label' in _partialData) {
        renderDiagramSection(_partialData, action, change);
        renderedAny = true;
      }
    } else if (key === 'mechanisms') {
      renderMechanismsSection(_partialData.mechanisms);
      renderedAny = true;
    } else if (key === 'evidence_for') {
      renderEvidenceColumn('evidence-for', _partialData.evidence_for);
      renderedAny = true;
    } else if (key === 'evidence_against') {
      renderEvidenceColumn('evidence-against', _partialData.evidence_against);
      renderedAny = true;
    } else if (key === 'historical_examples') {
      renderHistorySection(_partialData.historical_examples);
      renderedAny = true;
    } else if (key === 'probing_questions') {
      renderQuestionsSection(_partialData.probing_questions, action, change);
      renderedAny = true;
    } else if (key === 'assumptions') {
      renderAssumptionsSection(_partialData.assumptions);
      renderedAny = true;
    }
  }
  return renderedAny;
}

// ─── Robust JSON parser ───────────────────────────────────────────────────────
// Claude's output occasionally contains JSON-illegal raw control chars inside
// string values (newlines, tabs, CR) — JSON forbids U+0000..U+001F unescaped
// inside strings, so JSON.parse throws "Unterminated string at position X" at
// the byte index of the offending char. We escape these before parsing, then
// fall back to closing any truncated structure (max_tokens cutoff).
function parseJSON(str) {
  // First try straight parse
  try { return JSON.parse(str); } catch (_) {}

  // Pass 1: escape raw control chars that appear inside strings.
  let escaped = '';
  let inStr = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    // Honor backslash-escapes inside strings so we don't double-escape \" or \\.
    if (c === '\\' && inStr && i + 1 < str.length) {
      escaped += c + str[i + 1];
      i++;
      continue;
    }
    if (c === '"') { inStr = !inStr; escaped += c; continue; }
    if (inStr) {
      const code = c.charCodeAt(0);
      if (c === '\n') { escaped += '\\n'; continue; }
      if (c === '\r') { escaped += '\\r'; continue; }
      if (c === '\t') { escaped += '\\t'; continue; }
      if (code < 0x20) { escaped += '\\u' + code.toString(16).padStart(4, '0'); continue; }
    }
    escaped += c;
  }
  try { return JSON.parse(escaped); } catch (_) {}

  // Pass 2: close any truncated structure by counting unclosed brackets/braces.
  let fixed = escaped;
  const opens = { '{': '}', '[': ']', '"': '"' };
  const stack = [];
  let inString = false;
  for (let i = 0; i < fixed.length; i++) {
    const c = fixed[i];
    if (c === '\\' && inString) { i++; continue; }
    if (c === '"') { inString = !inString; if (inString) stack.push('"'); else if (stack[stack.length-1] === '"') stack.pop(); continue; }
    if (!inString) {
      if (c === '{' || c === '[') stack.push(opens[c]);
      else if ((c === '}' || c === ']') && stack[stack.length-1] === c) stack.pop();
    }
  }
  // If the truncation happened right after a backslash, drop the dangling \ so
  // we don't end up with an invalid escape when we close the string.
  if (inString && fixed.endsWith('\\')) fixed = fixed.slice(0, -1);
  if (inString) fixed += '"';
  while (stack.length) {
    const top = stack.pop();
    if (top !== '"') fixed += top;
  }
  try { return JSON.parse(fixed); } catch (_) {}

  // Pass 3: strip trailing comma before closing bracket/brace.
  fixed = fixed.replace(/,\s*([\]}])/g, '$1');
  try { return JSON.parse(fixed); } catch (e) {
    // Surface a more useful error than the raw position number.
    throw new Error('Could not parse model response as JSON: ' + e.message);
  }
}

// ─── Analyze ──────────────────────────────────────────────────────────────────
btn.addEventListener('click', analyze);

async function analyze() {
  const action = fieldValue(fieldX).trim();
  const change = fieldValue(fieldY).trim();
  if (!action || !change) return;

  document.getElementById('error-banner').hidden = true;
  document.getElementById('hero').classList.add('shrunk');
  document.getElementById('results').classList.remove('visible');
  document.getElementById('loading').classList.add('visible');
  btn.disabled = true;
  resetProgressiveState();
  injectSkeletons();

  let buffer = '';
  let resultsShown = false;

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, change }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
      throw new Error(err.error || `Server error ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value);
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // keep any incomplete trailing line for next read
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const payload = JSON.parse(line.slice(6));
          if (payload.chunk) buffer += payload.chunk;
          if (payload.error) throw new Error(payload.error);
          if (payload.done) {
            const jsonStr = buffer.match(/\{[\s\S]*\}/)?.[0];
            if (!jsonStr) throw new Error('No JSON in response');
            const data = parseJSON(jsonStr);
            renderResults(data, action, change); // final safety pass — idempotent
            document.getElementById('loading').classList.remove('visible');
            if (!resultsShown) {
              document.getElementById('results').classList.add('visible');
              scrollToResults();
              resultsShown = true;
              document.querySelector('.cta-hint').textContent = 'We found evidence, examples, and hard questions';
            }
            scheduleRelatedCategories(data, action, change);
          }
        }
      }
      // After each chunk, try to render any newly-complete sections
      if (payload_chunk_arrived(buffer)) {
        if (tryProgressiveRender(buffer, action, change) && !resultsShown) {
          document.getElementById('loading').classList.remove('visible');
          document.getElementById('results').classList.add('visible');
          scrollToResults();
          resultsShown = true;
          document.querySelector('.cta-hint').textContent = 'We found evidence, examples, and hard questions';
        }
      }
    }
  } catch (err) {
    console.error('analyze error:', err);
    document.getElementById('loading').classList.remove('visible');
    const msg = /input stream|network|fetch|failed to fetch/i.test(err.message)
      ? 'The connection was interrupted. Please check your network and try again.'
      : 'Something went wrong. Please try again.';
    showErrorBanner(msg);
    btn.disabled = false;
    document.getElementById('hero').classList.remove('shrunk');
  }
}

// Tiny helper to indicate the buffer has grown — we always re-try render after
// any read(), since chunks arrive in arbitrary boundaries.
function payload_chunk_arrived(buf) { return buf && buf.length > 0; }

function showErrorBanner(msg) {
  const banner = document.getElementById('error-banner');
  document.getElementById('error-banner-msg').textContent = msg;
  banner.hidden = false;
}

document.getElementById('error-banner-close').addEventListener('click', () => {
  document.getElementById('error-banner').hidden = true;
});

// Scroll to #results, but wait for the hero's shrink transition to finish
// first. Otherwise (e.g., on cached responses that arrive before the 600ms
// hero transition completes) we'd scroll to the pre-shrink position and land
// well below the diagram.
function scrollToResults() {
  const hero = document.getElementById('hero');
  const target = document.getElementById('results');
  let fired = false;
  function go() {
    if (fired) return;
    fired = true;
    hero.removeEventListener('transitionend', onEnd);
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function onEnd(e) {
    if (e.target === hero) go();
  }
  hero.addEventListener('transitionend', onEnd);
  // Fallback if the transition is already done or transitionend doesn't fire
  // (e.g., prefers-reduced-motion). Match the CSS duration (600ms) + a buffer.
  setTimeout(go, 650);
}

// ─── Reset ────────────────────────────────────────────────────────────────────
document.getElementById('reset-btn').addEventListener('click', () => {
  document.getElementById('hero').classList.remove('shrunk');
  document.getElementById('results').classList.remove('visible');
  setFieldValue(fieldX, ''); setFieldValue(fieldY, '');
  updateField(fieldX); updateField(fieldY);
  btn.disabled = true;
  resetProgressiveState();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Enter submits; Shift+Enter inserts a newline (default textarea behavior)
[fieldX, fieldY].forEach(f => f.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!btn.disabled) analyze();
  }
}));

// ─── Feedback ────────────────────────────────────────────────────────────────
const feedbackForm   = document.getElementById('feedback-form');
const feedbackWrap   = document.getElementById('feedback');
const feedbackMsg    = document.getElementById('feedback-message');
const feedbackEmail  = document.getElementById('feedback-email');
const feedbackBtn    = document.getElementById('feedback-submit');
const feedbackStatus = document.getElementById('feedback-status');

feedbackForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = feedbackMsg.value.trim();
  const email = feedbackEmail.value.trim();

  if (!message) {
    feedbackStatus.textContent = 'Please add a short message before sending.';
    feedbackStatus.className = 'feedback-status err';
    feedbackMsg.focus();
    return;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    feedbackStatus.textContent = 'That email address does not look valid.';
    feedbackStatus.className = 'feedback-status err';
    feedbackEmail.focus();
    return;
  }

  feedbackBtn.disabled = true;
  feedbackStatus.textContent = 'Sending…';
  feedbackStatus.className = 'feedback-status';

  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, email: email || undefined })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Server error ${res.status}`);
    }
    feedbackWrap.classList.add('sent');
  } catch (err) {
    feedbackStatus.textContent = 'Could not send: ' + err.message;
    feedbackStatus.className = 'feedback-status err';
    feedbackBtn.disabled = false;
  }
});

// Reset feedback state when user starts a new theory
document.getElementById('reset-btn').addEventListener('click', () => {
  feedbackWrap.classList.remove('sent');
  feedbackMsg.value = '';
  feedbackEmail.value = '';
  feedbackBtn.disabled = false;
  feedbackStatus.textContent = '';
  feedbackStatus.className = 'feedback-status';
});

// ─── Related CTFG categories (lazy-loaded recommendation widget) ──────────────
let _relatedObserver = null;
let _relatedInputText = null;
let _relatedFetched = false;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function scheduleRelatedCategories(data, action, change) {
  const section = document.getElementById('related-categories');
  const grid = document.getElementById('related-categories-grid');
  if (!section || !grid) return;

  // Reset per-submission state
  _relatedFetched = false;
  grid.innerHTML = '<div class="related-skeleton">Looking for related work…</div>';
  section.hidden = false;

  // Build input text: action + change + summary + mechanisms only
  // (evidence/assumptions add noise without improving category match quality)
  const parts = [action, change, data.summary, ...(Array.isArray(data.mechanisms) ? data.mechanisms : [])];
  _relatedInputText = parts.filter(Boolean).join('\n').slice(0, 5000);

  // Lazy-fetch: trigger when section scrolls near viewport
  if (typeof IntersectionObserver === 'undefined') {
    // Old browser fallback: fetch immediately
    fetchRelatedCategories(_relatedInputText);
    return;
  }
  if (!_relatedObserver) {
    _relatedObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !_relatedFetched && _relatedInputText) {
          _relatedFetched = true;
          fetchRelatedCategories(_relatedInputText);
        }
      }
    }, { rootMargin: '200px' });
    _relatedObserver.observe(section);
  } else if (!_relatedFetched && _relatedInputText) {
    // On re-submission, observer is already firing for elements in view —
    // force-check by re-observing
    _relatedObserver.unobserve(section);
    _relatedObserver.observe(section);
  }
}

async function fetchRelatedCategories(text) {
  const section = document.getElementById('related-categories');
  const grid = document.getElementById('related-categories-grid');
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    const res = await fetch('/api/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, limit: 3 }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error('http ' + res.status);
    const payload = await res.json();
    const items = [
      ...(Array.isArray(payload.categories)  ? payload.categories  : []),
      ...(Array.isArray(payload.issues)       ? payload.issues      : []),
      ...(Array.isArray(payload.communities)  ? payload.communities : []),
    ];
    if (!items.length || payload.dailyCapReached) {
      section.hidden = true;
      grid.innerHTML = '';
      return;
    }
    grid.innerHTML = items.map(c => {
      const displayName = (c.type === 'issue' || c.type === 'community')
        ? c.name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
        : c.name;
      return `
      <a class="related-card" href="${escapeHtml(c.softrUrl || '#')}" target="_blank" rel="noopener noreferrer">
        <div class="related-card-name">${escapeHtml(displayName)}</div>
        ${c.description ? `<div class="related-card-desc">${escapeHtml(c.description)}</div>` : ''}
        <span class="related-card-explore">Explore →</span>
      </a>
    `;
    }).join('');
  } catch (err) {
    console.warn('related-categories: fetch failed', err);
    section.hidden = true;
    grid.innerHTML = '';
  }
}

// Clear related categories when user starts a new theory
document.getElementById('reset-btn').addEventListener('click', () => {
  const section = document.getElementById('related-categories');
  const grid = document.getElementById('related-categories-grid');
  if (section) section.hidden = true;
  if (grid) grid.innerHTML = '';
  _relatedFetched = false;
  _relatedInputText = null;
});

// ─── Print + Share ───────────────────────────────────────────────────────────
document.getElementById('print-btn').addEventListener('click', () => {
  window.print();
});

const shareBackdrop  = document.getElementById('share-backdrop');
const shareUrlInput  = document.getElementById('share-url-input');
const shareCopyBtn   = document.getElementById('share-copy-btn');
const shareNativeBtn = document.getElementById('share-native-btn');
const shareCloseBtn  = document.getElementById('share-close-btn');

function buildShareUrl() {
  const a = fieldValue(fieldX).trim();
  const c = fieldValue(fieldY).trim();
  const params = new URLSearchParams({ a, c });
  return `${location.origin}${location.pathname}?${params.toString()}`;
}

function openShareModal() {
  const url = buildShareUrl();
  shareUrlInput.value = url;
  shareBackdrop.classList.add('open');
  shareCopyBtn.classList.remove('copied');
  shareCopyBtn.textContent = 'Copy link';
  // Defer selection until after the modal is painted so the input has focus.
  requestAnimationFrame(() => {
    shareUrlInput.focus();
    shareUrlInput.select();
  });
}

function closeShareModal() {
  shareBackdrop.classList.remove('open');
}

document.getElementById('share-btn').addEventListener('click', openShareModal);
shareCloseBtn.addEventListener('click', closeShareModal);
shareBackdrop.addEventListener('click', (e) => {
  if (e.target === shareBackdrop) closeShareModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && shareBackdrop.classList.contains('open')) closeShareModal();
});

shareCopyBtn.addEventListener('click', async () => {
  const url = shareUrlInput.value;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // Fallback for browsers that block clipboard API outside a user gesture
    // or over HTTP (this dev host is HTTP). execCommand is deprecated but
    // still works in most browsers as a fallback.
    shareUrlInput.select();
    document.execCommand('copy');
  }
  shareCopyBtn.classList.add('copied');
  shareCopyBtn.textContent = 'Copied!';
  setTimeout(() => {
    shareCopyBtn.classList.remove('copied');
    shareCopyBtn.textContent = 'Copy link';
  }, 1500);
});

if (typeof navigator.share === 'function') {
  shareNativeBtn.classList.add('available');
  shareNativeBtn.addEventListener('click', async () => {
    const url = shareUrlInput.value;
    const action = fieldValue(fieldX).trim();
    const change = fieldValue(fieldY).trim();
    try {
      await navigator.share({
        title: 'Theory of Change',
        text: `Does "${action}" really lead to "${change}"?`,
        url
      });
    } catch {
      /* User cancelled or share unavailable — no-op */
    }
  });
}

// Auto-run analysis when the page is opened with ?a=…&c=… share parameters.
(function autoRunFromUrl() {
  const params = new URLSearchParams(location.search);
  const a = (params.get('a') || '').trim();
  const c = (params.get('c') || '').trim();
  if (!a || !c) return;
  setFieldValue(fieldX, a);
  setFieldValue(fieldY, c);
  updateField(fieldX);
  updateField(fieldY);
  checkReady();
  // Run after the current tick so all other DOMContentLoaded handlers settle.
  setTimeout(() => { if (!btn.disabled) analyze(); }, 0);
})();

// When the user starts a fresh theory, also clear the URL so address-bar
// state matches what's on screen.
document.getElementById('reset-btn').addEventListener('click', () => {
  if (location.search) {
    history.replaceState({}, '', location.pathname);
  }
});
