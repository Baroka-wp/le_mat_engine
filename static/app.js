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

async function selectProject(name) {
  currentProject = name;
  document.querySelectorAll('#project-list li').forEach(li =>
    li.classList.toggle('active', li.dataset.name === name));
  document.getElementById('current-project-name').textContent = name;
  document.getElementById('filetree-section').style.display = 'flex';
  await loadTree();
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
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.style.display = 'none';
  document.getElementById('monaco-container').style.display = 'block';
  editor.setModel(tab.model);
  editor.layout();
  editor.focus();
}

function showWelcome() {
  document.getElementById('monaco-container').style.display = 'none';
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
  tabs[idx].model.dispose();
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
