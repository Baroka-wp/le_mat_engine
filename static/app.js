/* ── Le Mat — frontend ──────────────────────────────────────────────── */
const API = '';

// ── State ────────────────────────────────────────────────────────────
let currentProject = null;
let editor         = null;
let tabs           = [];
let activeTab      = null;
let currentRunId   = null;
let currentES      = null;
let _svStatusEl    = null;   // référence vers le <span> statut du Schema Visual Editor

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

/** Désactive `btn`, affiche `loadingHtml`, exécute `fn`, puis restaure. */
async function withLoading(btn, loadingHtml, fn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = loadingHtml;
  try { await fn(); } finally { btn.disabled = false; btn.innerHTML = original; }
}

/** POST d'un FormData (upload/import) — retourne les données JSON ou lève une erreur. */
async function apiUpload(path, formData) {
  const res = await fetch(path, { method: 'POST', body: formData });
  const data = await res.json().catch(() => ({ detail: res.statusText }));
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
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
    const avatar = p.icon || '📦';
    const card = document.createElement('div');
    card.className = 'project-card';
    card.innerHTML = `
      <div class="card-top">
        <div class="card-avatar">${avatar}</div>
        <div class="card-menu-wrap">
          <button class="card-menu-btn" title="Options">⋮</button>
          <div class="card-dropdown hidden">
            <button class="card-dd-item" data-action="edit">✎ &nbsp;Modifier</button>
            <button class="card-dd-item danger" data-action="delete">✕ &nbsp;Supprimer</button>
          </div>
        </div>
      </div>
      <div class="card-body">
        <div class="card-name">${p.name}</div>
        <div class="card-desc">${p.description || ''}</div>
      </div>
      <div class="card-footer">
        <button class="card-open-btn">Ouvrir →</button>
      </div>`;

    // Ouvrir
    card.querySelector('.card-open-btn').onclick = (e) => { e.stopPropagation(); openProject(p.name); };
    card.addEventListener('dblclick', () => openProject(p.name));

    // Menu ⋮
    const menuBtn  = card.querySelector('.card-menu-btn');
    const dropdown = card.querySelector('.card-dropdown');
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      // Fermer tous les autres dropdowns
      document.querySelectorAll('.card-dropdown:not(.hidden)').forEach(d => {
        if (d !== dropdown) d.classList.add('hidden');
      });
      dropdown.classList.toggle('hidden');
    };

    // Items du dropdown
    dropdown.querySelector('[data-action="edit"]').onclick = (e) => {
      e.stopPropagation();
      dropdown.classList.add('hidden');
      openEditProjectModal(p);
    };
    dropdown.querySelector('[data-action="delete"]').onclick = (e) => {
      e.stopPropagation();
      dropdown.classList.add('hidden');
      confirmDelete(`Supprimer le projet "${p.name}" ?`, () => deleteProject(p.name));
    };

    grid.appendChild(card);
  });

  // Fermer les dropdowns au clic ailleurs
  document.addEventListener('click', () => {
    document.querySelectorAll('.card-dropdown:not(.hidden)').forEach(d => d.classList.add('hidden'));
  }, { once: true });

  // Carte "+ Nouveau"
  const addCard = document.createElement('div');
  addCard.className = 'project-card-new';
  addCard.innerHTML = `<div class="new-icon">+</div><span>Nouveau projet</span>`;
  addCard.onclick = openNewProjectModal;
  grid.appendChild(addCard);
}

// ── Edit Project Modal ─────────────────────────────────────────────
let _editingProject = null;

function openEditProjectModal(p) {
  _editingProject = p;
  document.getElementById('edit-proj-name').value = p.name;
  document.getElementById('edit-proj-icon').value = p.icon || '';
  document.getElementById('edit-proj-desc').value = p.description || '';
  document.getElementById('edit-proj-backdrop').classList.remove('hidden');
  setTimeout(() => document.getElementById('edit-proj-name').focus(), 50);
}

function closeEditProjectModal() {
  document.getElementById('edit-proj-backdrop').classList.add('hidden');
  _editingProject = null;
}

document.getElementById('btn-edit-proj-close').onclick  = closeEditProjectModal;
document.getElementById('btn-edit-proj-cancel').onclick = closeEditProjectModal;
document.getElementById('btn-edit-proj-ok').onclick = async () => {
  if (!_editingProject) return;
  const oldName = _editingProject.name;
  const newName = document.getElementById('edit-proj-name').value.trim();
  const icon    = document.getElementById('edit-proj-icon').value.trim();
  const desc    = document.getElementById('edit-proj-desc').value.trim();
  if (!newName) { toast('Le nom est requis', 'error'); return; }
  try {
    // 1. Renommer si nécessaire
    let effectiveName = oldName;
    if (newName !== oldName) {
      const d = await api('POST', `/api/projects/${encodeURIComponent(oldName)}/rename`, { name: newName });
      effectiveName = d.project;
    }
    // 2. Mettre à jour icon + description
    await api('PUT', `/api/projects/${encodeURIComponent(effectiveName)}/meta`, { icon, description: desc });
    closeEditProjectModal();
    toast(`Projet "${effectiveName}" mis à jour ✓`, 'success');
    await Promise.all([loadProjects(), loadDashboard()]);
  } catch(e) { toast(e.message, 'error'); }
};
document.getElementById('edit-proj-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-edit-proj-ok').click();
  if (e.key === 'Escape') closeEditProjectModal();
});

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
document.getElementById('btn-import-project-dash').onclick = () => {
  document.getElementById('import-project-input-dash').value = '';
  document.getElementById('import-project-input-dash').click();
};
document.getElementById('import-project-input-dash').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const suggested = file.name.replace(/\.zip$/i, '');
  prompt_('Nom du projet à importer', suggested, async (name) => {
    if (!name) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('name', name);
    try {
      const data = await apiUpload('/api/projects-import', fd);
      toast(`Projet importé : ${data.project} ✓`, 'success');
      await loadDashboard();
    } catch(err) { toast(err.message, 'error'); }
    e.target.value = '';
  });
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
  const data = await api('GET', `/api/projects/${encodeURIComponent(currentProject)}/deploy`);

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
  await withLoading(btn, '<span class="btn-icon">⏳</span> Publication en cours...', async () => {
    try {
      await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/deploy`);
      toast('Projet publié ! Lien généré ✓', 'success');
      await loadDeploymentInfo();
    } catch (err) { toast(`Erreur : ${err.message}`, 'error'); }
  });
}

async function undeployProject() {
  if (!confirm('⚠️ Dépublier ce projet ?\n\nLe lien ne sera plus accessible.')) return;
  try {
    await api('DELETE', `/api/projects/${encodeURIComponent(currentProject)}/deploy`);
    toast('Projet dépublié', 'success');
    await loadDeploymentInfo();
  } catch (err) { toast(`Erreur : ${err.message}`, 'error'); }
}

async function saveCustomDomain() {
  const domain = document.getElementById('custom-domain').value.trim().toLowerCase();
  if (!domain) { toast('Veuillez entrer un domaine', 'error'); return; }
  const domainRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
  if (!domainRegex.test(domain)) { toast('Nom de domaine invalide', 'error'); return; }

  const btn = document.getElementById('btn-domain-save');
  await withLoading(btn, 'Configuration...', async () => {
    try {
      await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/deploy/domain`, { domain });
      toast('Domaine configuré !', 'success');
      await loadDeploymentInfo();
    } catch (err) { toast(`Erreur : ${err.message}`, 'error'); }
  });
}

async function removeCustomDomain() {
  if (!confirm('Retirer ce domaine personnalisé ?')) return;
  try {
    await api('DELETE', `/api/projects/${encodeURIComponent(currentProject)}/deploy/domain`);
    toast('Domaine retiré', 'success');
    await loadDeploymentInfo();
  } catch (err) { toast(`Erreur : ${err.message}`, 'error'); }
}

async function verifyDns() {
  const btn = document.getElementById('btn-dns-verify');
  await withLoading(btn, '<span class="btn-icon">⏳</span> Validation...', async () => {
    try {
      await api('GET', `/api/projects/${encodeURIComponent(currentProject)}/deploy/verify`);
      toast('Domaine validé et actif !', 'success');
      await loadDeploymentInfo();
    } catch (err) { toast(`Erreur : ${err.message}`, 'error'); }
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

/** Alias pour la compatibilité avec les anciens appelants. */
function copyDeployUrl() { copyToClipboard('deploy-url'); }

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
      await apiUpload('/api/projects-import', formData);
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
  try {
    const data = await apiUpload(`/api/projects/${currentProject}/upload`, fd);
    await loadTree();
    toast(`${data.uploaded.length} fichier(s) uploadé(s)`, 'success');
  } catch { toast('Erreur upload', 'error'); }
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
    const type = (ext === 'lemat') ? 'lemat' : 'file';
    // .lemat files open in Visual mode by default
    const visualMode = (ext === 'lemat');
    tab = { path, modified: false, model, type, _visualMode: visualMode };
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
  container.querySelectorAll('.data-view, .schema-view').forEach(el => el.remove());
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.style.display = 'none';

  // Show/hide the Visual toggle button for .lemat files
  _updateVisualToggle(tab);

  // Schema visual mode for .lemat files
  if (tab.type === 'lemat' && tab._visualMode) {
    document.getElementById('monaco-container').style.display = 'none';
    showSchemaVisualEditor(tab, container);
    return;
  }
  // Quitter le mode visuel → nettoyer la référence au status
  _svStatusEl = null;
  document.getElementById('monaco-container').style.display = 'block';
  editor.setModel(tab.model);
  editor.layout();
  editor.focus();
}

function _updateVisualToggle(tab) {
  // Le bouton est dans index.html — pas d'injection dynamique
  const btn = document.getElementById('btn-schema-visual');
  if (!btn) return;
  if (tab?.type === 'lemat') {
    btn.style.display = 'inline-block';
    btn.textContent = tab._visualMode ? '📝 Code' : '🔲 Visual';
    btn.title = tab._visualMode ? 'Voir/modifier le code source' : 'Éditeur visuel';
    btn.onclick = () => {
      tab._visualMode = !tab._visualMode;
      showTab(tab);
    };
  } else {
    btn.style.display = 'none';
  }
}

function showWelcome() {
  document.getElementById('monaco-container').style.display = 'none';
  document.getElementById('editor-container').querySelectorAll('.data-view, .schema-view').forEach(el => el.remove());
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.style.display = 'flex';
  // Hide the visual toggle button
  const svToggle = document.getElementById('btn-schema-visual');
  if (svToggle) svToggle.style.display = 'none';
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
  container.querySelectorAll('.data-view, .schema-view').forEach(el => el.remove());

  const LIMIT = 50;
  tab._page = tab._page || 0;
  const offset = tab._page * LIMIT;

  let data;
  try {
    data = await api('GET', `/api/projects/${currentProject}/data/${tab.tableName}?limit=${LIMIT}&offset=${offset}`);
  } catch (e) {
    container.innerHTML = `<div class="data-empty">Erreur: ${e.message}</div>`;
    return;
  }

  // Build column metadata from schema
  const tableInfo = dbSchema?.tables?.find(t => t.name === tab.tableName);
  const colMeta = {}; // colName → {kind, options, pk, label}
  if (tableInfo) {
    tableInfo.columns.forEach(c => {
      colMeta[c.name] = {
        kind:    c.kind    || 'simple',
        options: c.options || [],
        pk:      !!c.pk,
        label:   c.label  || c.name,
      };
    });
  }
  // Detect PK column
  const pkCol = Object.keys(colMeta).find(k => colMeta[k].pk) || null;

  const view = document.createElement('div');
  view.classList.add('data-view');

  // ── Toolbar ────────────────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.classList.add('data-view-toolbar');
  toolbar.innerHTML = `
    <span>🗄 <strong>${tab.tableName}</strong></span>
    <span class="dv-total">${data.total} ligne(s)</span>
    <div style="flex:1"></div>
    <button id="dv-add">＋ Nouvelle ligne</button>
    <button id="dv-refresh">↺</button>`;
  view.appendChild(toolbar);

  // ── Grid ───────────────────────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.classList.add('data-grid-wrap');

  if (!data.rows.length && offset === 0) {
    wrap.innerHTML = '<div class="data-empty">Aucune donnée — cliquez « Nouvelle ligne » pour commencer.</div>';
  } else if (!data.rows.length) {
    wrap.innerHTML = '<div class="data-empty">Fin des données.</div>';
  } else {
    const cols = Object.keys(data.rows[0]);
    const table = document.createElement('table');
    table.classList.add('data-grid');

    // Header
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr>' + cols.map(c => {
      const meta = colMeta[c] || {};
      const badge = meta.pk ? ' <span class="sv-field-pk">PK</span>' : '';
      return `<th>${c}${badge}</th>`;
    }).join('') + '<th style="width:64px"></th></tr>';
    table.appendChild(thead);

    // Rows
    const tbody = document.createElement('tbody');
    data.rows.forEach(row => {
      const tr = document.createElement('tr');
      tr.dataset.rowData = JSON.stringify(row);
      cols.forEach(col => {
        const td = document.createElement('td');
        const val = row[col];
        const meta = colMeta[col] || {};
        if (val === null || val === undefined) {
          td.classList.add('null-val'); td.textContent = '—';
        } else if (meta.pk) {
          td.classList.add('pk-val'); td.textContent = String(val);
        } else if (meta.kind === 'bool') {
          td.innerHTML = val ? '<span class="dv-bool-true">✓</span>' : '<span class="dv-bool-false">✗</span>';
        } else if (meta.kind === 'select' && val) {
          td.innerHTML = `<span class="dv-select-tag">${val}</span>`;
        } else {
          td.textContent = String(val).slice(0, 120);
        }
        tr.appendChild(td);
      });
      // Actions cell
      const actionsTd = document.createElement('td');
      actionsTd.innerHTML = `<span class="row-actions">
        <button class="btn-row-edit" title="Modifier">✎</button>
        <button class="btn-row-del"  title="Supprimer">🗑</button>
      </span>`;
      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    // Edit row
    tbody.addEventListener('click', async (e) => {
      const editBtn = e.target.closest('.btn-row-edit');
      const delBtn  = e.target.closest('.btn-row-del');
      if (!editBtn && !delBtn) return;
      const tr = (editBtn || delBtn).closest('tr');
      const rowData = JSON.parse(tr.dataset.rowData);
      if (editBtn) {
        openRowModal(tab, cols, colMeta, pkCol, rowData, false, () => showDataTab(tab));
      } else if (delBtn) {
        const pkVal = pkCol ? rowData[pkCol] : rowData[cols[0]];
        if (!confirm(`Supprimer la ligne ${pkVal} ?`)) return;
        await api('DELETE', `/api/projects/${currentProject}/data/${tab.tableName}/${pkVal}`);
        tr.remove();
        const totalEl = view.querySelector('.dv-total');
        if (totalEl) totalEl.textContent = `${parseInt(totalEl.textContent) - 1} ligne(s)`;
        toast('Ligne supprimée', 'success');
      }
    });

    wrap.appendChild(table);
  }

  view.appendChild(wrap);

  // ── Pagination ─────────────────────────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(data.total / LIMIT));
  const pagination = document.createElement('div');
  pagination.classList.add('data-pagination');
  pagination.innerHTML = `
    <button id="dv-prev" ${tab._page === 0 ? 'disabled' : ''}>‹ Précédent</button>
    <span class="page-info">Page ${tab._page + 1} / ${totalPages} &nbsp;—&nbsp; ${data.total} lignes</span>
    <button id="dv-next" ${offset + LIMIT >= data.total ? 'disabled' : ''}>Suivant ›</button>`;
  view.appendChild(pagination);

  container.appendChild(view);

  // ── Events ─────────────────────────────────────────────────────────
  toolbar.querySelector('#dv-refresh').onclick = () => showDataTab(tab);
  toolbar.querySelector('#dv-add').onclick = () => {
    const cols2 = tableInfo ? tableInfo.columns.map(c => c.name) : [];
    openRowModal(tab, cols2, colMeta, pkCol, null, true, () => showDataTab(tab));
  };
  pagination.querySelector('#dv-prev').onclick = () => { tab._page--; showDataTab(tab); };
  pagination.querySelector('#dv-next').onclick = () => { tab._page++; showDataTab(tab); };
}


// ── Row add/edit modal ────────────────────────────────────────────────
let _modalCallback = null;

function openRowModal(tab, cols, colMeta, pkCol, rowData, isNew, onDone) {
  _modalCallback = onDone;
  let overlay = document.getElementById('row-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'row-modal-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }

  const editableCols = isNew
    ? cols.filter(c => !(colMeta[c]?.pk && colMeta[c]?.kind !== 'bool')) // exclude PK on new
    : cols;

  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">
        <span>${isNew ? 'Nouvelle ligne' : 'Modifier'} — ${tab.tableName}</span>
        <button id="row-modal-close">×</button>
      </div>
      <form id="row-modal-form">
        ${editableCols.map(col => {
          const meta = colMeta[col] || {};
          const val = rowData ? rowData[col] : '';
          return buildRowField(col, meta, val, isNew);
        }).join('')}
        <div class="modal-actions">
          <button type="button" class="btn-ghost" id="row-modal-cancel">Annuler</button>
          <button type="submit" class="btn-accent">${isNew ? 'Créer' : 'Sauvegarder'}</button>
        </div>
      </form>
    </div>`;

  overlay.classList.remove('hidden');

  overlay.querySelector('#row-modal-close').onclick  = closeRowModal;
  overlay.querySelector('#row-modal-cancel').onclick = closeRowModal;
  overlay.onclick = (e) => { if (e.target === overlay) closeRowModal(); };

  overlay.querySelector('#row-modal-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {};
    editableCols.forEach(col => {
      const meta = colMeta[col] || {};
      if (meta.pk && isNew) return; // let DB assign PK
      const rawVal = fd.get(col);
      if (meta.kind === 'bool') {
        body[col] = overlay.querySelector(`[name="${col}"]`)?.checked ? 1 : 0;
      } else if (rawVal === '' || rawVal === null) {
        body[col] = null;
      } else if (meta.kind === 'number' || col.toLowerCase() === 'id' || meta.pk) {
        body[col] = Number(rawVal) || rawVal;
      } else {
        body[col] = rawVal;
      }
    });
    try {
      if (isNew) {
        await api('POST', `/api/projects/${currentProject}/data/${tab.tableName}`, body);
        toast('Ligne créée ✓', 'success');
      } else {
        const pkVal = pkCol ? rowData[pkCol] : rowData[cols[0]];
        await api('PUT', `/api/projects/${currentProject}/data/${tab.tableName}/${pkVal}`, body);
        toast('Ligne mise à jour ✓', 'success');
      }
      closeRowModal();
      if (_modalCallback) { _modalCallback(); _modalCallback = null; }
    } catch(err) {
      toast(err.message, 'error');
    }
  };
}

function buildRowField(col, meta, val, isNew) {
  const typeHint = meta.label || meta.kind || 'Text';
  const label = `<label>${col} <span class="field-type-hint">${typeHint}</span></label>`;

  if (meta.pk && isNew) return ''; // auto-assigned

  if (meta.kind === 'bool') {
    const checked = val ? 'checked' : '';
    return `<div class="modal-field">${label}
      <div class="checkbox-row">
        <input type="checkbox" name="${col}" ${checked}>
        <span style="font-size:13px;color:var(--muted)">Oui / Non</span>
      </div></div>`;
  }
  if (meta.kind === 'select' && meta.options?.length) {
    const opts = meta.options.map(o =>
      `<option value="${o}" ${o === val ? 'selected' : ''}>${o}</option>`
    ).join('');
    return `<div class="modal-field">${label}
      <select name="${col}"><option value="">—</option>${opts}</select></div>`;
  }
  if (meta.kind === 'textarea') {
    return `<div class="modal-field">${label}
      <textarea name="${col}">${val ?? ''}</textarea></div>`;
  }
  const inputType = {
    date: 'date', datetime: 'datetime-local', email: 'email',
    url: 'url', color: 'color', number: 'number',
  }[meta.kind] || 'text';
  const valAttr = (val !== null && val !== undefined && val !== '') ? ` value="${String(val).replace(/"/g,'&quot;')}"` : '';
  return `<div class="modal-field">${label}
    <input type="${inputType}" name="${col}"${valAttr} placeholder="${meta.label || col}"></div>`;
}

function closeRowModal() {
  const overlay = document.getElementById('row-modal-overlay');
  if (overlay) overlay.classList.add('hidden');
}


// ── Auto-save schema ─────────────────────────────────────────────────
// Appelé après chaque mutation (add/edit/del modèle ou champ).
// Sérialise _parsedModels → Monaco → serveur → sync DB.
async function _autoSaveSchema(tab) {
  if (!currentProject || !tab._parsedModels) return;

  // 1. Mettre Monaco à jour immédiatement (protection anti perte de données)
  const lematText = modelsToLemat(tab._parsedModels);
  tab.model.setValue(lematText);
  tab.modified = false;
  renderTabs();

  // 2. Afficher l'indicateur
  if (_svStatusEl) {
    _svStatusEl.textContent = '⏳ Enregistrement…';
    _svStatusEl.className = 'sv-status';
  }

  // 3. Sauvegarder sur le serveur + synchroniser la DB
  try {
    const result = await api('PUT', `/api/projects/${currentProject}/schema`, {
      content: lematText, auto_sync: true,
    });
    await loadDbSection();
    if (_svStatusEl) {
      // Construire un message résumé de la migration
      const parts = [];
      const mig = result?.migration || {};
      if (mig.created?.length)  parts.push(`+${mig.created.length} table${mig.created.length > 1 ? 's' : ''}`);
      if (mig.dropped?.length)  parts.push(`−${mig.dropped.length} table${mig.dropped.length > 1 ? 's' : ''}`);
      if (mig.altered?.length)  parts.push(`${mig.altered.length} col.`);
      if (mig.rebuilt?.length)  parts.push(`↺ ${mig.rebuilt.join(', ')}`);
      const detail = parts.length ? ` (${parts.join(' · ')})` : '';
      _svStatusEl.textContent = `✓ Sauvegardé${detail}`;
      _svStatusEl.className = 'sv-status ok';
      setTimeout(() => {
        if (_svStatusEl && _svStatusEl.textContent.startsWith('✓'))
          _svStatusEl.textContent = '';
      }, 3000);
    }
  } catch (e) {
    if (_svStatusEl) {
      _svStatusEl.textContent = '✗ ' + e.message;
      _svStatusEl.className = 'sv-status err';
    }
    toast('Erreur schema : ' + e.message, 'error');
  }
}


// ── Schema Visual Editor ──────────────────────────────────────────────

async function showSchemaVisualEditor(tab, container) {
  container.querySelectorAll('.schema-view').forEach(el => el.remove());
  _svStatusEl = null;

  // Si _parsedModels existe déjà (retour depuis Code ou tab switch),
  // l'utiliser directement — ne jamais effacer les ajouts en mémoire.
  // Sinon, parser le contenu Monaco (première ouverture).
  if (!tab._parsedModels) {
    try {
      const content = tab.model.getValue();
      const res = await api('POST', `/api/projects/${currentProject}/schema/validate`,
        { content, auto_sync: false });
      tab._parsedModels = JSON.parse(JSON.stringify(res.models || []));
    } catch {
      tab._parsedModels = [];
    }
  }

  const view = document.createElement('div');
  view.classList.add('schema-view');

  // ── Toolbar ─────────────────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.classList.add('schema-view-toolbar');
  toolbar.innerHTML = `
    <span class="sv-title">📐 ${tab.path.split('/').pop()}</span>
    <span class="sv-status" id="sv-status"></span>`;
  view.appendChild(toolbar);

  // Référence globale pour _autoSaveSchema
  _svStatusEl = toolbar.querySelector('#sv-status');

  // ── Visual panel ────────────────────────────────────────────────────
  const visual = document.createElement('div');
  visual.classList.add('schema-visual-panel');
  visual.id = 'sv-visual-panel';
  view.appendChild(visual);

  container.appendChild(view);

  renderSchemaModels(visual, tab._parsedModels, tab);
}


function renderSchemaModels(container, models, tab) {
  container.innerHTML = '';
  tab._parsedModels = tab._parsedModels || models;

  (tab._parsedModels).forEach((model, mi) => {
    const card = document.createElement('div');
    card.classList.add('sv-model-card');
    card.innerHTML = `
      <div class="sv-model-header">
        <span class="sv-model-name">⬛ ${model.name}</span>
        <div class="sv-model-actions">
          <button title="Renommer" data-action="rename-model" data-mi="${mi}">✎</button>
          <button title="Supprimer" class="danger" data-action="del-model" data-mi="${mi}">✕</button>
        </div>
      </div>
      <div class="sv-field-list" id="sv-fields-${mi}"></div>
      <button class="sv-add-field" data-action="add-field" data-mi="${mi}">＋ Ajouter un champ</button>`;
    container.appendChild(card);

    const fieldList = card.querySelector(`#sv-fields-${mi}`);
    (model.fields || []).forEach((field, fi) => {
      const row = document.createElement('div');
      row.classList.add('sv-field-row');
      const pkBadge = field.pk || field.primary_key
        ? '<span class="sv-field-pk">PK</span>' : '';
      const nnBadge = (field.not_null || field.notnull) && !field.pk
        ? '<span class="sv-field-badge">NN</span>' : '';
      const typeLabel = field.label || field.kind || field.lemat_type || field.sql_type || '?';
      const typeDetail = field.options?.length ? `(${field.options.slice(0,3).join(', ')}${field.options.length>3?'…':''})` :
        field.relationModel ? `→ ${field.relationModel}` : '';
      row.innerHTML = `
        <span class="sv-field-name">${field.name}</span>
        <span class="sv-field-type">${typeLabel} ${typeDetail}</span>
        ${pkBadge}${nnBadge}
        <span class="sv-field-actions">
          <button title="Modifier" data-action="edit-field" data-mi="${mi}" data-fi="${fi}">✎</button>
          <button title="Supprimer" class="danger" data-action="del-field" data-mi="${mi}" data-fi="${fi}">✕</button>
        </span>`;
      fieldList.appendChild(row);
    });
  });

  // Add model button
  const addModelBtn = document.createElement('button');
  addModelBtn.className = 'sv-add-model';
  addModelBtn.textContent = '＋ Nouveau modèle';
  container.appendChild(addModelBtn);

  // ── Delegation handler ─────────────────────────────────────────────
  container.onclick = (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const mi = parseInt(btn.dataset.mi);
    const fi = parseInt(btn.dataset.fi);

    if (action === 'del-model') {
      if (!confirm(`Supprimer le modèle "${tab._parsedModels[mi].name}" ?`)) return;
      tab._parsedModels.splice(mi, 1);
      renderSchemaModels(container, tab._parsedModels, tab);
      _autoSaveSchema(tab);
    } else if (action === 'rename-model') {
      openModelModal(container, tab, mi);
    } else if (action === 'add-field') {
      openFieldModal(container, tab, mi, -1);
    } else if (action === 'edit-field') {
      openFieldModal(container, tab, mi, fi);
    } else if (action === 'del-field') {
      tab._parsedModels[mi].fields.splice(fi, 1);
      renderSchemaModels(container, tab._parsedModels, tab);
      _autoSaveSchema(tab);
    }
  };

  addModelBtn.onclick = () => openModelModal(container, tab, -1);
}


function openModelModal(container, tab, mi) {
  const isNew = mi === -1;
  const existing = isNew ? null : tab._parsedModels[mi];
  let overlay = document.getElementById('schema-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'schema-modal-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">
        <span>${isNew ? 'Nouveau modèle' : `Renommer "${existing.name}"`}</span>
        <button id="sm-close">×</button>
      </div>
      <div class="modal-field">
        <label>Nom du modèle</label>
        <input id="sm-name" type="text" value="${existing?.name || ''}" placeholder="Ex: Article, User, Product…">
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" id="sm-cancel">Annuler</button>
        <button class="btn-accent" id="sm-ok">${isNew ? 'Créer' : 'Renommer'}</button>
      </div>
    </div>`;
  overlay.classList.remove('hidden');

  const nameInput = overlay.querySelector('#sm-name');
  nameInput.focus(); nameInput.select();

  const close = () => { overlay.classList.add('hidden'); };
  overlay.querySelector('#sm-close').onclick = close;
  overlay.querySelector('#sm-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  overlay.querySelector('#sm-ok').onclick = () => {
    const name = nameInput.value.trim();
    if (!name) return;
    if (isNew) {
      tab._parsedModels.push({ name, fields: [
        { name: 'id', lemat_type: 'int', sql_type: 'INTEGER',
          kind: 'number', label: 'Int', pk: true, primary_key: true, autoincrement: true }
      ]});
    } else {
      tab._parsedModels[mi].name = name;
    }
    close();
    renderSchemaModels(container, tab._parsedModels, tab);
    _autoSaveSchema(tab);  // ← auto-save immédiat
  };
}


// SIMPLE_TYPES list (mirrors model_parser.SIMPLE_TYPES)
const LEMAT_SIMPLE_TYPES = [
  'Text','Textarea','Int','Number','Bool','Date','DateTime','Email','URL','File','Color','JSON'
];

function openFieldModal(container, tab, mi, fi) {
  const isNew = fi === -1;
  const existing = isNew ? null : tab._parsedModels[mi].fields[fi];
  const modelNames = tab._parsedModels.map(m => m.name);

  let overlay = document.getElementById('field-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'field-modal-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }

  const curType = existing
    ? (existing.kind === 'select' ? 'Select'
    : existing.kind === 'relation' ? 'Relation'
    : existing.label || existing.lemat_type || 'Text')
    : 'Text';

  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">
        <span>${isNew ? 'Nouveau champ' : `Modifier "${existing.name}"`}</span>
        <button id="fm-close">×</button>
      </div>
      <div class="modal-field">
        <label>Nom du champ</label>
        <input id="fm-name" type="text" value="${existing?.name || ''}" placeholder="ex: title, email, price…">
      </div>
      <div class="modal-field">
        <label>Type</label>
        <div class="field-type-grid" id="fm-type-grid">
          ${LEMAT_SIMPLE_TYPES.map(t =>
            `<div class="field-type-option ${t === curType ? 'active' : ''}" data-type="${t}">${t}</div>`
          ).join('')}
          <div class="field-type-option ${curType === 'Select' ? 'active' : ''}" data-type="Select">Select</div>
          <div class="field-type-option ${curType === 'Relation' ? 'active' : ''}" data-type="Relation">Relation</div>
        </div>
      </div>
      <div id="fm-select-opts" class="field-select-opts" style="display:none">
        <div class="modal-field">
          <label>Options (une par ligne)</label>
          <textarea id="fm-select-values" placeholder="option1\noption2\noption3">${existing?.options?.join('\n') || ''}</textarea>
        </div>
      </div>
      <div id="fm-relation-target" class="field-relation-model" style="display:none">
        <div class="modal-field">
          <label>Modèle cible</label>
          <select id="fm-rel-model">
            ${modelNames.map(n => `<option value="${n}" ${existing?.relationModel === n ? 'selected':''}>${n}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="modal-field" style="display:flex;gap:16px;margin-top:4px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="fm-pk" ${existing?.pk || existing?.primary_key ? 'checked':''}>
          @id (PK)
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="fm-unique" ${existing?.unique ? 'checked':''}>
          @unique
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="fm-notnull" ${existing?.not_null || existing?.notnull ? 'checked':''}>
          @notnull
        </label>
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" id="fm-cancel">Annuler</button>
        <button class="btn-accent" id="fm-ok">${isNew ? 'Ajouter' : 'Enregistrer'}</button>
      </div>
    </div>`;
  overlay.classList.remove('hidden');

  let selectedType = curType;
  const grid = overlay.querySelector('#fm-type-grid');
  const selectOptsDiv  = overlay.querySelector('#fm-select-opts');
  const relationDiv    = overlay.querySelector('#fm-relation-target');

  const updateTypeUI = (t) => {
    selectedType = t;
    grid.querySelectorAll('.field-type-option').forEach(el =>
      el.classList.toggle('active', el.dataset.type === t));
    selectOptsDiv.style.display  = t === 'Select'   ? 'block' : 'none';
    relationDiv.style.display    = t === 'Relation' ? 'block' : 'none';
  };
  updateTypeUI(curType);

  grid.addEventListener('click', (e) => {
    const opt = e.target.closest('.field-type-option');
    if (opt) updateTypeUI(opt.dataset.type);
  });

  const nameInput = overlay.querySelector('#fm-name');
  nameInput.focus(); if (!isNew) nameInput.select();

  const close = () => { overlay.classList.add('hidden'); };
  overlay.querySelector('#fm-close').onclick  = close;
  overlay.querySelector('#fm-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  overlay.querySelector('#fm-ok').onclick = () => {
    const name = nameInput.value.trim();
    if (!name) return;

    const pk       = overlay.querySelector('#fm-pk').checked;
    const unique   = overlay.querySelector('#fm-unique').checked;
    const notnull  = overlay.querySelector('#fm-notnull').checked;

    let field = { name };
    if (selectedType === 'Select') {
      const opts = overlay.querySelector('#fm-select-values').value
        .split('\n').map(s => s.trim()).filter(Boolean);
      field = { ...field, lemat_type: 'select', kind: 'select', sql_type: 'TEXT',
                label: 'Select', options: opts };
    } else if (selectedType === 'Relation') {
      const relModel = overlay.querySelector('#fm-rel-model')?.value || '';
      field = { ...field, lemat_type: 'relation', kind: 'relation', sql_type: 'INTEGER',
                label: 'Relation', relationModel: relModel };
    } else {
      const typeMap = {
        'Text':'text','Textarea':'textarea','Int':'int','Number':'number',
        'Bool':'bool','Date':'date','DateTime':'datetime','Email':'email',
        'URL':'url','File':'file','Color':'color','JSON':'json',
      };
      const lt = typeMap[selectedType] || 'text';
      const sqlMap = {
        'int':'INTEGER','number':'REAL','bool':'INTEGER',
        'date':'TEXT','datetime':'TEXT','json':'TEXT',
      };
      const st = sqlMap[lt] || 'TEXT';
      field = { ...field, lemat_type: lt, kind: lt, sql_type: st, label: selectedType };
    }

    if (pk)      { field.pk = true; field.primary_key = true; }
    if (unique)  { field.unique = true; }
    if (notnull) { field.not_null = true; field.notnull = true; }

    if (isNew) {
      tab._parsedModels[mi].fields.push(field);
    } else {
      tab._parsedModels[mi].fields[fi] = field;
    }
    close();
    renderSchemaModels(container, tab._parsedModels, tab);
    _autoSaveSchema(tab);  // ← auto-save immédiat
  };
}


// Serialize model array → .lemat DSL string
function modelsToLemat(models) {
  if (!models || !models.length) return '';
  const lines = [];
  models.forEach(model => {
    lines.push(`model ${model.name} {`);
    (model.fields || []).forEach(f => {
      const mods = [];
      if (f.pk || f.primary_key)   mods.push('@id');
      if (f.autoincrement)          mods.push('@autoincrement');
      if (f.unique)                 mods.push('@unique');
      if (f.not_null || f.notnull) mods.push('@notnull');

      let typeStr;
      if (f.kind === 'select' || f.lemat_type === 'select') {
        typeStr = `Select(${(f.options || []).join(', ')})`;
      } else if (f.kind === 'relation' || f.lemat_type === 'relation') {
        typeStr = `Relation(${f.relationModel || ''})`;
      } else {
        const labelMap = {
          'text':'Text','textarea':'Textarea','int':'Int','integer':'Int',
          'number':'Number','real':'Number','bool':'Bool','boolean':'Bool',
          'date':'Date','datetime':'DateTime','timestamp':'DateTime',
          'email':'Email','url':'URL','file':'File','color':'Color','json':'JSON',
        };
        typeStr = f.label || labelMap[f.lemat_type] || labelMap[f.kind] || 'Text';
      }

      const modStr = mods.length ? mods.join(' ') + ' ' : '';
      lines.push(`  ${f.name.padEnd(16)}${modStr}${typeStr}`);
    });
    lines.push('}');
    lines.push('');
  });
  return lines.join('\n').trimEnd() + '\n';
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

