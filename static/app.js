/* ── Le Mat — frontend ──────────────────────────────────────────────── */
const API = '';

// ── State ────────────────────────────────────────────────────────────
let currentProject = null;
let editor         = null;
let tabs           = [];
let activeTab      = null;
let currentRunId   = null;
let currentES      = null;

// Types de fichiers qui s'ouvrent dans le navigateur (pas exécutés)
const WEB_EXTS = new Set(['html', 'htm', 'css', 'svg', 'js', 'json']);

// ── Monaco setup ─────────────────────────────────────────────────────
require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });

require(['vs/editor/editor.main'], () => {
  monaco.editor.defineTheme('lemat', {
    base: 'vs-dark', inherit: true, rules: [],
    colors: { 'editor.background': '#0f1117' },
  });

  editor = monaco.editor.create(document.getElementById('monaco-container'), {
    theme: 'lemat', fontSize: 14,
    fontFamily: "'JetBrains Mono','Fira Code',Cascadia Code,monospace",
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    wordWrap: 'off',
    automaticLayout: true,
  });

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    if (activeTab) saveTab(activeTab);
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => {
    if (activeTab) closeTab(activeTab.path);
  });
  editor.addCommand(monaco.KeyCode.F5, () => runCurrentFile());

  init();
});

// ── Init ─────────────────────────────────────────────────────────────
async function init() {
  await loadProjects();
  setupResizeHandle();
  document.getElementById('btn-run').onclick        = () => runCurrentFile();
  document.getElementById('btn-stop').onclick       = () => stopRun();
  document.getElementById('btn-clear-term').onclick = () => clearTerminal();
  document.getElementById('btn-toggle-term').onclick = () => {
    const panel = document.getElementById('terminal-panel');
    panel.classList.toggle('collapsed');
    document.getElementById('btn-toggle-term').textContent =
      panel.classList.contains('collapsed') ? '⬆ Logs' : '⬇ Logs';
  };
  document.getElementById('btn-sync-db').onclick = () => syncSchema();
}

// ── API helpers ───────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json().catch(() => null);
}

// ── Projects ─────────────────────────────────────────────────────────
async function loadProjects() {
  const projects = await api('GET', '/api/projects');
  const ul = document.getElementById('project-list');
  ul.innerHTML = '';
  projects.forEach(name => {
    const li = document.createElement('li');
    li.dataset.name = name;
    li.innerHTML = `
      <span class="project-name">📦 ${name}</span>
      <button class="btn-delete-project" title="Supprimer">🗑</button>`;
    li.querySelector('.project-name').onclick = () => selectProject(name);
    li.querySelector('.btn-delete-project').onclick = (e) => {
      e.stopPropagation();
      confirmDelete(`Supprimer le projet "${name}" ?`, () => deleteProject(name));
    };
    if (name === currentProject) li.classList.add('active');
    ul.appendChild(li);
  });
}

async function deleteProject(name) {
  await api('DELETE', `/api/projects/${name}`);
  if (currentProject === name) {
    currentProject = null; tabs = []; activeTab = null;
    renderTabs(); showWelcome();
    document.getElementById('filetree-section').style.display = 'none';
  }
  await loadProjects();
  toast('Projet supprimé', 'success');
}

document.getElementById('btn-new-project').onclick = () => {
  prompt_('Nom du nouveau projet', '', async (name) => {
    if (!name) return;
    await api('POST', `/api/projects/${name}`);
    await loadProjects();
    selectProject(name);
    toast(`Projet "${name}" créé`, 'success');
  });
};

// ── Export project ────────────────────────────────────────────────────────────
document.getElementById('btn-export-project').onclick = () => {
  if (!currentProject) return;
  const a = document.createElement('a');
  a.href = `/api/projects/${encodeURIComponent(currentProject)}/export`;
  a.download = `${currentProject}.zip`;
  // Must be in the DOM for Firefox/Safari to trigger the download
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast(`Export de "${currentProject}" lancé ✓`, 'success');
};

// ── Import project ────────────────────────────────────────────────────────────
document.getElementById('btn-import-project').onclick = () => {
  document.getElementById('import-project-input').value = '';
  document.getElementById('import-project-input').click();
};

document.getElementById('import-project-input').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // Suggest project name from the filename (strip .zip)
  const suggested = file.name.replace(/\.zip$/i, '');

  prompt_('Nom du projet à importer', suggested, async (name) => {
    if (!name) return;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', name);

    try {
      const resp = await fetch('/api/projects-import', {
        method: 'POST',
        body: formData,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        toast(err.detail || 'Erreur import', 'error');
        return;
      }
      await loadProjects();
      await selectProject(name);
      toast(`Projet "${name}" importé ✓`, 'success');
    } catch (err) {
      toast('Erreur import : ' + err.message, 'error');
    }
  });
};

async function selectProject(name) {
  currentProject = name;
  document.querySelectorAll('#project-list li').forEach(li =>
    li.classList.toggle('active', li.dataset.name === name));
  document.getElementById('current-project-name').textContent = name;
  document.getElementById('filetree-section').style.display = 'flex';
  document.getElementById('email-section').style.display = 'flex';
  await Promise.all([loadTree(), loadDbSection(), loadEmailStatus(), loadCronSection()]);
}

// ── File tree ─────────────────────────────────────────────────────────
async function loadTree() {
  const tree = await api('GET', `/api/projects/${currentProject}/tree`);
  const container = document.getElementById('file-tree');
  container.innerHTML = '';
  renderTree(tree.children, container, '');
}

function renderTree(children, container, prefix) {
  (children || []).forEach(node => {
    const div = document.createElement('div');
    div.classList.add('tree-item');
    const isDir = node.type === 'directory';
    const icon  = isDir ? '📁' : fileIcon(node.name);
    const path  = prefix ? `${prefix}/${node.name}` : node.name;

    div.innerHTML = `
      <span class="tree-icon">${icon}</span>
      <span class="tree-name">${node.name}</span>
      ${!isDir ? '<button class="btn-delete-file" title="Supprimer">✕</button>' : ''}`;

    if (activeTab?.path === path) div.classList.add('active');

    if (isDir) {
      const childWrap = document.createElement('div');
      childWrap.classList.add('tree-children');
      childWrap.style.display = 'none';
      let open = false;
      div.onclick = () => {
        open = !open;
        childWrap.style.display = open ? 'block' : 'none';
        div.querySelector('.tree-icon').textContent = open ? '📂' : '📁';
      };
      renderTree(node.children, childWrap, path);
      container.appendChild(div);
      container.appendChild(childWrap);
    } else {
      div.onclick = (e) => { if (!e.target.classList.contains('btn-delete-file')) openFile(path); };
      div.querySelector('.btn-delete-file').onclick = (e) => {
        e.stopPropagation();
        confirmDelete(`Supprimer "${node.name}" ?`, async () => {
          await api('DELETE', `/api/projects/${currentProject}/files/${path}`);
          tabs = tabs.filter(t => t.path !== path);
          if (activeTab?.path === path) activeTab = tabs[tabs.length - 1] || null;
          renderTabs();
          if (activeTab) showTab(activeTab); else showWelcome();
          await loadTree();
          toast('Fichier supprimé', 'success');
        });
      };
      container.appendChild(div);
    }
  });
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ({
    html:'🌐', htm:'🌐', css:'🎨', js:'⚡', mjs:'⚡', ts:'⚡',
    json:'📋', sql:'🗄', db:'🗄', sqlite:'🗄', sqlite3:'🗄',
    md:'📝', txt:'📝', py:'🐍', sh:'⚙',
    png:'🖼', jpg:'🖼', jpeg:'🖼', gif:'🖼', svg:'🖼', webp:'🖼', pdf:'📄',
  })[ext] || '📄';
}

// ── New file / folder ─────────────────────────────────────────────────
document.getElementById('btn-new-file').onclick = () => {
  prompt_('Nom du fichier (ex: index.html)', '', async (name) => {
    if (!name) return;
    await api('PUT', `/api/projects/${currentProject}/files/${name}`, { content: '' });
    await loadTree();
    openFile(name);
  });
};

document.getElementById('btn-new-folder').onclick = () => {
  prompt_('Nom du dossier', '', async (name) => {
    if (!name) return;
    await api('POST', `/api/projects/${currentProject}/mkdir/${name}`);
    await loadTree();
    toast(`Dossier "${name}" créé`, 'success');
  });
};

// ── Upload ────────────────────────────────────────────────────────────
document.getElementById('btn-upload').onclick = () =>
  document.getElementById('upload-input').click();

document.getElementById('upload-input').onchange = async (e) => {
  const files = e.target.files;
  if (!files.length) return;
  const fd = new FormData();
  Array.from(files).forEach(f => fd.append('files', f));
  fd.append('folder', '');
  const res = await fetch(`/api/projects/${currentProject}/upload`, { method: 'POST', body: fd });
  if (!res.ok) { toast('Erreur upload', 'error'); return; }
  const data = await res.json();
  await loadTree();
  toast(`${data.uploaded.length} fichier(s) uploadé(s)`, 'success');
  e.target.value = '';
};

// ── Tabs ──────────────────────────────────────────────────────────────
async function openFile(path) {
  const ext = path.split('.').pop().toLowerCase();
  const binary = ['png','jpg','jpeg','gif','webp','pdf','db','sqlite','sqlite3'];
  if (binary.includes(ext)) { toast('Fichier binaire — aperçu non disponible', 'error'); return; }

  let tab = tabs.find(t => t.path === path);
  if (!tab) {
    const data = await api('GET', `/api/projects/${currentProject}/files/${path}`);
    const model = monaco.editor.createModel(data.content, detectLang(path));
    tab = { path, modified: false, model };
    model.onDidChangeContent(() => { tab.modified = true; renderTabs(); });
    tabs.push(tab);
  }
  activeTab = tab;
  renderTabs();
  showTab(tab);
  highlightTreeItem(path);
}

function showTab(tab) {
  if (tab.type === 'data') { showDataTab(tab); return; }
  const container = document.getElementById('editor-container');
  container.querySelectorAll('.data-view').forEach(el => el.remove());
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.style.display = 'none';
  document.getElementById('monaco-container').style.display = 'block';
  editor.setModel(tab.model);
  editor.layout();
  editor.focus();
}

function showWelcome() {
  document.getElementById('monaco-container').style.display = 'none';
  document.getElementById('editor-container').querySelectorAll('.data-view').forEach(el => el.remove());
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.style.display = 'flex';
}

function renderTabs() {
  const bar = document.getElementById('tabs-bar');
  bar.innerHTML = '';
  tabs.forEach(tab => {
    const div = document.createElement('div');
    div.classList.add('tab');
    if (tab === activeTab) div.classList.add('active');
    const fname = tab.path.split('/').pop();
    div.innerHTML = `
      <span class="tab-name" title="${tab.path}">${fname}</span>
      ${tab.modified ? '<span class="tab-modified">●</span>' : ''}
      <button class="tab-close" title="Fermer">✕</button>`;
    div.onclick = (e) => {
      if (!e.target.classList.contains('tab-close')) {
        activeTab = tab; renderTabs(); showTab(tab); highlightTreeItem(tab.path);
      }
    };
    div.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); closeTab(tab.path); };
    bar.appendChild(div);
  });
}

function closeTab(path) {
  const idx = tabs.findIndex(t => t.path === path);
  if (idx === -1) return;
  if (tabs[idx].model) tabs[idx].model.dispose();
  tabs.splice(idx, 1);
  if (activeTab?.path === path) activeTab = tabs[Math.min(idx, tabs.length - 1)] || null;
  renderTabs();
  if (activeTab) showTab(activeTab); else showWelcome();
}

async function saveTab(tab) {
  await api('PUT', `/api/projects/${currentProject}/files/${tab.path}`, {
    content: tab.model.getValue(),
  });
  tab.modified = false;
  renderTabs();
  // live reload is triggered server-side on save
  toast('Sauvegardé ✓', 'success');
}

function detectLang(path) {
  const ext = path.split('.').pop().toLowerCase();
  return ({
    js:'javascript', mjs:'javascript', ts:'typescript',
    html:'html', htm:'html', css:'css', json:'json',
    py:'python', sql:'sql', md:'markdown', xml:'xml',
    yaml:'yaml', yml:'yaml', sh:'shell', bash:'shell',
  })[ext] || 'plaintext';
}

function highlightTreeItem(path) {
  document.querySelectorAll('.tree-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tree-item').forEach(el => {
    if (el.querySelector('.tree-name')?.textContent === path.split('/').pop())
      el.classList.add('active');
  });
}

// ── DB Section ───────────────────────────────────────────────────────
let dbSchema = null;

async function loadDbSection() {
  const info = await api('GET', `/api/projects/${currentProject}/schema`);
  dbSchema = info;
  const section = document.getElementById('db-section');
  const tree    = document.getElementById('db-tree');

  if (!info.tables.length && !info.hasSchemaFile) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'flex';
  tree.innerHTML = '';

  if (info.hasSchemaFile && !info.database) {
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:8px 12px;font-size:12px;color:var(--warn)';
    hint.textContent = '⚡ Clique "Sync" pour créer la base depuis le schéma';
    tree.appendChild(hint);
  }

  info.tables.forEach(t => {
    const wrap = document.createElement('div');

    const row = document.createElement('div');
    row.classList.add('db-table-item');
    row.innerHTML = `
      <span>🗄</span>
      <span class="db-table-name">${t.name}</span>
      <span class="db-table-count">${t.rows} lignes</span>`;

    const fields = document.createElement('div');
    fields.classList.add('db-field-list');
    fields.style.display = 'none';

    t.columns.forEach(col => {
      const badges = [];
      if (col.pk)     badges.push('<span class="db-field-badge">PK</span>');
      if (col.notnull) badges.push('<span class="db-field-badge">NN</span>');
      const f = document.createElement('div');
      f.classList.add('db-field-item');
      f.innerHTML = `
        <span class="db-field-name">${col.name}</span>
        <span class="db-field-type">${col.type}</span>
        ${badges.join('')}`;
      fields.appendChild(f);
    });

    // Click → toggle fields + open data view
    let open = false;
    row.onclick = () => {
      open = !open;
      fields.style.display = open ? 'block' : 'none';
      openDataView(t.name);
      document.querySelectorAll('.db-table-item').forEach(el => el.classList.remove('active'));
      row.classList.add('active');
    };

    wrap.appendChild(row);
    wrap.appendChild(fields);
    tree.appendChild(wrap);
  });
}

async function syncSchema() {
  if (!currentProject) return;
  try {
    const res = await api('POST', `/api/projects/${currentProject}/schema/sync`);
    toast(`✓ ${res.message}`, 'success');
    await loadDbSection();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Data View (table browser) ─────────────────────────────────────────
let dataViewTab = null;   // { tableName, type:'data' }

async function openDataView(tableName) {
  // Check if already open
  const existing = tabs.find(t => t.type === 'data' && t.tableName === tableName);
  if (existing) {
    activeTab = existing;
    renderTabs();
    showDataTab(existing);
    return;
  }

  const tab = { path: `[data] ${tableName}`, tableName, type: 'data', modified: false };
  tabs.push(tab);
  activeTab = tab;
  renderTabs();
  await showDataTab(tab);
}

async function showDataTab(tab) {
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.style.display = 'none';
  document.getElementById('monaco-container').style.display = 'none';

  const container = document.getElementById('editor-container');

  // Remove existing data view
  container.querySelectorAll('.data-view').forEach(el => el.remove());

  const data = await api('GET', `/api/projects/${currentProject}/data/${tab.tableName}?limit=200`);

  const view = document.createElement('div');
  view.classList.add('data-view');

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.classList.add('data-view-toolbar');
  toolbar.innerHTML = `
    <span>🗄 <strong>${tab.tableName}</strong></span>
    <span>${data.total} ligne(s)</span>
    <div style="flex:1"></div>
    <button id="dv-refresh">↺ Actualiser</button>`;
  view.appendChild(toolbar);

  // Grid
  const wrap = document.createElement('div');
  wrap.classList.add('data-grid-wrap');

  if (!data.rows.length) {
    wrap.innerHTML = '<div class="data-empty">Aucune donnée dans cette table.</div>';
  } else {
    const cols = Object.keys(data.rows[0]);
    const table = document.createElement('table');
    table.classList.add('data-grid');

    // Header
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr>' + cols.map(c => `<th>${c}</th>`).join('') + '<th></th></tr>';
    table.appendChild(thead);

    // Rows
    const tbody = document.createElement('tbody');
    data.rows.forEach(row => {
      const tr = document.createElement('tr');
      tr.dataset.rowData = JSON.stringify(row);
      cols.forEach(col => {
        const td = document.createElement('td');
        const val = row[col];
        if (val === null || val === undefined) {
          td.classList.add('null-val');
          td.textContent = 'null';
        } else {
          td.textContent = String(val);
        }
        tr.appendChild(td);
      });
      // Actions cell
      const actionsTd = document.createElement('td');
      actionsTd.innerHTML = `<span class="row-actions">
        <button class="btn-row-del" title="Supprimer">🗑</button>
      </span>`;
      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    // Delete row
    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('.btn-row-del');
      if (!btn) return;
      const tr = btn.closest('tr');
      const rowData = JSON.parse(tr.dataset.rowData);
      // Find PK value (first column)
      const pkVal = rowData[cols[0]];
      await api('DELETE', `/api/projects/${currentProject}/data/${tab.tableName}/${pkVal}`);
      tr.remove();
      toast('Ligne supprimée', 'success');
    });

    wrap.appendChild(table);
  }

  view.appendChild(wrap);
  container.appendChild(view);

  toolbar.querySelector('#dv-refresh').onclick = () => showDataTab(tab);
}

// ── Run ───────────────────────────────────────────────────────────────
function runCurrentFile() {
  if (!activeTab || !currentProject) { toast('Ouvre un fichier d\'abord', 'error'); return; }

  const ext       = activeTab.path.split('.').pop().toLowerCase();
  const customCmd = document.getElementById('custom-cmd').value.trim();

  // Fichiers web → ouvrir le projet dans un nouvel onglet du navigateur
  if (!customCmd && WEB_EXTS.has(ext)) {
    saveTab(activeTab).then(() => {
      const url = `/projects/${currentProject}/`;
      // window.open avec un nom fixe réutilise le même onglet s'il est encore ouvert
      window.open(url, `lemat-${currentProject}`);
    });
    return;
  }

  // Fichiers exécutables (Python, Node, Shell…) → logs dans le terminal
  saveTab(activeTab).then(() => {
    const params = customCmd ? `?cmd=${encodeURIComponent(customCmd)}` : '';
    const url    = `/api/projects/${currentProject}/exec/${activeTab.path}${params}`;

    if (currentES) currentES.close();
    clearTerminal();
    expandLogs();

    const status  = document.getElementById('term-status');
    const btnRun  = document.getElementById('btn-run');
    const btnStop = document.getElementById('btn-stop');

    btnRun.disabled  = true;
    btnStop.disabled = false;
    status.textContent = '● running';
    status.className   = 'running';

    currentES = new EventSource(url);

    currentES.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'start') {
        currentRunId = msg.id;
        appendLog(`$ ${msg.cmd}\n`, 'term-cmd');
        appendLog('', 'term-separator', 'hr');
      } else if (msg.type === 'stdout') {
        appendLog(msg.data, 'term-stdout');
      } else if (msg.type === 'stderr') {
        appendLog(msg.data, 'term-stderr');
      } else if (msg.type === 'error') {
        appendLog(msg.data, 'term-error');
      } else if (msg.type === 'done') {
        const ok = msg.code === 0;
        appendLog('', 'term-separator', 'hr');
        appendLog(ok ? `✓ Terminé (code 0)\n` : `✗ Erreur (code ${msg.code})\n`,
                  ok ? 'term-done-ok' : 'term-done-err');
        status.textContent = ok ? '✓ done' : `✗ exit ${msg.code}`;
        status.className   = ok ? 'done' : 'error';
        btnRun.disabled  = false;
        btnStop.disabled = true;
        currentES.close(); currentES = null; currentRunId = null;
      }
    };

    currentES.onerror = async () => {
      let msg = 'Erreur de connexion';
      try {
        const r = await fetch(url);
        if (!r.ok) { const j = await r.json(); msg = j.detail || msg; }
      } catch (_) {}
      status.textContent = `✗ ${msg}`;
      status.className   = 'error';
      appendLog(`\n✗ ${msg}\n`, 'term-error');
      btnRun.disabled  = false;
      btnStop.disabled = true;
      currentES.close(); currentES = null;
    };
  });
}

async function stopRun() {
  if (currentES)    { currentES.close(); currentES = null; }
  if (currentRunId) { await api('DELETE', `/api/run/${currentRunId}`); currentRunId = null; }
  const status = document.getElementById('term-status');
  status.textContent = '■ arrêté';
  status.className   = 'error';
  document.getElementById('btn-run').disabled  = false;
  document.getElementById('btn-stop').disabled = true;
  appendLog('\n■ Processus arrêté\n', 'term-error');
}

// ── Log helpers ───────────────────────────────────────────────────────
function appendLog(text, cls, tag = 'span') {
  const output = document.getElementById('terminal-output');
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (tag !== 'hr') el.textContent = text;
  output.appendChild(el);
  output.scrollTop = output.scrollHeight;
}

function clearTerminal() {
  document.getElementById('terminal-output').innerHTML = '';
  document.getElementById('term-status').textContent = '';
  document.getElementById('term-status').className = '';
}

function expandLogs() {
  document.getElementById('terminal-panel').classList.remove('collapsed');
}

// ── Resize handle ─────────────────────────────────────────────────────
function setupResizeHandle() {
  const handle   = document.getElementById('resize-handle');
  const terminal = document.getElementById('terminal-panel');
  const workArea = document.getElementById('work-area');
  let startY, startH;

  handle.addEventListener('mousedown', (e) => {
    startY = e.clientY;
    startH = terminal.offsetHeight;
    handle.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    e.preventDefault();
  });

  function onMove(e) {
    const dy   = startY - e.clientY;
    const newH = Math.max(30, Math.min(startH + dy, workArea.offsetHeight - 100));
    terminal.style.height = newH + 'px';
    terminal.classList.remove('collapsed');
  }
  function onUp() {
    handle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
  }
}

// ── Modal ─────────────────────────────────────────────────────────────
function prompt_(title, placeholder, cb) {
  const backdrop = document.getElementById('modal-backdrop');
  const input    = document.getElementById('modal-input');
  document.getElementById('modal-title').textContent = title;
  input.value = ''; input.placeholder = placeholder;
  backdrop.classList.remove('hidden');
  input.focus();
  const ok     = () => { backdrop.classList.add('hidden'); cb(input.value.trim()); };
  const cancel = () => backdrop.classList.add('hidden');
  document.getElementById('modal-ok').onclick     = ok;
  document.getElementById('modal-cancel').onclick = cancel;
  input.onkeydown = (e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') cancel(); };
}

function confirmDelete(msg, cb) {
  prompt_(`${msg}\n(Tapez "oui" pour confirmer)`, '', val => {
    if (['oui','yes','1'].includes(val.toLowerCase())) cb();
  });
}

// ── Toast ─────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2500);
}

// ── Cron Jobs ─────────────────────────────────────────────────────────
let _editingCronId = null;

async function loadCronSection() {
  if (!currentProject) return;
  document.getElementById('cron-section').style.display = 'flex';
  await renderCronList();
}

async function renderCronList() {
  const list = document.getElementById('cron-list');
  try {
    const crons = await api('GET', `/api/projects/${currentProject}/crons`);
    list.innerHTML = '';
    if (!crons.length) {
      list.innerHTML = '<div class="cron-empty">Aucun cron. Clique + pour en créer.</div>';
      return;
    }
    crons.forEach(job => {
      const div = document.createElement('div');
      div.className = 'cron-item';
      const statusClass = !job.enabled ? 'off' : job.last_status === 'error' ? 'err' : 'ok';
      const nextLabel = job.next_run
        ? new Date(job.next_run).toLocaleString('fr-FR', { weekday:'short', hour:'2-digit', minute:'2-digit', timeZone:'UTC' }) + ' UTC'
        : '—';
      div.innerHTML = `
        <span class="cron-dot ${statusClass}">●</span>
        <div class="cron-info">
          <span class="cron-name">${job.name}</span>
          <span class="cron-next">${job.script} · prochain: ${nextLabel}</span>
        </div>
        <div class="cron-btns">
          <button class="btn-cron-run"  title="Exécuter maintenant">▶</button>
          <button class="btn-cron-logs" title="Voir les logs">📋</button>
          <button class="btn-cron-edit" title="Modifier">✏</button>
          <button class="btn-cron-del"  title="Supprimer">✕</button>
        </div>`;
      div.querySelector('.btn-cron-run').onclick  = () => runCronNow(job.id, job.name);
      div.querySelector('.btn-cron-logs').onclick = () => openCronLogs(job.id, job.name);
      div.querySelector('.btn-cron-edit').onclick = () => openCronModal(job);
      div.querySelector('.btn-cron-del').onclick  = () =>
        confirmDelete(`Supprimer le cron "${job.name}" ?`, async () => {
          await api('DELETE', `/api/projects/${currentProject}/crons/${job.id}`);
          toast('Cron supprimé', 'success');
          await renderCronList();
        });
      list.appendChild(div);
    });
  } catch { list.innerHTML = ''; }
}

async function runCronNow(jobId, name) {
  try {
    await api('POST', `/api/projects/${currentProject}/crons/${jobId}/run`);
    toast(`▶ ${name} lancé`, 'success');
    setTimeout(renderCronList, 2000);
  } catch (e) { toast(e.message, 'error'); }
}

async function openCronLogs(jobId, name) {
  document.getElementById('cron-logs-title').textContent = `Logs — ${name}`;
  document.getElementById('cron-logs-body').innerHTML = '<div style="padding:12px;color:var(--muted)">Chargement…</div>';
  document.getElementById('cron-logs-backdrop').classList.remove('hidden');
  try {
    const logs = await api('GET', `/api/projects/${currentProject}/crons/${jobId}/logs`);
    const body = document.getElementById('cron-logs-body');
    if (!logs.length) { body.innerHTML = '<div class="cron-log-empty">Aucun log pour ce cron.</div>'; return; }
    body.innerHTML = logs.map(l => `
      <div class="cron-log-entry ${l.status}">
        <div class="cron-log-meta">
          <span class="cron-log-status">${l.status === 'ok' ? '✓' : '✗'} ${l.status}</span>
          <span class="cron-log-date">${new Date(l.ran_at).toLocaleString('fr-FR')}</span>
          <span class="cron-log-code">exit ${l.exit_code}</span>
        </div>
        <pre class="cron-log-output">${escHtml(l.output || '(no output)')}</pre>
      </div>`).join('');
  } catch { document.getElementById('cron-logs-body').innerHTML = '<div style="padding:12px;color:var(--danger)">Erreur</div>'; }
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

document.getElementById('btn-cron-logs-close').onclick = () =>
  document.getElementById('cron-logs-backdrop').classList.add('hidden');
document.getElementById('cron-logs-backdrop').onclick = (e) => {
  if (e.target === document.getElementById('cron-logs-backdrop'))
    document.getElementById('cron-logs-backdrop').classList.add('hidden');
};

// Schedule type toggle
document.getElementById('cron-sched-type').onchange = () => updateCronSchedUI();
function updateCronSchedUI() {
  const type = document.getElementById('cron-sched-type').value;
  document.getElementById('cron-params-time').style.display     = (type === 'daily' || type === 'weekly') ? 'flex' : 'none';
  document.getElementById('cron-params-interval').style.display = type === 'interval' ? 'flex' : 'none';
  document.getElementById('cron-params-cron').style.display     = type === 'cron' ? 'flex' : 'none';
  document.getElementById('cron-day-wrap').style.display        = type === 'weekly' ? 'flex' : 'none';
}
updateCronSchedUI();

async function openCronModal(job = null) {
  _editingCronId = job ? job.id : null;
  document.getElementById('cron-modal-title').textContent = job ? '✏ Modifier le cron' : '⏰ Nouveau cron job';

  // Populate script dropdown with .py and .js files from project
  const scriptSel = document.getElementById('cron-script');
  scriptSel.innerHTML = '';
  try {
    const tree = await api('GET', `/api/projects/${currentProject}/tree`);
    const files = flattenTree(tree.children, '');
    const scripts = files.filter(f => /\.(py|js|mjs)$/.test(f));
    if (!scripts.length) scriptSel.innerHTML = '<option disabled>Aucun script .py/.js dans ce projet</option>';
    else scripts.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; scriptSel.appendChild(o); });
  } catch {}

  if (job) {
    document.getElementById('cron-name').value = job.name;
    scriptSel.value = job.script;
    document.getElementById('cron-sched-type').value = job.schedule.type || 'daily';
    document.getElementById('cron-sched-day').value  = job.schedule.day    || 'mon';
    document.getElementById('cron-sched-hour').value   = job.schedule.hour   ?? 9;
    document.getElementById('cron-sched-minute').value = job.schedule.minute ?? 0;
    document.getElementById('cron-sched-minutes').value = job.schedule.minutes || 60;
    document.getElementById('cron-sched-expr').value    = job.schedule.expression || '';
    document.getElementById('cron-enabled').checked = job.enabled !== false;
  } else {
    document.getElementById('cron-name').value = '';
    document.getElementById('cron-sched-type').value = 'daily';
    document.getElementById('cron-sched-hour').value = '9';
    document.getElementById('cron-sched-minute').value = '0';
    document.getElementById('cron-enabled').checked = true;
  }
  updateCronSchedUI();
  document.getElementById('cron-backdrop').classList.remove('hidden');
}

function flattenTree(children, prefix) {
  const files = [];
  (children || []).forEach(node => {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.type === 'file') files.push(path);
    else files.push(...flattenTree(node.children, path));
  });
  return files;
}

function cronFormData() {
  const type = document.getElementById('cron-sched-type').value;
  const schedule = { type };
  if (type === 'daily') {
    schedule.hour   = parseInt(document.getElementById('cron-sched-hour').value, 10);
    schedule.minute = parseInt(document.getElementById('cron-sched-minute').value, 10);
  } else if (type === 'weekly') {
    schedule.day    = document.getElementById('cron-sched-day').value;
    schedule.hour   = parseInt(document.getElementById('cron-sched-hour').value, 10);
    schedule.minute = parseInt(document.getElementById('cron-sched-minute').value, 10);
  } else if (type === 'interval') {
    schedule.minutes = parseInt(document.getElementById('cron-sched-minutes').value, 10);
  } else if (type === 'cron') {
    schedule.expression = document.getElementById('cron-sched-expr').value.trim();
  }
  return {
    name:     document.getElementById('cron-name').value.trim(),
    script:   document.getElementById('cron-script').value,
    schedule,
    enabled:  document.getElementById('cron-enabled').checked,
  };
}

document.getElementById('btn-new-cron').onclick = () => openCronModal();
document.getElementById('btn-cron-cancel').onclick = () =>
  document.getElementById('cron-backdrop').classList.add('hidden');
document.getElementById('cron-backdrop').onclick = (e) => {
  if (e.target === document.getElementById('cron-backdrop'))
    document.getElementById('cron-backdrop').classList.add('hidden');
};

document.getElementById('btn-cron-save').onclick = async () => {
  const data = cronFormData();
  if (!data.name)   { toast('Nom requis', 'error'); return; }
  if (!data.script) { toast('Script requis', 'error'); return; }
  try {
    if (_editingCronId) {
      await api('PUT', `/api/projects/${currentProject}/crons/${_editingCronId}`, data);
      toast('Cron mis à jour ✓', 'success');
    } else {
      await api('POST', `/api/projects/${currentProject}/crons`, data);
      toast('Cron créé ✓', 'success');
    }
    document.getElementById('cron-backdrop').classList.add('hidden');
    await renderCronList();
  } catch (e) { toast(e.message, 'error'); }
};

// ── Email / SMTP ───────────────────────────────────────────────────────
async function loadEmailStatus() {
  if (!currentProject) return;
  const statusEl = document.getElementById('email-status');
  try {
    const cfg = await api('GET', `/api/projects/${currentProject}/smtp`);
    const configured = !!(cfg.host);
    statusEl.innerHTML = configured
      ? `<div class="email-status-ok">✓ ${cfg.from_email || cfg.username || cfg.host}</div>`
      : `<div class="email-status-hint">Clique ⚙ pour configurer un serveur SMTP</div>`;
  } catch {
    statusEl.innerHTML = '';
  }
}

document.getElementById('btn-email-config').onclick = () => openSmtpModal();

async function openSmtpModal() {
  const backdrop = document.getElementById('smtp-backdrop');
  backdrop.classList.remove('hidden');

  // Load existing config
  try {
    const cfg = await api('GET', `/api/projects/${currentProject}/smtp`);
    document.getElementById('smtp-host').value       = cfg.host       || '';
    document.getElementById('smtp-port').value       = cfg.port       || 587;
    document.getElementById('smtp-user').value       = cfg.username   || '';
    document.getElementById('smtp-pass').value       = cfg.password   || '';
    document.getElementById('smtp-from-name').value  = cfg.from_name  || '';
    document.getElementById('smtp-from-email').value = cfg.from_email || '';
    document.getElementById('smtp-tls').checked      = cfg.tls !== false;
    document.getElementById('smtp-ssl').checked      = !!cfg.ssl;
    document.getElementById('smtp-test-to').value    = cfg.test_email || cfg.from_email || '';
  } catch { /* fresh config */ }
}

function closeSmtpModal() {
  document.getElementById('smtp-backdrop').classList.add('hidden');
}

function smtpFormData() {
  return {
    host:       document.getElementById('smtp-host').value.trim(),
    port:       parseInt(document.getElementById('smtp-port').value, 10) || 587,
    username:   document.getElementById('smtp-user').value.trim(),
    password:   document.getElementById('smtp-pass').value,
    from_name:  document.getElementById('smtp-from-name').value.trim(),
    from_email: document.getElementById('smtp-from-email').value.trim(),
    tls:        document.getElementById('smtp-tls').checked,
    ssl:        document.getElementById('smtp-ssl').checked,
    test_email: document.getElementById('smtp-test-to').value.trim(),
  };
}

document.getElementById('btn-smtp-cancel').onclick = closeSmtpModal;

document.getElementById('btn-smtp-save').onclick = async () => {
  const data = smtpFormData();
  if (!data.host) { toast('Hôte SMTP requis', 'error'); return; }
  try {
    await api('PUT', `/api/projects/${currentProject}/smtp`, data);
    toast('Config SMTP sauvegardée ✓', 'success');
    closeSmtpModal();
    await loadEmailStatus();
  } catch (e) {
    toast(e.message, 'error');
  }
};

document.getElementById('btn-smtp-test').onclick = async () => {
  // Save first, then test
  const data = smtpFormData();
  if (!data.host) { toast('Hôte SMTP requis', 'error'); return; }
  const btn = document.getElementById('btn-smtp-test');
  btn.textContent = '…'; btn.disabled = true;
  try {
    await api('PUT', `/api/projects/${currentProject}/smtp`, data);
    const to = document.getElementById('smtp-test-to').value.trim() || data.from_email;
    await api('POST', `/api/projects/${currentProject}/smtp/test`, { to });
    toast(`Email de test envoyé ✓`, 'success');
    await loadEmailStatus();
  } catch (e) {
    toast(e.message || 'Erreur SMTP', 'error');
  } finally {
    btn.textContent = '✉ Tester'; btn.disabled = false;
  }
};

document.getElementById('btn-smtp-diagnose').onclick = async () => {
  const data = smtpFormData();
  if (!data.host) { toast('Hôte SMTP requis', 'error'); return; }
  const btn = document.getElementById('btn-smtp-diagnose');
  const diagEl = document.getElementById('smtp-diag-result');
  btn.textContent = '…'; btn.disabled = true;
  diagEl.innerHTML = '<div class="diag-loading">Diagnostic en cours…</div>';
  try {
    await api('PUT', `/api/projects/${currentProject}/smtp`, data);
    const to = document.getElementById('smtp-test-to').value.trim() || data.from_email;
    const res = await api('POST', `/api/projects/${currentProject}/smtp/diagnose`, { to });
    diagEl.innerHTML = res.steps.map(s => `
      <div class="diag-step ${s.ok ? 'ok' : 'fail'}">
        <span class="diag-icon">${s.ok ? '✓' : '✗'}</span>
        <span class="diag-name">${s.step}</span>
        <span class="diag-detail">${s.detail}</span>
      </div>`).join('');
  } catch (e) {
    diagEl.innerHTML = `<div class="diag-step fail"><span class="diag-icon">✗</span><span class="diag-detail">${e.message}</span></div>`;
  } finally {
    btn.textContent = '🔍'; btn.disabled = false;
  }
};

// Close SMTP modal on backdrop click
document.getElementById('smtp-backdrop').onclick = (e) => {
  if (e.target === document.getElementById('smtp-backdrop')) closeSmtpModal();
};

// STARTTLS / SSL mutual exclusion
document.getElementById('smtp-tls').onchange = (e) => {
  if (e.target.checked) document.getElementById('smtp-ssl').checked = false;
};
document.getElementById('smtp-ssl').onchange = (e) => {
  if (e.target.checked) document.getElementById('smtp-tls').checked = false;
};

