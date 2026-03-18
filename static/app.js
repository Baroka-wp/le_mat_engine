/* ── Le Mat — frontend ──────────────────────────────────────────────── */
const API = '';

// ── Auth helpers ──────────────────────────────────────────────────────
function getToken()          { return localStorage.getItem('lemat_token'); }
function getTokenEmail()     { return localStorage.getItem('lemat_email'); }
function setToken(t, email)  { localStorage.setItem('lemat_token', t); localStorage.setItem('lemat_email', email); }
function clearToken()        { localStorage.removeItem('lemat_token'); localStorage.removeItem('lemat_email'); }

function showAuthView() {
  document.getElementById('view-auth').style.display = 'flex';
  document.getElementById('view-dashboard').style.display = 'none';
  document.getElementById('view-editor').style.display = 'none';
}

function showAuthTab(tab) {
  document.getElementById('form-login').style.display    = tab === 'login'    ? '' : 'none';
  document.getElementById('form-register').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('tab-login').classList.toggle('active',    tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
  document.getElementById('login-error').style.display = 'none';
  document.getElementById('reg-error').style.display   = 'none';
}

async function submitLogin(e) {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  const btn   = document.getElementById('btn-login-submit');
  errEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Connexion…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:    document.getElementById('login-email').value.trim(),
        password: document.getElementById('login-password').value,
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Erreur');
    setToken(data.access_token, data.email);
    document.getElementById('view-auth').style.display = 'none';
    await bootApp();
  } catch(err) {
    errEl.textContent    = err.message;
    errEl.style.display  = 'block';
    btn.disabled         = false;
    btn.textContent      = 'Se connecter';
  }
}

async function submitRegister(e) {
  e.preventDefault();
  const errEl = document.getElementById('reg-error');
  const btn   = document.getElementById('btn-reg-submit');
  errEl.style.display = 'none';
  const pwd  = document.getElementById('reg-password').value;
  const conf = document.getElementById('reg-confirm').value;
  if (pwd !== conf) {
    errEl.textContent = 'Les mots de passe ne correspondent pas';
    errEl.style.display = 'block'; return;
  }
  btn.disabled = true;
  btn.textContent = 'Création…';
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:    document.getElementById('reg-email').value.trim(),
        password: pwd,
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Erreur');
    setToken(data.access_token, data.email);
    document.getElementById('view-auth').style.display = 'none';
    await bootApp();
  } catch(err) {
    errEl.textContent    = err.message;
    errEl.style.display  = 'block';
    btn.disabled         = false;
    btn.textContent      = 'Créer mon compte';
  }
}

function logout() {
  clearToken();
  showAuthView();
}

// ── State ────────────────────────────────────────────────────────────
let currentProject = null;
let editor         = null;
let tabs           = [];
let activeTab      = null;
let currentRunId   = null;
let currentES      = null;

// Types de fichiers qui s'ouvrent dans le navigateur (pas exécutés)
const WEB_EXTS = new Set(['html', 'htm', 'css', 'svg']);

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
  const token = getToken();
  if (!token) {
    showAuthView();
    return;
  }
  // Vérifier que le token est encore valide
  try {
    await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(r => { if (r.status === 401) throw new Error(); });
  } catch {
    clearToken();
    showAuthView();
    return;
  }
  await bootApp();
}

async function bootApp() {
  await loadProjects();
  showDashboard();
  // Afficher l'email dans le header
  const email = getTokenEmail();
  const el = document.getElementById('dash-user-email');
  if (el && email) el.textContent = email;
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
  const token = getToken();
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, opts);
  if (res.status === 401) {
    clearToken();
    showAuthView();
    throw new Error('Session expirée');
  }
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
      const r = await fetch(`/api/projects/${encodeURIComponent(oldName)}/rename`,
        { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name: newName }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || r.statusText);
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
      const res = await fetch('/api/projects-import', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || res.statusText);
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
      <button class="btn-delete-project" title="Supprimer"><svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><polyline points="3 4 4 12 10 12 11 4"/><line x1="2" y1="4" x2="12" y2="4"/><path d="M5 4V2.5a.5.5 0 01.5-.5h3a.5.5 0 01.5.5V4"/></svg></button>`;
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

// ── SVG icon helpers ──────────────────────────────────────────────────
const _iconSvg = (paths, color) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg">${paths.map(d=>`<path d="${d}" fill="${color}"/>`).join('')}</svg>`;

const _strokeIcon = (w, h, content) =>
  `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">${content}</svg>`;

// Reusable SVG icons for buttons
const SVG_ICONS = {
  table:    _strokeIcon(16, 16, '<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="6" x2="14" y2="6"/><line x1="2" y1="10" x2="14" y2="10"/><line x1="6" y1="6" x2="6" y2="14"/><line x1="10" y1="6" x2="10" y2="14"/>'),
  plus:     _strokeIcon(14, 14, '<line x1="7" y1="3" x2="7" y2="11"/><line x1="3" y1="7" x2="11" y2="7"/>'),
  refresh:  _strokeIcon(14, 14, '<path d="M11.5 5A4.5 4.5 0 002.5 7"/><path d="M2.5 9a4.5 4.5 0 009-2"/><polyline points="11.5 2 11.5 5 8.5 5"/><polyline points="2.5 12 2.5 9 5.5 9"/>'),
  trash:    _strokeIcon(14, 14, '<polyline points="3 4 4 12 10 12 11 4"/><line x1="2" y1="4" x2="12" y2="4"/><path d="M5 4V2.5a.5.5 0 01.5-.5h3a.5.5 0 01.5.5V4"/>'),
  play:     _strokeIcon(14, 14, '<polygon points="4,2 12,7 4,12" fill="currentColor" stroke="none"/>'),
  stop:     _strokeIcon(14, 14, '<rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>'),
  clearLog: _strokeIcon(14, 14, '<line x1="2" y1="2" x2="12" y2="12"/><line x1="12" y1="2" x2="2" y2="12"/><rect x="1" y="1" width="12" height="12" rx="2"/>'),
  logs:     _strokeIcon(14, 14, '<line x1="3" y1="4" x2="11" y2="4"/><line x1="3" y1="7" x2="9" y2="7"/><line x1="3" y1="10" x2="11" y2="10"/>'),
  save:     _strokeIcon(14, 14, '<path d="M11 13H3a1 1 0 01-1-1V2a1 1 0 011-1h6l3 3v8a1 1 0 01-1 1z"/><polyline points="8 1 8 4 11 4"/><line x1="5" y1="8" x2="9" y2="8"/><line x1="5" y1="10" x2="9" y2="10"/>'),
  edit:     _strokeIcon(14, 14, '<path d="M9.5 2.5l2 2L5 11H3V9l6.5-6.5z"/><line x1="8" y1="4" x2="10" y2="6"/>'),
  clock:    _strokeIcon(14, 14, '<circle cx="7" cy="7" r="5.5"/><polyline points="7 4 7 7 9.5 8.5"/>'),
  mail:     _strokeIcon(14, 14, '<rect x="1.5" y="3" width="11" height="8" rx="1.5"/><polyline points="1.5 3 7 7.5 12.5 3"/>'),
  gear:     _strokeIcon(14, 14, '<circle cx="7" cy="7" r="2"/><path d="M7 1.5l.9 1.6a4 4 0 011.1.6l1.7-.5.8 1.4-1 1.3a4 4 0 010 1.2l1 1.3-.8 1.4-1.7-.5a4 4 0 01-1.1.6L7 12.5l-1-.1-.9-1.5a4 4 0 01-1.1-.6l-1.7.5-.8-1.4 1-1.3a4 4 0 010-1.2l-1-1.3.8-1.4 1.7.5a4 4 0 011.1-.6L7 1.5z"/>'),
  close:    _strokeIcon(12, 12, '<line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/>'),
};

const FILE_ICONS = {
  // Web
  html: _iconSvg(['M2 2h12v12H2V2zm1 1v10h10V3H3zm2 2h2v1H5V5zm4 0h2v1H9V5zm-2 3h2v1H7V8z'], '#e44d26'),
  htm:  _iconSvg(['M2 2h12v12H2V2zm1 1v10h10V3H3zm2 2h2v1H5V5zm4 0h2v1H9V5zm-2 3h2v1H7V8z'], '#e44d26'),
  css:  _iconSvg(['M2 2h12v12H2V2zm1 1v10h10V3H3zm2 2h6v1H5V5zm1 3h4v1H6V8zm1 3h2v1H7v-1z'], '#1572b6'),
  js:   _iconSvg(['M2 2h12v12H2V2zm1 1v10h10V3H3zm3 3v5h1V8h2v3h1V6H6z'], '#f7df1e'),
  mjs:  _iconSvg(['M2 2h12v12H2V2zm1 1v10h10V3H3zm3 3v5h1V8h2v3h1V6H6z'], '#f7df1e'),
  ts:   _iconSvg(['M2 2h12v12H2V2zm1 1v10h10V3H3zm2 3h6v1H9v4H7V7H5V6z'], '#3178c6'),
  jsx:  _iconSvg(['M2 2h12v12H2V2zm1 1v10h10V3H3zm3 3v5h1V8h2v3h1V6H6z'], '#61dafb'),
  tsx:  _iconSvg(['M2 2h12v12H2V2zm1 1v10h10V3H3zm2 3h6v1H9v4H7V7H5V6z'], '#61dafb'),
  vue:  _iconSvg(['M8 2L2 14h3l3-7 3 7h3L8 2z'], '#41b883'),
  svelte: _iconSvg(['M8 2L2 14h3l3-7 3 7h3L8 2z'], '#ff3e00'),
  // Data
  json: _iconSvg(['M4 2C3 2 2 3 2 4v8c0 1 1 2 2 2h1v-1H4c-.6 0-1-.4-1-1V4c0-.6.4-1 1-1h1V2H4zm8 0h-1v1h1c.6 0 1 .4 1 1v8c0 .6-.4 1-1 1h-1v1h1c1 0 2-1 2-2V4c0-1-1-2-2-2zM6 5v2h1V5H6zm3 0v2h1V5H9zM6 9v2h4V9H6z'], '#c7a026'),
  sql:  _iconSvg(['M8 1C5 1 2.5 2 2.5 3.5v9C2.5 14 5 15 8 15s5.5-1 5.5-2.5v-9C13.5 2 11 1 8 1zm0 1.5c2.5 0 4 .7 4 1.5S10.5 5.5 8 5.5 4 4.8 4 4s1.5-1.5 4-1.5z'], '#e38c00'),
  db:   _iconSvg(['M8 1C5 1 2.5 2 2.5 3.5v9C2.5 14 5 15 8 15s5.5-1 5.5-2.5v-9C13.5 2 11 1 8 1zm0 1.5c2.5 0 4 .7 4 1.5S10.5 5.5 8 5.5 4 4.8 4 4s1.5-1.5 4-1.5z'], '#e38c00'),
  sqlite: _iconSvg(['M8 1C5 1 2.5 2 2.5 3.5v9C2.5 14 5 15 8 15s5.5-1 5.5-2.5v-9C13.5 2 11 1 8 1zm0 1.5c2.5 0 4 .7 4 1.5S10.5 5.5 8 5.5 4 4.8 4 4s1.5-1.5 4-1.5z'], '#e38c00'),
  sqlite3: _iconSvg(['M8 1C5 1 2.5 2 2.5 3.5v9C2.5 14 5 15 8 15s5.5-1 5.5-2.5v-9C13.5 2 11 1 8 1zm0 1.5c2.5 0 4 .7 4 1.5S10.5 5.5 8 5.5 4 4.8 4 4s1.5-1.5 4-1.5z'], '#e38c00'),
  // Languages
  py:   _iconSvg(['M8 1C5.5 1 4 2 4 3.5V5h4v1H3C1.8 6 1 7 1 8.5 1 10 1.8 11 3 11h1.5v-1.5C4.5 8.5 5.3 8 6 8h4c.7 0 1.5-.3 1.5-1V3.5C11.5 2 10.5 1 8 1zM6 2.5a.75.75 0 110 1.5.75.75 0 010-1.5zM12 5v1.5c0 1-1 1.5-1.5 1.5H6c-.7 0-1.5.3-1.5 1V12.5C4.5 14 5.5 15 8 15c2.5 0 4-1 4-2.5V11H8v-1h5c1.2 0 2-1 2-2.5C15 6 14.2 5 13 5h-1zm2 9.5a.75.75 0 110 1.5.75.75 0 010-1.5z'], '#3572a5'),
  sh:   _iconSvg(['M2 3v10h12V3H2zm1 1h10v8H3V4zm2 1.5L7.5 8 5 10.5l-.7-.7L6.1 8 4.3 6.2l.7-.7zm4 4.5v1h3V10H9z'], '#4eaa25'),
  bash: _iconSvg(['M2 3v10h12V3H2zm1 1h10v8H3V4zm2 1.5L7.5 8 5 10.5l-.7-.7L6.1 8 4.3 6.2l.7-.7zm4 4.5v1h3V10H9z'], '#4eaa25'),
  // Text/docs
  md:   _iconSvg(['M2 3v10h12V3H2zm1 1h10v8H3V4zm1 2v4h1.5V7.5L6.5 9h1l1-1.5V10H10V6H8.5L8 7l-.5-1H4z'], '#5b5b5b'),
  txt:  _iconSvg(['M3 1v14h10V4l-3-3H3zm1 1h5v3h3v9H4V2zm1 4v1h6V6H5zm0 2v1h6V8H5zm0 2v1h4v-1H5z'], '#87878a'),
  // Config
  yaml: _iconSvg(['M2 2h12v12H2V2zm1 1v10h10V3H3zm2 2v1h1V5H5zm3 0v1h3V5H8zM5 7v1h1V7H5zm3 0v1h3V7H8zM5 9v1h1V9H5zm3 0v1h3V9H8z'], '#cb171e'),
  yml:  _iconSvg(['M2 2h12v12H2V2zm1 1v10h10V3H3zm2 2v1h1V5H5zm3 0v1h3V5H8zM5 7v1h1V7H5zm3 0v1h3V7H8zM5 9v1h1V9H5zm3 0v1h3V9H8z'], '#cb171e'),
  toml: _iconSvg(['M2 2h12v12H2V2zm1 1v10h10V3H3zm2 2v1h1V5H5zm3 0v1h3V5H8zM5 7v1h1V7H5zm3 0v1h3V7H8z'], '#9c4221'),
  env:  _iconSvg(['M2 2h12v12H2V2zm1 1v10h10V3H3zm2 3h6v1H5V6zm0 2h4v1H5V8zm0 2h5v1H5v-1z'], '#ecd53f'),
  // Images
  png:  _iconSvg(['M3 1v14h10V4l-3-3H3zm1 1h5v3h3v9H4V2zm2 5a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm3 2l2 3H5l1.5-2 1 1.3L9 9z'], '#a074c4'),
  jpg:  _iconSvg(['M3 1v14h10V4l-3-3H3zm1 1h5v3h3v9H4V2zm2 5a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm3 2l2 3H5l1.5-2 1 1.3L9 9z'], '#a074c4'),
  jpeg: _iconSvg(['M3 1v14h10V4l-3-3H3zm1 1h5v3h3v9H4V2zm2 5a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm3 2l2 3H5l1.5-2 1 1.3L9 9z'], '#a074c4'),
  gif:  _iconSvg(['M3 1v14h10V4l-3-3H3zm1 1h5v3h3v9H4V2zm2 5a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm3 2l2 3H5l1.5-2 1 1.3L9 9z'], '#a074c4'),
  webp: _iconSvg(['M3 1v14h10V4l-3-3H3zm1 1h5v3h3v9H4V2zm2 5a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm3 2l2 3H5l1.5-2 1 1.3L9 9z'], '#a074c4'),
  svg:  _iconSvg(['M3 1v14h10V4l-3-3H3zm1 1h5v3h3v9H4V2zm2 5a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm3 2l2 3H5l1.5-2 1 1.3L9 9z'], '#e6a817'),
  ico:  _iconSvg(['M3 1v14h10V4l-3-3H3zm1 1h5v3h3v9H4V2zm2 5a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm3 2l2 3H5l1.5-2 1 1.3L9 9z'], '#a074c4'),
  pdf:  _iconSvg(['M3 1v14h10V4l-3-3H3zm1 1h5v3h3v9H4V2zm1 5h1.5c.8 0 1.5.5 1.5 1.2 0 .7-.7 1.2-1.5 1.2H6v2H5V8z'], '#e5252a'),
  xml:  _iconSvg(['M2 2h12v12H2V2zm1 1v10h10V3H3zm2 3l1.5 2L5 10h1.2l.8-1.3.8 1.3H9L7.5 8 9 6H7.8L7 7.3 6.2 6H5z'], '#e65100'),
  // Package/lock
  lock: _iconSvg(['M4 7V5a4 4 0 018 0v2h1v7H3V7h1zm2 0h4V5a2 2 0 10-4 0v2zm1 2v3h2V9H7z'], '#87878a'),
  // Git
  gitignore: _iconSvg(['M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a5.5 5.5 0 014.2 9L4.5 3.8A5.47 5.47 0 018 2.5zM3.8 4.5l7.7 7.7a5.5 5.5 0 01-7.7-7.7z'], '#f05032'),
  lemat: _iconSvg(['M8 1C5 1 2.5 2 2.5 3.5v9C2.5 14 5 15 8 15s5.5-1 5.5-2.5v-9C13.5 2 11 1 8 1zm0 1.5c2.5 0 4 .7 4 1.5S10.5 5.5 8 5.5 4 4.8 4 4s1.5-1.5 4-1.5z','M5 8h6v1H5V8zm1 2.5h4v1H6v-1z'], '#8b5cf6'),
};

const _defaultFileIcon = _iconSvg(['M3 1v14h10V4l-3-3H3zm1 1h5v3h3v9H4V2z'], '#87878a');
const _folderIcon      = _iconSvg(['M1 3v10h14V5H7.5L6 3H1zm1 1h3.3l1.5 2H14v6H2V4z'], '#dcb67a');
const _folderOpenIcon  = _iconSvg(['M1 3v10h14V5H7.5L6 3H1zm1 2h12v6H2V5z'], '#dcb67a');
const _chevronRight    = '<svg viewBox="0 0 16 16" width="12" height="12" class="tree-chevron"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  // Special names
  if (name === '.gitignore') return FILE_ICONS.gitignore;
  if (name === '.env' || name.startsWith('.env.')) return FILE_ICONS.env;
  if (name.endsWith('.lock') || name === 'package-lock.json') return FILE_ICONS.lock;
  return FILE_ICONS[ext] || _defaultFileIcon;
}

// ── File tree ─────────────────────────────────────────────────────────
let _openDirs = new Set(); // Remember open directories across reloads
let _draggedPath = null;

async function loadTree() {
  const tree = await api('GET', `/api/projects/${currentProject}/tree`);
  const container = document.getElementById('file-tree');
  container.innerHTML = '';
  renderTree(tree.children, container, '');

  // Drop to root — drag a file to the empty area to move it to project root
  container.ondragover = (e) => {
    if (e.target.closest('.tree-item')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    container.classList.add('drag-over-root');
  };
  container.ondragleave = (e) => {
    if (!container.contains(e.relatedTarget) || e.relatedTarget?.closest('.tree-item'))
      container.classList.remove('drag-over-root');
  };
  container.ondrop = async (e) => {
    container.classList.remove('drag-over-root');
    if (!_draggedPath || e.target.closest('.tree-item')) return;
    e.preventDefault();
    if (!_draggedPath.includes('/')) { _draggedPath = null; return; } // already at root
    const fileName = _draggedPath.split('/').pop();
    try {
      await api('POST', `/api/projects/${currentProject}/move/${_draggedPath}`, { destination: fileName });
      tabs.forEach(t => {
        if (t.path === _draggedPath) t.path = fileName;
        else if (t.path.startsWith(_draggedPath + '/')) t.path = fileName + t.path.substring(_draggedPath.length);
      });
      renderTabs();
      await loadTree();
      toast('Déplacé à la racine', 'success');
    } catch (err) { toast(err.message, 'error'); }
    _draggedPath = null;
  };

  // Context menu on empty space = root actions
  container.oncontextmenu = (e) => {
    if (e.target.closest('.tree-item')) return;
    e.preventDefault();
    showTreeContextMenu(e.clientX, e.clientY, '', true);
  };
}

function renderTree(children, container, prefix) {
  // Sort: directories first, then files, alphabetically
  const sorted = [...(children || [])].sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'directory' ? -1 : 1;
  });

  sorted.forEach(node => {
    const isDir = node.type === 'directory';
    const path  = prefix ? `${prefix}/${node.name}` : node.name;

    const div = document.createElement('div');
    div.classList.add('tree-item');
    div.dataset.path = path;
    div.dataset.isDir = isDir ? '1' : '0';

    const isOpen = _openDirs.has(path);

    if (isDir) {
      div.innerHTML = `
        <span class="tree-chevron-wrap ${isOpen ? 'open' : ''}">${_chevronRight}</span>
        <span class="tree-icon">${isOpen ? _folderOpenIcon : _folderIcon}</span>
        <span class="tree-name">${node.name}</span>`;
    } else {
      div.innerHTML = `
        <span class="tree-chevron-wrap" style="visibility:hidden">${_chevronRight}</span>
        <span class="tree-icon">${getFileIcon(node.name)}</span>
        <span class="tree-name">${node.name}</span>`;
    }

    if (activeTab?.path === path) div.classList.add('active');

    // Drag & Drop
    div.draggable = true;
    div.addEventListener('dragstart', (e) => {
      _draggedPath = path;
      e.dataTransfer.effectAllowed = 'move';
      div.classList.add('dragging');
    });
    div.addEventListener('dragend', () => {
      _draggedPath = null;
      div.classList.remove('dragging');
      document.querySelectorAll('.tree-item.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    if (isDir) {
      div.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        div.classList.add('drag-over');
      });
      div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
      div.addEventListener('drop', async (e) => {
        e.preventDefault();
        div.classList.remove('drag-over');
        if (!_draggedPath || _draggedPath === path) return;
        // Don't allow moving into itself
        if (path.startsWith(_draggedPath + '/')) return;
        const fileName = _draggedPath.split('/').pop();
        const dest = `${path}/${fileName}`;
        try {
          await api('POST', `/api/projects/${currentProject}/move/${_draggedPath}`, { destination: dest });
          // Update open tabs
          tabs.forEach(t => {
            if (t.path === _draggedPath) t.path = dest;
            else if (t.path.startsWith(_draggedPath + '/')) t.path = dest + t.path.substring(_draggedPath.length);
          });
          renderTabs();
          await loadTree();
          toast(`Déplacé vers ${path}/`, 'success');
        } catch (err) { toast(err.message, 'error'); }
        _draggedPath = null;
      });

      const childWrap = document.createElement('div');
      childWrap.classList.add('tree-children');
      childWrap.style.display = isOpen ? 'block' : 'none';

      div.onclick = (e) => {
        if (e.target.closest('.ctx-trigger')) return;
        const nowOpen = _openDirs.has(path);
        if (nowOpen) _openDirs.delete(path); else _openDirs.add(path);
        childWrap.style.display = nowOpen ? 'none' : 'block';
        div.querySelector('.tree-chevron-wrap').classList.toggle('open', !nowOpen);
        div.querySelector('.tree-icon').innerHTML = !nowOpen ? _folderOpenIcon : _folderIcon;
      };

      renderTree(node.children, childWrap, path);
      container.appendChild(div);
      container.appendChild(childWrap);
    } else {
      div.onclick = (e) => {
        if (e.target.closest('.ctx-trigger')) return;
        openFile(path);
      };
      container.appendChild(div);
    }

    // Context menu on right-click
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showTreeContextMenu(e.clientX, e.clientY, path, isDir);
    });
  });
}

// ── Context menu ──────────────────────────────────────────────────────
function showTreeContextMenu(x, y, path, isDir) {
  removeTreeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'tree-ctx-menu';
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';

  const items = [];
  if (isDir) {
    items.push({ label: 'Nouveau fichier', icon: '+', action: () => ctxNewFile(path) });
    items.push({ label: 'Nouveau dossier', icon: '+', action: () => ctxNewFolder(path) });
    items.push('sep');
  }
  items.push({ label: 'Renommer', icon: '✎', action: () => ctxRename(path) });
  items.push({ label: 'Supprimer', icon: '✕', danger: true, action: () => ctxDelete(path, isDir) });

  items.forEach(item => {
    if (item === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'ctx-item' + (item.danger ? ' danger' : '');
    btn.innerHTML = `<span class="ctx-icon">${item.icon}</span>${item.label}`;
    btn.onclick = () => { removeTreeContextMenu(); item.action(); };
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  // Adjust if off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';

  setTimeout(() => document.addEventListener('click', removeTreeContextMenu, { once: true }), 0);
}

function removeTreeContextMenu() {
  document.querySelectorAll('.tree-ctx-menu').forEach(el => el.remove());
}

function ctxNewFile(dirPath) {
  prompt_('Nom du fichier', '', async (name) => {
    if (!name) return;
    const fullPath = dirPath ? `${dirPath}/${name}` : name;
    await api('PUT', `/api/projects/${currentProject}/files/${fullPath}`, { content: '' });
    _openDirs.add(dirPath);
    await loadTree();
    openFile(fullPath);
  });
}

function ctxNewFolder(dirPath) {
  prompt_('Nom du dossier', '', async (name) => {
    if (!name) return;
    const fullPath = dirPath ? `${dirPath}/${name}` : name;
    await api('POST', `/api/projects/${currentProject}/mkdir/${fullPath}`);
    _openDirs.add(dirPath);
    await loadTree();
    toast(`Dossier créé`, 'success');
  });
}

function ctxRename(path) {
  const oldName = path.split('/').pop();
  prompt_('Renommer', oldName, async (newName) => {
    if (!newName || newName === oldName) return;
    const parent = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
    const dest = parent ? `${parent}/${newName}` : newName;
    try {
      await api('POST', `/api/projects/${currentProject}/move/${path}`, { destination: dest });
      // Update open tabs
      tabs.forEach(t => {
        if (t.path === path) t.path = dest;
        else if (t.path.startsWith(path + '/')) t.path = dest + t.path.substring(path.length);
      });
      if (activeTab?.path) renderTabs();
      await loadTree();
      toast('Renommé', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

function ctxDelete(path, isDir) {
  const label = isDir ? 'dossier' : 'fichier';
  const name = path.split('/').pop();
  confirmDelete(`Supprimer le ${label} "${name}" ?`, async () => {
    await api('DELETE', `/api/projects/${currentProject}/files/${path}`);
    // Clean tabs that were inside
    tabs = tabs.filter(t => t.path !== path && !t.path.startsWith(path + '/'));
    if (activeTab && !tabs.includes(activeTab)) activeTab = tabs[tabs.length - 1] || null;
    renderTabs();
    if (activeTab) showTab(activeTab); else showWelcome();
    await loadTree();
    toast(`${isDir ? 'Dossier' : 'Fichier'} supprimé`, 'success');
  });
}

// ── New file / folder (header buttons) ─────────────────────────────────
document.getElementById('btn-new-file').onclick = () => {
  prompt_('Nom du fichier (ex: index.html, src/app.js)', '', async (name) => {
    if (!name) return;
    await api('PUT', `/api/projects/${currentProject}/files/${name}`, { content: '' });
    // Auto-open parent dirs
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) _openDirs.add(parts.slice(0, i).join('/'));
    await loadTree();
    openFile(name);
  });
};

document.getElementById('btn-new-folder').onclick = () => {
  prompt_('Nom du dossier (ex: src, components/ui)', '', async (name) => {
    if (!name) return;
    await api('POST', `/api/projects/${currentProject}/mkdir/${name}`);
    const parts = name.split('/');
    for (let i = 1; i <= parts.length; i++) _openDirs.add(parts.slice(0, i).join('/'));
    await loadTree();
    toast(`Dossier créé`, 'success');
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
    if (ext === 'lemat') {
      tab = { path, modified: false, type: 'lemat', content: data.content };
    } else {
      const model = monaco.editor.createModel(data.content, detectLang(path));
      tab = { path, modified: false, model };
      model.onDidChangeContent(() => { tab.modified = true; renderTabs(); });
    }
    tabs.push(tab);
  }
  activeTab = tab;
  renderTabs();
  showTab(tab);
  highlightTreeItem(path);
}

function showTab(tab) {
  if (tab.type === 'data') { showDataTab(tab); return; }
  if (tab.type === 'lemat') { showLematVisual(tab); return; }
  const container = document.getElementById('editor-container');
  container.querySelectorAll('.data-view').forEach(el => el.remove());
  container.querySelectorAll('.lemat-editor').forEach(el => el.remove());
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.style.display = 'none';
  document.getElementById('monaco-container').style.display = 'block';
  editor.setModel(tab.model);
  editor.layout();
  editor.focus();
}

function showWelcome() {
  document.getElementById('monaco-container').style.display = 'none';
  const ec = document.getElementById('editor-container');
  ec.querySelectorAll('.data-view').forEach(el => el.remove());
  ec.querySelectorAll('.lemat-editor').forEach(el => el.remove());
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
  const content = tab.type === 'lemat' ? tab.content : tab.model.getValue();
  await api('PUT', `/api/projects/${currentProject}/files/${tab.path}`, { content });
  tab.modified = false;
  renderTabs();
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

// ── Lemat Visual Editor ───────────────────────────────────────────────

const LEMAT_TYPES = ['integer','text','real','boolean','datetime','date','json','blob'];

function parseLematSource(src) {
  const schema = { database: 'database.db', models: [] };
  const dbMatch = src.match(/^\s*database\s+"([^"]+)"/m);
  if (dbMatch) schema.database = dbMatch[1];

  const modelRe = /model\s+(\w+)\s*\{([^}]*)\}/gs;
  let m;
  while ((m = modelRe.exec(src)) !== null) {
    const model = { name: m[1], fields: [] };
    m[2].split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('//') || line.startsWith('#')) return;
      const parts = line.split(/\s+/);
      if (parts.length < 2) return;
      const f = { name: parts[0], type: parts[1].toLowerCase(), decorators: parts.slice(2).join(' ') };
      f.pk      = /@id|@primarykey/i.test(f.decorators);
      f.unique  = /@unique/.test(f.decorators);
      f.required = /@required|@notnull/i.test(f.decorators);
      const dm = f.decorators.match(/@default\(([^)]+)\)/);
      f.default_ = dm ? dm[1] : null;
      const rm = f.decorators.match(/@ref\(([^)]+)\)/);
      f.ref = rm ? rm[1] : null;
      model.fields.push(f);
    });
    schema.models.push(model);
  }
  return schema;
}

function lematToSource(schema) {
  let lines = [`database "${schema.database}"`, ''];
  schema.models.forEach(model => {
    lines.push(`model ${model.name} {`);
    model.fields.forEach(f => {
      let decs = [];
      if (f.pk) decs.push('@id');
      if (f.required && !f.pk) decs.push('@required');
      if (f.unique) decs.push('@unique');
      if (f.default_) decs.push(`@default(${f.default_})`);
      if (f.ref) decs.push(`@ref(${f.ref})`);
      const padding1 = ' '.repeat(Math.max(1, 14 - f.name.length));
      const padding2 = ' '.repeat(Math.max(1, 12 - f.type.length));
      lines.push(`  ${f.name}${padding1}${f.type}${padding2}${decs.join(' ')}`.trimEnd());
    });
    lines.push('}', '');
  });
  return lines.join('\n');
}

function showLematVisual(tab) {
  const container = document.getElementById('editor-container');
  container.querySelectorAll('.data-view').forEach(el => el.remove());
  container.querySelectorAll('.lemat-editor').forEach(el => el.remove());
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.style.display = 'none';
  document.getElementById('monaco-container').style.display = 'none';

  const schema = parseLematSource(tab.content);
  const wrap = document.createElement('div');
  wrap.className = 'lemat-editor';

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'lemat-toolbar';
  toolbar.innerHTML = `
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M2 6h12"/><path d="M6 2v4"/></svg>
    <span class="lemat-toolbar-title">${tab.path}</span>
    <div style="flex:1"></div>
    <button class="btn-lemat btn-lemat-code" title="Voir le code source">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5 3L1 8l4 5"/><path d="M11 3l4 5-4 5"/><path d="M9 2L7 14"/></svg>
      Code
    </button>
    <button class="btn-lemat" id="lemat-add-model">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
      Modèle
    </button>
    <button class="btn-lemat" id="lemat-migrate" title="Créer/mettre à jour la base de données">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4l6-3 6 3v8l-6 3-6-3V4z"/><path d="M2 4l6 3 6-3"/><path d="M8 7v8"/></svg>
      Migrer
    </button>
    <button class="btn-lemat primary" id="lemat-save">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 14H4a1 1 0 01-1-1V3a1 1 0 011-1h6l3 3v8a1 1 0 01-1 1z"/><path d="M10 2v3h3"/></svg>
      Sauvegarder
    </button>`;
  wrap.appendChild(toolbar);

  // Canvas
  const canvas = document.createElement('div');
  canvas.className = 'lemat-canvas';
  wrap.appendChild(canvas);
  container.appendChild(wrap);

  function markDirty() { tab.modified = true; renderTabs(); }

  // ── Card positions (stored per model for drag) ─────────────────────
  const CARD_W = 300, CARD_GAP = 30, CARD_PAD = 24;
  function autoLayout() {
    const cols = Math.max(1, Math.floor((canvas.clientWidth - CARD_PAD) / (CARD_W + CARD_GAP)));
    schema.models.forEach((model, i) => {
      if (!model._pos) {
        const col = i % cols, row = Math.floor(i / cols);
        model._pos = { x: CARD_PAD + col * (CARD_W + CARD_GAP), y: CARD_PAD + row * 260 };
      }
    });
  }

  function render() {
    canvas.innerHTML = '';
    if (!schema.models.length) {
      canvas.innerHTML = `<div class="lemat-empty">
        <svg viewBox="0 0 48 48" width="56" height="56" fill="none" stroke="var(--muted)" stroke-width="1.2" opacity=".4"><rect x="6" y="6" width="36" height="36" rx="4"/><path d="M6 14h36"/><path d="M16 6v8"/><path d="M32 6v8"/><path d="M16 24h16"/><path d="M16 32h8"/></svg>
        <span>Aucun modèle dans ce schema.</span>
        <button class="btn-lemat primary" onclick="document.getElementById('lemat-add-model').click()">+ Créer un modèle</button>
      </div>`;
      return;
    }

    autoLayout();

    schema.models.forEach((model, mi) => {
      const card = document.createElement('div');
      card.className = 'lemat-model-card';
      card.dataset.model = model.name;
      card.style.left = model._pos.x + 'px';
      card.style.top = model._pos.y + 'px';

      // Header (draggable)
      const header = document.createElement('div');
      header.className = 'lemat-model-header';
      header.innerHTML = `
        <div class="lemat-model-name-wrap">
          <svg class="lemat-drag-handle" viewBox="0 0 10 16" width="8" height="14" fill="rgba(255,255,255,.5)"><circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="7" cy="8" r="1.2"/><circle cx="3" cy="13" r="1.2"/><circle cx="7" cy="13" r="1.2"/></svg>
          <span class="lemat-model-name">${model.name}</span>
          <span class="lemat-model-count">${model.fields.length} champ${model.fields.length > 1 ? 's' : ''}</span>
        </div>
        <div class="lemat-model-actions">
          <button class="btn-rename-model" title="Renommer">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9.5 3.5l3 3L5 14H2v-3l7.5-7.5z"/></svg>
          </button>
          <button class="btn-del-model" title="Supprimer">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 5h10l-1 9H4L3 5z"/><path d="M6 5V3h4v2"/><path d="M1 5h14"/></svg>
          </button>
        </div>`;

      // ── Drag to move card ──────────────────────────────────────────
      let dragState = null;
      header.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return; // ignore clicks on buttons
        e.preventDefault();
        const startX = e.clientX, startY = e.clientY;
        const origX = model._pos.x, origY = model._pos.y;
        card.classList.add('dragging');
        card.style.zIndex = 100;

        const onMove = (e2) => {
          model._pos.x = Math.max(0, origX + e2.clientX - startX);
          model._pos.y = Math.max(0, origY + e2.clientY - startY);
          card.style.left = model._pos.x + 'px';
          card.style.top = model._pos.y + 'px';
          drawRelationLines();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          card.classList.remove('dragging');
          card.style.zIndex = '';
          expandCanvasIfNeeded();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      header.querySelector('.btn-rename-model').onclick = (e) => {
        e.stopPropagation();
        prompt_('Nom du modèle', model.name, (n) => {
          if (!n || n === model.name) return;
          model.name = n; markDirty(); render();
        });
      };
      header.querySelector('.btn-del-model').onclick = (e) => {
        e.stopPropagation();
        confirmDelete(`Supprimer le modèle "${model.name}" ?`, () => {
          schema.models.splice(mi, 1); markDirty(); render();
        });
      };
      card.appendChild(header);

      // Fields
      const fieldList = document.createElement('div');
      fieldList.className = 'lemat-field-list';
      model.fields.forEach((f, fi) => {
        const row = document.createElement('div');
        row.className = 'lemat-field-row';
        row.dataset.field = f.name;
        row.dataset.model = model.name;
        if (f.pk) row.dataset.pk = '1';
        let badges = '';
        if (f.pk)       badges += '<span class="lemat-badge pk">PK</span>';
        if (f.required && !f.pk) badges += '<span class="lemat-badge req">REQ</span>';
        if (f.unique)   badges += '<span class="lemat-badge uq">UQ</span>';
        if (f.ref)      badges += `<span class="lemat-badge ref" title="Cliquer pour supprimer la relation">→ ${f.ref}</span>`;
        if (f.default_) badges += `<span class="lemat-badge def">= ${f.default_}</span>`;
        row.innerHTML = `
          <span class="lemat-field-name">${f.name}</span>
          <span class="lemat-field-type">${f.type}</span>
          <span class="lemat-field-badges">${badges}</span>
          <button class="lemat-field-connect" title="Connecter à un autre modèle">
            <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="3" cy="7" r="2"/><circle cx="11" cy="7" r="2"/><line x1="5" y1="7" x2="9" y2="7"/></svg>
          </button>
          <button class="lemat-field-del" title="Supprimer">
            <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
          </button>`;
        row.querySelector('.lemat-field-del').onclick = (e) => {
          e.stopPropagation();
          model.fields.splice(fi, 1); markDirty(); render();
        };
        row.querySelector('.lemat-field-connect').onclick = (e) => {
          e.stopPropagation();
          startConnectMode(model, f, row);
        };
        // Click ref badge → remove relation
        const refBadge = row.querySelector('.lemat-badge.ref');
        if (refBadge) {
          refBadge.style.cursor = 'pointer';
          refBadge.onclick = (e) => {
            e.stopPropagation();
            f.ref = null; markDirty(); render();
          };
        }
        row.onclick = () => showFieldEditor(fieldList, row, f, model, () => { markDirty(); render(); });
        fieldList.appendChild(row);
      });
      card.appendChild(fieldList);

      // Add field button
      const addBtn = document.createElement('button');
      addBtn.className = 'lemat-add-field';
      addBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg> Ajouter un champ';
      addBtn.onclick = () => {
        const nf = { name: '', type: 'text', decorators: '', pk: false, unique: false, required: false, default_: null, ref: null };
        model.fields.push(nf); markDirty(); render();
        const rows = card.querySelectorAll('.lemat-field-row');
        const lastRow = rows[rows.length - 1];
        if (lastRow) lastRow.click();
      };
      card.appendChild(addBtn);
      canvas.appendChild(card);
    });

    expandCanvasIfNeeded();
    requestAnimationFrame(() => drawRelationLines());
  }

  function expandCanvasIfNeeded() {
    let maxX = 0, maxY = 0;
    schema.models.forEach(m => {
      if (m._pos) {
        maxX = Math.max(maxX, m._pos.x + CARD_W + CARD_PAD);
        maxY = Math.max(maxY, m._pos.y + 300);
      }
    });
    canvas.style.minWidth = maxX + 'px';
    canvas.style.minHeight = maxY + 'px';
  }

  // ── SVG layer for relation lines + connect preview ────────────────────
  const svgNS = 'http://www.w3.org/2000/svg';
  const svgLayer = document.createElementNS(svgNS, 'svg');
  svgLayer.classList.add('lemat-relations-svg');
  canvas.appendChild(svgLayer);

  function drawRelationLines() {
    // Clear old lines but keep the svgLayer in DOM
    svgLayer.innerHTML = '';
    svgLayer.setAttribute('width', Math.max(canvas.scrollWidth, canvas.clientWidth));
    svgLayer.setAttribute('height', Math.max(canvas.scrollHeight, canvas.clientHeight));

    // Arrowhead marker
    const defs = document.createElementNS(svgNS, 'defs');
    const marker = document.createElementNS(svgNS, 'marker');
    marker.setAttribute('id', 'rel-arrow');
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9'); marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '7'); marker.setAttribute('markerHeight', '7');
    marker.setAttribute('orient', 'auto-start-reverse');
    const ap = document.createElementNS(svgNS, 'path');
    ap.setAttribute('d', 'M 0 1 L 8 5 L 0 9 Z');
    ap.setAttribute('fill', '#8b5cf6');
    marker.appendChild(ap);
    defs.appendChild(marker);
    svgLayer.appendChild(defs);

    const canvasRect = canvas.getBoundingClientRect();

    schema.models.forEach(model => {
      model.fields.forEach(f => {
        if (!f.ref || !f.ref.includes('.')) return;
        const [tgtModel, tgtField] = f.ref.split('.');
        const srcRow = canvas.querySelector(`.lemat-field-row[data-model="${model.name}"][data-field="${f.name}"]`);
        const tgtRow = canvas.querySelector(`.lemat-field-row[data-model="${tgtModel}"][data-field="${tgtField}"]`);
        const tgtCard = canvas.querySelector(`.lemat-model-card[data-model="${tgtModel}"]`);
        if (!srcRow || !tgtCard) return;
        const tgtEl = tgtRow || tgtCard;

        const sr = srcRow.getBoundingClientRect();
        const tr = tgtEl.getBoundingClientRect();

        const sx = sr.right - canvasRect.left + canvas.scrollLeft;
        const sy = sr.top + sr.height / 2 - canvasRect.top + canvas.scrollTop;
        const tx = tr.left - canvasRect.left + canvas.scrollLeft;
        const ty = tr.top + tr.height / 2 - canvasRect.top + canvas.scrollTop;

        // Smart bezier: if target is to the left, curve goes left
        const goRight = tx > sx;
        const cpDist = Math.max(50, Math.abs(tx - sx) * 0.35);
        const c1x = goRight ? sx + cpDist : sx - cpDist;
        const c2x = goRight ? tx - cpDist : tx + cpDist;

        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${ty}, ${tx} ${ty}`);
        path.classList.add('rel-line');
        path.setAttribute('marker-end', 'url(#rel-arrow)');
        svgLayer.appendChild(path);

        // Midpoint label
        const mx = (sx + tx) / 2, my = (sy + ty) / 2 - 10;
        const lbl = document.createElementNS(svgNS, 'text');
        lbl.setAttribute('x', mx); lbl.setAttribute('y', my);
        lbl.classList.add('rel-label');
        lbl.textContent = `${f.name} → ${tgtModel}`;
        svgLayer.appendChild(lbl);
      });
    });
  }

  // ── Connect mode (click-to-link with live preview line) ────────────────
  let connectMode = null;
  let _connectPreviewLine = null;

  function startConnectMode(model, field, sourceRow) {
    cancelConnectMode();
    connectMode = { sourceModel: model, sourceField: field, sourceRow };
    sourceRow.classList.add('connect-source');
    canvas.classList.add('connect-active');

    // Create a preview line that follows the mouse
    _connectPreviewLine = document.createElementNS(svgNS, 'line');
    _connectPreviewLine.classList.add('connect-preview-line');
    const sr = sourceRow.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const startX = sr.right - cr.left + canvas.scrollLeft;
    const startY = sr.top + sr.height / 2 - cr.top + canvas.scrollTop;
    _connectPreviewLine.setAttribute('x1', startX);
    _connectPreviewLine.setAttribute('y1', startY);
    _connectPreviewLine.setAttribute('x2', startX);
    _connectPreviewLine.setAttribute('y2', startY);
    svgLayer.appendChild(_connectPreviewLine);

    const onMouseMove = (e) => {
      if (!_connectPreviewLine) return;
      const mx = e.clientX - cr.left + canvas.scrollLeft;
      const my = e.clientY - cr.top + canvas.scrollTop;
      _connectPreviewLine.setAttribute('x2', mx);
      _connectPreviewLine.setAttribute('y2', my);
    };
    canvas.addEventListener('mousemove', onMouseMove);
    connectMode._mouseMoveHandler = onMouseMove;

    // Highlight valid targets (all fields, not just PK — user might want any field)
    canvas.querySelectorAll('.lemat-field-row').forEach(row => {
      if (row.dataset.model !== model.name) {
        row.classList.add('connect-target');
        row._connectHandler = (e) => {
          e.stopPropagation();
          e.preventDefault();
          field.ref = `${row.dataset.model}.${row.dataset.field}`;
          markDirty();
          cancelConnectMode();
          render();
          toast(`Relation créée: ${field.name} → ${row.dataset.model}.${row.dataset.field}`, 'success');
        };
        row.addEventListener('click', row._connectHandler, { capture: true });
      }
    });

    const escHandler = (e) => { if (e.key === 'Escape') cancelConnectMode(); };
    document.addEventListener('keydown', escHandler);
    connectMode._escHandler = escHandler;

    // Click on canvas background → cancel
    const bgHandler = (e) => {
      if (e.target === canvas || e.target === svgLayer) cancelConnectMode();
    };
    canvas.addEventListener('click', bgHandler);
    connectMode._bgHandler = bgHandler;

    toast('Clique sur un champ cible pour créer la relation. Escape pour annuler.', 'info');
  }

  function cancelConnectMode() {
    if (!connectMode) return;
    connectMode.sourceRow.classList.remove('connect-source');
    canvas.classList.remove('connect-active');
    if (connectMode._mouseMoveHandler) canvas.removeEventListener('mousemove', connectMode._mouseMoveHandler);
    if (connectMode._bgHandler) canvas.removeEventListener('click', connectMode._bgHandler);
    canvas.querySelectorAll('.connect-target').forEach(row => {
      row.classList.remove('connect-target');
      if (row._connectHandler) {
        row.removeEventListener('click', row._connectHandler, { capture: true });
        delete row._connectHandler;
      }
    });
    if (connectMode._escHandler) document.removeEventListener('keydown', connectMode._escHandler);
    if (_connectPreviewLine) { _connectPreviewLine.remove(); _connectPreviewLine = null; }
    connectMode = null;
  }

  function showFieldEditor(parentEl, rowEl, field, model, onDone) {
    // Remove any existing editor
    parentEl.querySelectorAll('.lemat-field-edit').forEach(el => el.remove());
    // Show all rows
    parentEl.querySelectorAll('.lemat-field-row').forEach(r => r.style.display = '');

    rowEl.style.display = 'none';
    const editRow = document.createElement('div');
    editRow.className = 'lemat-field-edit';

    const refOptions = schema.models
      .filter(m => m !== model)
      .flatMap(m => m.fields.filter(f => f.pk).map(f => `${m.name}.${f.name}`));

    editRow.innerHTML = `
      <input type="text" placeholder="nom du champ" value="${field.name}" class="fe-name" />
      <select class="fe-type">${LEMAT_TYPES.map(t => `<option ${t===field.type?'selected':''}>${t}</option>`).join('')}</select>
      <label title="Clé primaire"><input type="checkbox" class="fe-pk" ${field.pk?'checked':''}/> PK</label>
      <label title="Requis"><input type="checkbox" class="fe-req" ${field.required?'checked':''}/> Req</label>
      <label title="Unique"><input type="checkbox" class="fe-uq" ${field.unique?'checked':''}/> Uniq</label>
      ${refOptions.length ? `<select class="fe-ref"><option value="">— ref —</option>${refOptions.map(r => `<option ${r===field.ref?'selected':''}>${r}</option>`).join('')}</select>` : ''}
      <button class="btn-field-ok" title="Valider">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8l3 3 7-7"/></svg>
      </button>
      <button class="btn-field-cancel" title="Annuler">✕</button>`;
    rowEl.after(editRow);

    const nameInput = editRow.querySelector('.fe-name');
    nameInput.focus();
    if (!field.name) nameInput.placeholder = 'nom du champ';
    else nameInput.select();

    const save = () => {
      const n = nameInput.value.trim();
      if (!n) { cancel(); return; }
      field.name = n;
      field.type = editRow.querySelector('.fe-type').value;
      field.pk = editRow.querySelector('.fe-pk').checked;
      field.required = editRow.querySelector('.fe-req').checked;
      field.unique = editRow.querySelector('.fe-uq').checked;
      const refSel = editRow.querySelector('.fe-ref');
      field.ref = refSel ? refSel.value || null : field.ref;
      onDone();
    };
    const cancel = () => {
      if (!field.name) {
        const idx = model.fields.indexOf(field);
        if (idx >= 0) model.fields.splice(idx, 1);
      }
      onDone();
    };
    editRow.querySelector('.btn-field-ok').onclick = save;
    editRow.querySelector('.btn-field-cancel').onclick = cancel;
    nameInput.onkeydown = (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); };
  }

  // Toolbar actions
  toolbar.querySelector('#lemat-add-model').onclick = () => {
    prompt_('Nom du modèle (ex: User, Article)', '', (name) => {
      if (!name) return;
      schema.models.push({ name, fields: [
        { name: 'id', type: 'integer', decorators: '@id', pk: true, unique: false, required: false, default_: null, ref: null },
        { name: 'createdAt', type: 'datetime', decorators: '@default(now)', pk: false, unique: false, required: false, default_: 'now', ref: null },
      ]});
      markDirty(); render();
    });
  };

  toolbar.querySelector('#lemat-save').onclick = async () => {
    tab.content = lematToSource(schema);
    await api('PUT', `/api/projects/${currentProject}/files/${tab.path}`, { content: tab.content });
    tab.modified = false; renderTabs();
    toast('Schema sauvegardé', 'success');
  };

  toolbar.querySelector('#lemat-migrate').onclick = async () => {
    // Save first, then migrate
    tab.content = lematToSource(schema);
    await api('PUT', `/api/projects/${currentProject}/files/${tab.path}`, { content: tab.content });
    tab.modified = false; renderTabs();
    try {
      const res = await api('POST', `/api/projects/${currentProject}/schema/sync`);
      toast(res.message || 'Migration effectuée', 'success');
      await loadDbSection();
    } catch (e) { toast(e.message, 'error'); }
  };

  toolbar.querySelector('.btn-lemat-code').onclick = () => {
    tab.content = lematToSource(schema);
    _switchToLematCode(tab, container);
  };

  render();
}

function _switchToLematCode(tab, container) {
  if (tab.model) tab.model.dispose();
  tab.model = monaco.editor.createModel(tab.content, 'plaintext');
  tab.model.onDidChangeContent(() => {
    tab.modified = true;
    tab.content = tab.model.getValue();
    renderTabs();
  });
  tab._codeMode = true;
  container.querySelectorAll('.lemat-editor').forEach(el => el.remove());
  document.getElementById('monaco-container').style.display = 'block';

  // Add a mini toolbar above Monaco for switching back
  let codeBar = container.querySelector('.lemat-code-bar');
  if (!codeBar) {
    codeBar = document.createElement('div');
    codeBar.className = 'lemat-code-bar';
    codeBar.innerHTML = `
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M5 3L1 8l4 5"/><path d="M11 3l4 5-4 5"/></svg>
      <span>${tab.path}</span>
      <div style="flex:1"></div>
      <button class="btn-lemat" id="lemat-code-visual">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M2 6h12"/><path d="M6 2v4"/></svg>
        Visuel
      </button>
      <button class="btn-lemat" id="lemat-code-migrate">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4l6-3 6 3v8l-6 3-6-3V4z"/><path d="M2 4l6 3 6-3"/><path d="M8 7v8"/></svg>
        Migrer
      </button>`;
    container.insertBefore(codeBar, container.firstChild);
  }
  codeBar.querySelector('#lemat-code-visual').onclick = () => {
    tab.content = tab.model.getValue();
    tab._codeMode = false;
    codeBar.remove();
    showLematVisual(tab);
  };
  codeBar.querySelector('#lemat-code-migrate').onclick = async () => {
    tab.content = tab.model.getValue();
    await api('PUT', `/api/projects/${currentProject}/files/${tab.path}`, { content: tab.content });
    tab.modified = false; renderTabs();
    try {
      const res = await api('POST', `/api/projects/${currentProject}/schema/sync`);
      toast(res.message || 'Migration effectuée', 'success');
      await loadDbSection();
    } catch (e) { toast(e.message, 'error'); }
  };

  editor.setModel(tab.model);
  editor.layout();
  editor.focus();
}

// Override showTab for lemat tabs in code mode
const _origShowTab = showTab;
showTab = function(tab) {
  // Clean up code bar if switching away
  const codeBar = document.getElementById('editor-container').querySelector('.lemat-code-bar');
  if (codeBar && !(tab.type === 'lemat' && tab._codeMode)) codeBar.remove();

  if (tab.type === 'lemat' && tab._codeMode) {
    const container = document.getElementById('editor-container');
    container.querySelectorAll('.data-view').forEach(el => el.remove());
    container.querySelectorAll('.lemat-editor').forEach(el => el.remove());
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.style.display = 'none';
    _switchToLematCode(tab, container);
    return;
  }
  _origShowTab(tab);
};

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
    hint.textContent = 'Clique "Migrer" pour créer la base depuis le schéma';
    tree.appendChild(hint);
  }

  info.tables.forEach(t => {
    const wrap = document.createElement('div');

    const row = document.createElement('div');
    row.classList.add('db-table-item');
    row.innerHTML = `
      <span class="db-table-icon">${SVG_ICONS.table}</span>
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

  // Remove existing data view & lemat editor
  container.querySelectorAll('.data-view').forEach(el => el.remove());
  container.querySelectorAll('.lemat-editor').forEach(el => el.remove());

  const data = await api('GET', `/api/projects/${currentProject}/data/${tab.tableName}?limit=200`);

  // Get column metadata from schema
  const schemaInfo = dbSchema || await api('GET', `/api/projects/${currentProject}/schema`);
  const tableInfo = schemaInfo.tables.find(t => t.name === tab.tableName);
  const columns = tableInfo ? tableInfo.columns : [];

  const view = document.createElement('div');
  view.classList.add('data-view');

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.classList.add('data-view-toolbar');
  toolbar.innerHTML = `
    <span class="dv-title">${SVG_ICONS.table} <strong>${tab.tableName}</strong></span>
    <span class="dv-count">${data.total} ligne(s)</span>
    <div style="flex:1"></div>
    <button class="dv-btn dv-btn-primary" id="dv-add">${SVG_ICONS.plus} Nouveau</button>
    <button class="dv-btn" id="dv-refresh">${SVG_ICONS.refresh} Actualiser</button>`;
  view.appendChild(toolbar);

  // ── Create form (hidden by default) ──
  const formWrap = document.createElement('div');
  formWrap.classList.add('dv-create-form');
  formWrap.style.display = 'none';

  // For auto-increment PK, skip it
  const formCols = columns.filter(c => {
    if (c.pk && c.type.toUpperCase() === 'INTEGER') return false;
    return true;
  });

  // Detect FK fields from schema models
  const schemaModel = schemaInfo.schema
    ? (schemaInfo.schema.models || []).find(m => m.name.toLowerCase() === tab.tableName.toLowerCase())
    : null;

  // Build a map: colName → { refTable, refField } from schema
  const refMap = {};
  if (schemaModel) {
    schemaModel.fields.forEach(sf => {
      if (sf.ref) {
        const [refTable, refField] = sf.ref.split('.');
        refMap[sf.name] = { refTable, refField };
      }
    });
  }

  // Pre-fetch referenced table rows for FK selects
  const refDataCache = {};
  const refFetches = Object.entries(refMap).map(async ([colName, ref]) => {
    try {
      const refData = await api('GET', `/api/projects/${currentProject}/data/${ref.refTable}?limit=200`);
      refDataCache[colName] = { ref, rows: refData.rows || [] };
    } catch(e) { /* ignore */ }
  });
  await Promise.all(refFetches);

  let formHTML = '<div class="dv-form-header"><span>Nouvel enregistrement</span></div><div class="dv-form-fields">';
  formCols.forEach(col => {
    const required = col.notnull && !col.dflt_value ? ' *' : '';
    const refInfo = refDataCache[col.name];

    if (refInfo && refInfo.rows.length) {
      // FK field → render a <select> with referenced rows
      const ref = refInfo.ref;
      const rows = refInfo.rows;
      // Determine a display column (first non-PK text column, or second column)
      const refTableInfo = schemaInfo.tables.find(t => t.name === ref.refTable);
      const refCols = refTableInfo ? refTableInfo.columns.map(c => c.name) : (rows.length ? Object.keys(rows[0]) : []);
      const pkCol = ref.refField;
      const displayCol = refCols.find(c => c !== pkCol && c.toLowerCase() !== 'createdat') || refCols[1] || pkCol;

      let options = `<option value="">— Sélectionner ${ref.refTable} —</option>`;
      rows.forEach(r => {
        const pkVal = r[pkCol];
        const display = r[displayCol] || r[pkCol];
        const extra = displayCol !== pkCol ? ` (${pkCol}: ${pkVal})` : '';
        options += `<option value="${pkVal}">${display}${extra}</option>`;
      });

      formHTML += `
        <div class="dv-form-field">
          <label>${col.name}${required} <span class="dv-form-type">→ ${ref.refTable}</span></label>
          <select name="${col.name}" class="dv-form-ref-select">${options}</select>
        </div>`;
    } else {
      // Normal field → text input
      const placeholder = col.dflt_value ? `défaut: ${col.dflt_value}` : col.type;
      formHTML += `
        <div class="dv-form-field">
          <label>${col.name}${required} <span class="dv-form-type">${col.type}</span></label>
          <input type="text" name="${col.name}" placeholder="${placeholder}" autocomplete="off" spellcheck="false" />
        </div>`;
    }
  });
  formHTML += '</div><div class="dv-form-actions">';
  formHTML += `<button class="dv-btn dv-btn-primary" id="dv-form-save">${SVG_ICONS.save} Enregistrer</button>`;
  formHTML += `<button class="dv-btn" id="dv-form-cancel">${SVG_ICONS.close} Annuler</button>`;
  formHTML += '</div>';
  formWrap.innerHTML = formHTML;
  view.appendChild(formWrap);

  // Grid
  const wrap = document.createElement('div');
  wrap.classList.add('data-grid-wrap');

  const cols = data.rows.length ? Object.keys(data.rows[0]) : columns.map(c => c.name);

  if (!data.rows.length) {
    wrap.innerHTML = `<div class="data-empty">
      <div class="data-empty-icon">${SVG_ICONS.table}</div>
      <p>Aucune donnée dans cette table.</p>
      <button class="dv-btn dv-btn-primary dv-btn-empty-add">${SVG_ICONS.plus} Ajouter un enregistrement</button>
    </div>`;
  } else {
    const table = document.createElement('table');
    table.classList.add('data-grid');

    // Header
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr>' + cols.map(c => {
      const colInfo = columns.find(ci => ci.name === c);
      const pk = colInfo && colInfo.pk ? ' <span class="dv-col-pk">PK</span>' : '';
      return `<th>${c}${pk}</th>`;
    }).join('') + '<th></th></tr>';
    table.appendChild(thead);

    // Rows
    const tbody = document.createElement('tbody');
    data.rows.forEach(row => {
      const tr = document.createElement('tr');
      tr.dataset.rowData = JSON.stringify(row);
      cols.forEach((col, i) => {
        const td = document.createElement('td');
        const val = row[col];
        if (val === null || val === undefined) {
          td.classList.add('null-val');
          td.textContent = 'null';
        } else {
          td.textContent = String(val);
        }
        // First column = PK styling
        const colInfo = columns.find(ci => ci.name === col);
        if (colInfo && colInfo.pk) td.classList.add('pk-val');
        tr.appendChild(td);
      });
      // Actions cell
      const actionsTd = document.createElement('td');
      actionsTd.classList.add('row-actions-cell');
      const hasRelations = schemaInfo.schema && schemaInfo.schema.relations && schemaInfo.schema.relations.length > 0;
      actionsTd.innerHTML = `<span class="row-actions">
        ${hasRelations ? `<button class="btn-row-expand" title="Voir les relations">${SVG_ICONS.table}</button>` : ''}
        <button class="btn-row-del" title="Supprimer">${SVG_ICONS.trash}</button>
      </span>`;
      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    // Expand row to show related data
    tbody.addEventListener('click', async (e) => {
      const expandBtn = e.target.closest('.btn-row-expand');
      if (expandBtn) {
        const tr = expandBtn.closest('tr');
        // Toggle: if already expanded, close it
        const existing = tr.nextElementSibling;
        if (existing && existing.classList.contains('dv-related-row')) {
          existing.remove();
          tr.classList.remove('row-expanded');
          return;
        }
        // Close any other expanded row
        tbody.querySelectorAll('.dv-related-row').forEach(el => el.remove());
        tbody.querySelectorAll('.row-expanded').forEach(el => el.classList.remove('row-expanded'));

        const rowData = JSON.parse(tr.dataset.rowData);
        const pkCol = columns.find(c => c.pk);
        const pkName = pkCol ? pkCol.name : cols[0];
        const pkVal = rowData[pkName];

        tr.classList.add('row-expanded');
        const relTr = document.createElement('tr');
        relTr.classList.add('dv-related-row');
        const relTd = document.createElement('td');
        relTd.colSpan = cols.length + 1;
        relTd.innerHTML = '<div class="dv-related-loading">Chargement des relations...</div>';
        relTr.appendChild(relTd);
        tr.after(relTr);

        try {
          const related = await api('GET', `/api/projects/${currentProject}/data/${tab.tableName}/${pkVal}/related`);
          let html = '<div class="dv-related-panel">';

          // Parents
          if (related.parents.length) {
            html += '<div class="dv-related-section"><div class="dv-related-section-title">Références</div>';
            related.parents.forEach(p => {
              const display = Object.values(p.row).slice(0, 3).join(' · ');
              html += `<div class="dv-related-item dv-related-parent" data-table="${p.table}" data-pk="${Object.values(p.row)[0]}">
                <span class="dv-related-badge parent">${p.table}</span>
                <span class="dv-related-via">${p.field} →</span>
                <span class="dv-related-preview">${display}</span>
              </div>`;
            });
            html += '</div>';
          }

          // Children
          if (related.children.length) {
            html += '<div class="dv-related-section"><div class="dv-related-section-title">Référencé par</div>';
            related.children.forEach(c => {
              html += `<div class="dv-related-group">
                <div class="dv-related-group-header">
                  <span class="dv-related-badge child">${c.table}</span>
                  <span class="dv-related-count">${c.total} enregistrement${c.total > 1 ? 's' : ''}</span>
                </div>`;
              if (c.rows.length) {
                html += '<div class="dv-related-mini-table"><table>';
                const childCols = Object.keys(c.rows[0]);
                html += '<tr>' + childCols.map(cc => `<th>${cc}</th>`).join('') + '</tr>';
                c.rows.slice(0, 5).forEach(r => {
                  html += '<tr>' + childCols.map(cc => {
                    const v = r[cc];
                    return `<td>${v === null ? '<em>null</em>' : v}</td>`;
                  }).join('') + '</tr>';
                });
                if (c.total > 5) html += `<tr><td colspan="${childCols.length}" class="dv-related-more">+ ${c.total - 5} autres...</td></tr>`;
                html += '</table></div>';
              }
              html += '</div>';
            });
            html += '</div>';
          }

          if (!related.parents.length && !related.children.length) {
            html += '<div class="dv-related-empty">Aucune relation trouvée pour cet enregistrement.</div>';
          }

          html += '</div>';
          relTd.innerHTML = html;

          // Click parent → navigate to that table/row
          relTd.querySelectorAll('.dv-related-parent').forEach(el => {
            el.style.cursor = 'pointer';
            el.onclick = () => openDataView(el.dataset.table);
          });
        } catch(err) {
          relTd.innerHTML = `<div class="dv-related-empty">Erreur: ${err.message}</div>`;
        }
        return;
      }
    });

    // Delete row
    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('.btn-row-del');
      if (!btn) return;
      const tr = btn.closest('tr');
      const rowData = JSON.parse(tr.dataset.rowData);
      const pkCol = columns.find(c => c.pk);
      const pkName = pkCol ? pkCol.name : cols[0];
      const pkVal = rowData[pkName];
      try {
        await api('DELETE', `/api/projects/${currentProject}/data/${tab.tableName}/${pkVal}`);
        tr.remove();
        toast('Ligne supprimée', 'success');
        // Update count
        const countEl = toolbar.querySelector('.dv-count');
        const current = parseInt(countEl.textContent) || 0;
        countEl.textContent = `${Math.max(0, current - 1)} ligne(s)`;
      } catch(err) { toast(err.message, 'error'); }
    });

    wrap.appendChild(table);
  }

  view.appendChild(wrap);
  container.appendChild(view);

  // ── Event handlers ──
  const toggleForm = (show) => {
    formWrap.style.display = show ? 'flex' : 'none';
    if (show) {
      formWrap.querySelectorAll('input').forEach(inp => inp.value = '');
      formWrap.querySelectorAll('select').forEach(sel => sel.selectedIndex = 0);
      const firstField = formWrap.querySelector('input, select');
      if (firstField) setTimeout(() => firstField.focus(), 50);
    }
  };

  toolbar.querySelector('#dv-add').onclick = () => toggleForm(true);
  toolbar.querySelector('#dv-refresh').onclick = () => showDataTab(tab);
  formWrap.querySelector('#dv-form-cancel').onclick = () => toggleForm(false);

  // Empty state "Ajouter" button
  const emptyAddBtn = wrap.querySelector('.dv-btn-empty-add');
  if (emptyAddBtn) emptyAddBtn.onclick = () => toggleForm(true);

  // Save new record
  formWrap.querySelector('#dv-form-save').onclick = async () => {
    const inputs = formWrap.querySelectorAll('.dv-form-fields input, .dv-form-fields select');
    const record = {};
    let hasValue = false;
    inputs.forEach(inp => {
      const val = inp.value.trim();
      if (val !== '') {
        // Try to parse numbers
        const num = Number(val);
        record[inp.name] = (val !== '' && !isNaN(num) && String(num) === val) ? num : val;
        hasValue = true;
      }
    });
    if (!hasValue) { toast('Remplis au moins un champ', 'error'); return; }
    try {
      await api('POST', `/api/projects/${currentProject}/data/${tab.tableName}`, record);
      toast('Enregistrement créé', 'success');
      toggleForm(false);
      await showDataTab(tab); // Refresh the view
    } catch(err) { toast(err.message || 'Erreur lors de la création', 'error'); }
  };

  // Enter key in form → save
  formWrap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); formWrap.querySelector('#dv-form-save').click(); }
    if (e.key === 'Escape') { toggleForm(false); }
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
  const backdrop = document.getElementById('confirm-backdrop');
  document.getElementById('confirm-msg').textContent = msg;
  backdrop.classList.remove('hidden');
  document.getElementById('confirm-yes').onclick = () => { backdrop.classList.add('hidden'); cb(); };
  document.getElementById('confirm-no').onclick  = () => backdrop.classList.add('hidden');
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

