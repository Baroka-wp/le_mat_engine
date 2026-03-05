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
    base: 'vs', inherit: true, rules: [],
    colors: {
      'editor.background': '#fafafa',
      'editor.foreground': '#18181b',
      'editorLineNumber.foreground': '#a1a1aa',
      'editorGutter.background': '#f4f4f5',
      'editor.selectionBackground': '#e4e4e7',
      'editor.lineHighlightBackground': '#f4f4f5',
    },
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
  showDashboard(); // Démarrer sur le dashboard
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

// ── Navigation Dashboard / Éditeur ───────────────────────────────────
function showDashboard() {
  document.getElementById('view-dashboard').style.display = 'flex';
  document.getElementById('view-editor').style.display = 'none';
  loadDashboard();
}

function showEditor() {
  document.getElementById('view-dashboard').style.display = 'none';
  document.getElementById('view-editor').style.display = 'flex';
}

// ── Dashboard — grille de projets ────────────────────────────────────
async function loadDashboard() {
  const projects = await api('GET', '/api/projects').catch(() => []);
  const grid = document.getElementById('projects-grid');
  grid.innerHTML = '';

  projects.forEach(p => {
    const initials = p.name.slice(0, 2).toUpperCase();
    const card = document.createElement('div');
    card.className = 'project-card';
    card.innerHTML = `
      <div class="card-avatar">${initials}</div>
      <div class="card-body">
        <div class="card-name">${p.name}</div>
        <div class="card-desc">${p.description || ''}</div>
      </div>
      <div class="card-footer">
        <div class="card-actions">
          <button class="card-btn danger" title="Supprimer">✕</button>
        </div>
        <button class="card-open-btn">Ouvrir</button>
      </div>`;
    card.querySelector('.card-open-btn').onclick = (e) => { e.stopPropagation(); openProject(p.name); };
    card.querySelector('.card-btn.danger').onclick = (e) => {
      e.stopPropagation();
      confirmDelete(`Supprimer le projet "${p.name}" ?`, () => deleteProject(p.name));
    };
    card.addEventListener('dblclick', () => openProject(p.name));
    grid.appendChild(card);
  });

  // Carte "+ Nouveau"
  const addCard = document.createElement('div');
  addCard.className = 'project-card-new';
  addCard.innerHTML = `<div class="new-icon">+</div><span>Nouveau projet</span>`;
  addCard.onclick = openNewProjectModal;
  grid.appendChild(addCard);
}

function openProject(name) {
  currentProject = name;
  showEditor();
  document.getElementById('current-project-name').textContent = name;
  document.getElementById('filetree-section').style.display = 'flex';
  document.getElementById('email-section').style.display = 'flex';
  Promise.all([loadTree(), loadDbSection(), loadEmailStatus(), loadCronSection()]);
  document.querySelectorAll('#project-list li').forEach(li =>
    li.classList.toggle('active', li.dataset.name === name));
}

// ── Nouveau projet modal ──────────────────────────────────────────────
function openNewProjectModal() {
  document.getElementById('new-proj-name').value = '';
  document.getElementById('new-proj-desc').value = '';
  document.getElementById('new-proj-backdrop').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-proj-name').focus(), 50);
}

function closeNewProjectModal() {
  document.getElementById('new-proj-backdrop').classList.add('hidden');
}

document.getElementById('btn-new-proj-close').onclick = closeNewProjectModal;
document.getElementById('btn-new-proj-cancel').onclick = closeNewProjectModal;
document.getElementById('btn-new-proj-ok').onclick = async () => {
  const name = document.getElementById('new-proj-name').value.trim();
  const description = document.getElementById('new-proj-desc').value.trim();
  if (!name) { toast('Le nom est requis', 'error'); return; }
  try {
    await api('POST', `/api/projects/${encodeURIComponent(name)}`,
      { description, icon: '' });
    closeNewProjectModal();
    toast(`Projet "${name}" créé ✓`, 'success');
    await loadProjects(); // sync sidebar list
    openProject(name);
  } catch(e) { toast(e.message, 'error'); }
};
document.getElementById('new-proj-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-new-proj-ok').click();
});

// Bouton dashboard header
document.getElementById('btn-new-project-dash').onclick = openNewProjectModal;
document.getElementById('btn-import-project-dash').onclick = () =>
  document.getElementById('import-project-input-dash').click();
document.getElementById('import-project-input-dash').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  try {
    const res = await fetch('/api/projects/import', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail);
    toast(`Projet importé : ${data.project} ✓`, 'success');
    await loadDashboard();
    e.target.value = '';
  } catch(err) { toast(err.message, 'error'); e.target.value = ''; }
};

// Bouton retour dans l'éditeur
document.getElementById('btn-back-dashboard').onclick = () => showDashboard();

// ── Projects (sidebar list sync) ──────────────────────────────────────
async function loadProjects() {
  const projects = await api('GET', '/api/projects').catch(() => []);
  const ul = document.getElementById('project-list');
  ul.innerHTML = '';
  projects.forEach(p => {
    const li = document.createElement('li');
    li.dataset.name = p.name;
    li.innerHTML = `
      <span class="project-name">${p.icon || '📦'} ${p.name}</span>
      <button class="btn-delete-project" title="Supprimer">🗑</button>`;
    li.querySelector('.project-name').onclick = () => openProject(p.name);
    li.querySelector('.btn-delete-project').onclick = (ev) => {
      ev.stopPropagation();
      confirmDelete(`Supprimer le projet "${p.name}" ?`, () => deleteProject(p.name));
    };
    if (p.name === currentProject) li.classList.add('active');
    ul.appendChild(li);
  });
}

async function deleteProject(name) {
  await api('DELETE', `/api/projects/${encodeURIComponent(name)}`);
  if (currentProject === name) {
    currentProject = null; tabs = []; activeTab = null;
    renderTabs(); showWelcome();
    document.getElementById('filetree-section').style.display = 'none';
    document.getElementById('email-section').style.display = 'none';
    showDashboard();
  } else {
    loadDashboard();
  }
  await loadProjects();
  toast('Projet supprimé', 'success');
}

document.getElementById('btn-new-project').onclick = openNewProjectModal;

// ── Export project ────────────────────────────────────────────────────────────
document.getElementById('btn-export-project').onclick = () => {
  if (!currentProject) return;
  const a = document.createElement('a');
  a.href = `/api/projects/${encodeURIComponent(currentProject)}/export`;
  a.download = `${currentProject}.zip`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast(`Export de "${currentProject}" lancé ✓`, 'success');
};

// ── Deploy project ────────────────────────────────────────────────────────────
document.getElementById('btn-deploy-project').onclick = () => {
  if (!currentProject) return;
  openDeployModal();
};

async function openDeployModal() {
  document.getElementById('deploy-backdrop').classList.remove('hidden');
  document.getElementById('deploy-project-name').textContent = currentProject;

  // Reset complet des champs avant de charger les données du projet
  const customDomainInput = document.getElementById('custom-domain');
  if (customDomainInput) customDomainInput.value = '';
  const customDomainUrlInput = document.getElementById('custom-domain-url');
  if (customDomainUrlInput) customDomainUrlInput.value = '';
  const deployUrlEl = document.getElementById('deploy-url');
  if (deployUrlEl) deployUrlEl.value = '';

  // Reset sections visibilité
  const notDeployed = document.getElementById('not-deployed');
  const deployedSection = document.getElementById('deployed-section');
  const domainNotConfigured = document.getElementById('domain-not-configured');
  const domainConfigured = document.getElementById('domain-configured');
  const dnsPending = document.getElementById('dns-pending');
  const dnsVerified = document.getElementById('dns-verified');
  if (notDeployed) notDeployed.style.display = 'block';
  if (deployedSection) deployedSection.style.display = 'none';
  if (domainNotConfigured) domainNotConfigured.style.display = 'block';
  if (domainConfigured) domainConfigured.style.display = 'none';
  if (dnsPending) dnsPending.style.display = 'none';
  if (dnsVerified) dnsVerified.style.display = 'none';

  // Reset onglets DNS
  document.querySelectorAll('.dns-tab').forEach((t, i) => {
    t.classList.toggle('active', i === 0);
  });

  // Event listeners (rebind each time to avoid duplicates via onclick)
  document.getElementById('btn-deploy-close').onclick = closeDeployModal;
  document.getElementById('btn-deploy-cancel').onclick = closeDeployModal;
  document.getElementById('btn-deploy-create').onclick = createDeployment;
  document.getElementById('btn-deploy-undeploy').onclick = undeployProject;
  document.getElementById('btn-deploy-copy').onclick = () => copyDeployUrl();
  document.getElementById('btn-domain-save').onclick = saveCustomDomain;
  document.getElementById('btn-dns-verify').onclick = verifyDns;

  await loadDeploymentInfo();
}

function closeDeployModal() {
  document.getElementById('deploy-backdrop').classList.add('hidden');
}

function _applyDnsTab(type) {
  const typeEl   = document.getElementById('dns-type');
  const valueEl  = document.getElementById('dns-value');
  const labelEl  = document.getElementById('dns-value-label');
  const hintEl   = document.getElementById('dns-hint-text');
  if (!typeEl) return;

  if (type === 'CNAME') {
    typeEl.textContent  = 'CNAME';
    valueEl.textContent = window._dnsCnameValue || '—';
    labelEl.textContent = 'Valeur / Cible (CNAME)';
    if (hintEl) hintEl.textContent = 'Utilisez CNAME pour un sous-domaine (ex: app.example.com). La propagation DNS peut prendre jusqu\'à 48h.';
  } else {
    typeEl.textContent  = 'A';
    valueEl.textContent = window._dnsAValue || '—';
    labelEl.textContent = 'Valeur / IP cible';
    if (hintEl) hintEl.textContent = 'Utilisez un enregistrement A pour un domaine racine (ex: example.com). La propagation DNS peut prendre jusqu\'à 48h.';
  }
}

async function loadDeploymentInfo() {
  const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/deploy`);
  const data = await res.json();

  if (!data.deployed) {
    document.getElementById('deploy-not-deployed').style.display = 'block';
    document.getElementById('deploy-active').style.display = 'none';
    return;
  }

  document.getElementById('deploy-not-deployed').style.display = 'none';
  document.getElementById('deploy-active').style.display = 'block';

  // Lien public
  document.getElementById('deploy-url').value = data.deploy_url;
  const openBtn = document.getElementById('btn-deploy-open');
  if (openBtn) openBtn.href = data.deploy_url;

  // Date de mise en ligne
  if (data.created_at) {
    const date = new Date(data.created_at);
    document.getElementById('deploy-date').textContent =
      'Publié le ' + date.toLocaleDateString('fr-FR', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
  }

  // Domaine personnalisé
  const domainNotConfigured = document.getElementById('domain-not-configured');
  const domainConfigured = document.getElementById('domain-configured');
  const dnsPending = document.getElementById('dns-pending');
  const dnsVerified = document.getElementById('dns-verified');

  if (data.custom_domain) {
    domainNotConfigured.style.display = 'none';
    domainConfigured.style.display = 'block';
    document.getElementById('configured-domain').textContent = data.custom_domain;

    // Re-bind remove button (may appear in two places)
    document.querySelectorAll('#btn-domain-remove').forEach(btn => {
      btn.onclick = removeCustomDomain;
    });

    if (data.dns_configured) {
      dnsPending.style.display = 'none';
      dnsVerified.style.display = 'block';
      document.getElementById('domain-status-badge').className = 'status-badge success';
      document.getElementById('domain-status-badge').textContent = '● Actif';
      const customUrl = `https://${data.custom_domain}`;
      document.getElementById('custom-domain-url').value = customUrl;
      document.getElementById('btn-custom-open').href = customUrl;
    } else {
      dnsPending.style.display = 'block';
      dnsVerified.style.display = 'none';
      document.getElementById('domain-status-badge').className = 'status-badge pending';
      document.getElementById('domain-status-badge').textContent = '● En attente DNS';
      // Remplir les infos DNS (A et CNAME)
      let serverHost = window.location.hostname;
      try { serverHost = new URL(data.deploy_url).hostname; } catch {}

      document.getElementById('dns-name').textContent = data.custom_domain;
      window._dnsAValue = serverHost;
      window._dnsCnameValue = serverHost;

      // Afficher A par défaut
      _applyDnsTab('A');

      // Onglets A / CNAME
      document.querySelectorAll('.dns-tab').forEach(tab => {
        tab.onclick = () => {
          document.querySelectorAll('.dns-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          _applyDnsTab(tab.dataset.dns);
        };
      });
    }
  } else {
    domainNotConfigured.style.display = 'block';
    domainConfigured.style.display = 'none';
  }
}

async function createDeployment() {
  const btn = document.getElementById('btn-deploy-create');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> Publication en cours...';

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/deploy`, { method: 'POST' });
    const data = await res.json();

    if (res.ok) {
      toast('Projet publié ! Lien généré ✓', 'success');
      await loadDeploymentInfo();
    } else {
      toast(`Erreur : ${data.message || data.detail}`, 'error');
    }
  } catch (err) {
    toast(`Erreur : ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

async function undeployProject() {
  if (!confirm('⚠️ Dépublier ce projet ?\n\nLe lien ne sera plus accessible.')) return;

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/deploy`, { method: 'DELETE' });
    const data = await res.json();

    if (res.ok) {
      toast('Projet dépublié', 'success');
      await loadDeploymentInfo();
    } else {
      toast(`Erreur : ${data.message || data.detail}`, 'error');
    }
  } catch (err) {
    toast(`Erreur : ${err.message}`, 'error');
  }
}

async function saveCustomDomain() {
  const domain = document.getElementById('custom-domain').value.trim().toLowerCase();

  if (!domain) { toast('Veuillez entrer un domaine', 'error'); return; }

  const domainRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
  if (!domainRegex.test(domain)) { toast('Nom de domaine invalide', 'error'); return; }

  const btn = document.getElementById('btn-domain-save');
  btn.disabled = true;
  btn.textContent = 'Configuration...';

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/deploy/domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain }),
    });
    const data = await res.json();

    if (res.ok) {
      toast('Domaine configuré !', 'success');
      await loadDeploymentInfo();
    } else {
      toast(`Erreur : ${data.message || data.detail}`, 'error');
    }
  } catch (err) {
    toast(`Erreur : ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Configurer';
  }
}

async function removeCustomDomain() {
  if (!confirm('Retirer ce domaine personnalisé ?')) return;

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/deploy/domain`, { method: 'DELETE' });
    const data = await res.json();

    if (res.ok) {
      toast('Domaine retiré', 'success');
      await loadDeploymentInfo();
    } else {
      toast(`Erreur : ${data.message || data.detail}`, 'error');
    }
  } catch (err) {
    toast(`Erreur : ${err.message}`, 'error');
  }
}

async function verifyDns() {
  const btn = document.getElementById('btn-dns-verify');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> Validation...';

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/deploy/verify`);
    const data = await res.json();

    if (res.ok) {
      toast('Domaine validé et actif !', 'success');
      await loadDeploymentInfo();
    } else {
      toast(`Erreur : ${data.message || data.detail}`, 'error');
    }
  } catch (err) {
    toast(`Erreur : ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

function copyDeployUrl() {
  const input = document.getElementById('deploy-url');
  if (!input) return;
  navigator.clipboard.writeText(input.value).then(() => {
    toast('Lien copié !', 'success');
  }).catch(() => {
    input.select();
    document.execCommand('copy');
    toast('Lien copié !', 'success');
  });
}

function copyToClipboard(elementId) {
  const input = document.getElementById(elementId);
  if (!input) return;
  navigator.clipboard.writeText(input.value).then(() => {
    toast('Copié !', 'success');
  }).catch(() => {
    input.select();
    document.execCommand('copy');
    toast('Copié !', 'success');
  });
}

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
  openProject(name);
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

