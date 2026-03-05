# Le Mat — Guide de développement

> **Le Mat** est une plateforme de déploiement web self-hosted. Elle te permet de créer et éditer des projets directement dans le navigateur, de connecter une base de données SQLite, et d'obtenir un live-reload automatique à chaque sauvegarde.

---

## Sommaire

1. [Interface](#1-interface)
2. [Créer un projet](#2-créer-un-projet)
3. [Gérer les fichiers](#3-gérer-les-fichiers)
4. [HTML, CSS et JavaScript](#4-html-css-et-javascript)
5. [Base de données : le fichier `.lemat`](#5-base-de-données--le-fichier-lemat)
6. [Synchroniser le schéma](#6-synchroniser-le-schéma)
7. [Utiliser le SDK LeMat en JS](#7-utiliser-le-sdk-lemat-en-js)
8. [Navigateur de données](#8-navigateur-de-données)
9. [Exécuter du code Python / Node](#9-exécuter-du-code-python--node)
10. [Raccourcis clavier](#10-raccourcis-clavier)
11. [Exemple complet : formulaire → DB](#11-exemple-complet--formulaire--db)

---

## 1. Interface

```
┌──────────────────────────────────────────────────────────────┐
│ Sidebar             │ Barre d'onglets + Run toolbar           │
│                     │─────────────────────────────────────────│
│  ♟ Le Mat           │  [index.html ●] [style.css]   ▶ Run …  │
│                     │                                         │
│  Projets            │                                         │
│  ├─ 📦 Newlife      │   Monaco Editor                         │
│  └─ 📦 MonApp       │   (éditeur de code)                     │
│                     │                                         │
│  Fichiers           │─────────────────────────────────────────│
│  ├─ 📄 index.html   │  Logs                                   │
│  ├─ 🎨 style.css    │  $ node server.js                       │
│  └─ ⚡ app.js       │  Listening on port 3000                 │
│                     │                                         │
│  Base de données    │                                         │
│  └─ 🗄 Subscriber   │                                         │
└──────────────────────────────────────────────────────────────┘
```

- **Sidebar gauche** : navigation projets, fichiers, tables DB
- **Zone centrale** : éditeur Monaco (coloration syntaxique, autocomplétion)
- **Panneau Logs** : sortie stdout/stderr des scripts exécutés
- **Barre d'onglets** : plusieurs fichiers ouverts simultanément, `●` = modifications non sauvegardées

---

## 2. Créer un projet

1. Clique sur le **`+`** à côté de "Projets" dans la sidebar
2. Entre un nom (ex : `MonApp`) → **OK**
3. Le projet apparaît dans la liste et devient actif

Le projet est stocké dans `/data/projects/MonApp/` sur le serveur.

---

## 3. Gérer les fichiers

### Créer un fichier
Clique sur **📄** dans la section "Fichiers" → entre le nom avec son extension (`index.html`, `app.js`, etc.)

### Créer un dossier
Clique sur **📁** → entre le nom du dossier. Les sous-dossiers sont supportés (`css/style.css`).

### Uploader des fichiers
Clique sur **⬆** → sélectionne un ou plusieurs fichiers depuis ton ordinateur.

### Supprimer un fichier
Clique sur **✕** à droite du nom du fichier dans l'arbre. Une confirmation est demandée.

### Sauvegarder
**`Ctrl+S`** (ou `⌘S` sur Mac) depuis l'éditeur. Le fichier est sauvegardé et le live-reload se déclenche si le projet est ouvert dans un onglet navigateur.

---

## 4. HTML, CSS et JavaScript

### Lancer le projet web
1. Ouvre n'importe quel fichier HTML/CSS/JS
2. Clique sur **▶ Run** (ou appuie sur **F5**)
3. Le projet s'ouvre dans un nouvel onglet à l'URL `/projects/<nom-projet>/`

> Les appels suivants à Run **réutilisent le même onglet** (ils n'en ouvrent pas un nouveau à chaque fois).

### Lier CSS et JS dans le HTML

Utilise des chemins relatifs classiques — Le Mat sert les fichiers du projet directement :

```html
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <title>Mon App</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <h1>Hello</h1>
  <script src="app.js"></script>
</body>
</html>
```

Si ton projet a un sous-dossier `css/` :
```html
<link rel="stylesheet" href="css/main.css" />
```

### Live reload automatique

À chaque **`Ctrl+S`**, Le Mat injecte un signal WebSocket dans la page ouverte dans le navigateur → la page se recharge automatiquement sans que tu aies à appuyer sur F5.

> **Note** : Le Mat injecte automatiquement un petit script dans ton HTML au moment de le servir (live-reload + SDK). Ce script n'est **pas** écrit dans ton fichier source.

---

## 5. Base de données : le fichier `.lemat`

Le fichier `.lemat` est le **schéma de ta base de données**. C'est un langage simple qui décrit tes modèles (tables).

### Syntaxe de base

```
database "nomfichier.db"

model NomDuModele {
  champ     type      @decorateur
  champ2    type
}
```

### Types disponibles

| Type       | Correspondance SQLite |
|------------|-----------------------|
| `integer`  | INTEGER               |
| `text`     | TEXT                  |
| `real`     | REAL                  |
| `boolean`  | INTEGER (0/1)         |
| `datetime` | TEXT (ISO 8601)       |
| `blob`     | BLOB                  |
| `json`     | TEXT                  |

### Décorateurs

| Décorateur         | Effet                                      |
|--------------------|--------------------------------------------|
| `@id`              | Clé primaire + AUTOINCREMENT               |
| `@required`        | NOT NULL                                   |
| `@unique`          | UNIQUE constraint                          |
| `@default(valeur)` | Valeur par défaut (ex: `@default("user")`) |
| `@default(now)`    | Date/heure courante à l'insertion          |
| `@ref(Model.field)`| Clé étrangère (FOREIGN KEY)                |

### Exemple complet

```
database "blog.db"

model User {
  id        integer   @id
  username  text      @unique @required
  email     text      @unique @required
  role      text      @default("reader")
  createdAt datetime  @default(now)
}

model Post {
  id          integer   @id
  title       text      @required
  content     text
  published   boolean   @default(false)
  authorId    integer   @ref(User.id)
  createdAt   datetime  @default(now)
}

model Comment {
  id        integer   @id
  body      text      @required
  postId    integer   @ref(Post.id)
  authorId  integer   @ref(User.id)
  createdAt datetime  @default(now)
}
```

> **Nommage** : Le nom du modèle est utilisé comme nom de table SQLite et comme clé dans le SDK JS. Utilise du PascalCase (`User`, `BlogPost`).

---

## 6. Synchroniser le schéma

Après avoir écrit ou modifié ton fichier `.lemat` :

1. **Ctrl+S** pour sauvegarder le fichier `.lemat`
2. Dans la sidebar, clique sur **⚡ Sync** dans la section "Base de données"
3. Le Mat parse le schéma et exécute `CREATE TABLE IF NOT EXISTS` sur la base SQLite

> **Idempotent** : Sync n'efface jamais les données existantes. Si une table existe déjà, elle est conservée telle quelle. Pour modifier une colonne existante, il faut créer une migration manuelle.

Le fichier `.db` est créé automatiquement dans ton projet avec le nom défini dans `database "..."`.

---

## 7. Utiliser le SDK LeMat en JS

Le SDK est **injecté automatiquement** dans toutes les pages HTML servies par Le Mat. Tu n'as rien à importer.

### Objet global `window.LeMat`

```js
// Chaque modèle défini dans ton .lemat est disponible comme :
LeMat.NomDuModele.all()         // → Promise<{ rows: [...] }>
LeMat.NomDuModele.find(id)      // → Promise<{...}>
LeMat.NomDuModele.create(data)  // → Promise<{...}>  (201)
LeMat.NomDuModele.update(id, data) // → Promise<{...}>
LeMat.NomDuModele.delete(id)    // → Promise<{ deleted: true }>
```

### Exemples

```js
// Récupérer tous les utilisateurs
const result = await LeMat.User.all();
console.log(result.rows); // tableau d'objets

// Filtrer et paginer
const result = await LeMat.User.all({ limit: 10, offset: 20 });

// Créer un enregistrement
const newUser = await LeMat.User.create({
  username: 'alice',
  email: 'alice@example.com',
  role: 'admin',
});
console.log(newUser.id); // l'ID auto-incrémenté

// Mettre à jour
await LeMat.User.update(newUser.id, { role: 'reader' });

// Supprimer
await LeMat.User.delete(newUser.id);

// Chercher un enregistrement par ID
const user = await LeMat.User.find(1);
```

### Gestion des erreurs

Le SDK renvoie une `Promise` rejetée si le serveur répond avec une erreur :

```js
try {
  await LeMat.User.create({ email: 'deja@existant.com' });
} catch (err) {
  // err est l'objet JSON d'erreur du serveur
  if (err?.detail?.includes('UNIQUE')) {
    alert('Cet email est déjà utilisé.');
  }
}
```

---

## 8. Navigateur de données

Quand un `.lemat` est présent et synchronisé, la section **"Base de données"** apparaît dans la sidebar.

- **Clic sur une table** → ouvre un onglet avec la grille de données
- **Bouton ↺ Actualiser** → recharge les lignes
- **Bouton 🗑** sur une ligne → supprime la ligne (demande confirmation)
- Les badges **PK** (clé primaire) et **NN** (not null) sont affichés sur chaque colonne

> La grille est en lecture/écriture partielle : suppression uniquement pour l'instant. Pour insérer des données manuellement, utilise le SDK depuis la console du navigateur ou un formulaire dans ton app.

---

## 9. Exécuter du code Python / Node

Les fichiers `.py`, `.js`, `.mjs`, `.ts`, `.sh` peuvent être **exécutés directement** depuis Le Mat.

1. Ouvre le fichier dans l'éditeur
2. Clique sur **▶ Run** (ou **F5**)
3. La sortie stdout/stderr apparaît dans le panneau **Logs**

### Commande custom

Tu peux entrer une commande personnalisée dans le champ **"commande custom…"** avant de cliquer Run :

```
python3 -m pytest tests/
```
```
node --experimental-fetch server.js
```
```
bash deploy.sh production
```

### Arrêter un processus
Clique sur **■** dans la toolbar. Le processus est tué côté serveur.

---

## 10. Raccourcis clavier

| Raccourci     | Action                                    |
|---------------|-------------------------------------------|
| `Ctrl+S`      | Sauvegarder + déclencher live reload      |
| `F5`          | Run (ouvre dans navigateur ou exécute)    |
| `Ctrl+W`      | Fermer l'onglet actif                     |
| `Ctrl+Z`      | Annuler (dans l'éditeur)                  |
| `Ctrl+/`      | Commenter/décommenter une ligne           |
| `Alt+↑/↓`     | Déplacer une ligne vers le haut/bas       |
| `Ctrl+D`      | Sélectionner l'occurrence suivante        |
| `Ctrl+F`      | Rechercher dans le fichier                |
| `Ctrl+H`      | Remplacer dans le fichier                 |

---

## 11. Exemple complet : formulaire → DB

Voici un exemple bout-en-bout d'un formulaire d'inscription connecté à la base de données.

### Étape 1 — Créer le schéma (`models.lemat`)

```
database "monapp.db"

model Subscriber {
  id        integer   @id
  prenom    text      @required
  nom       text
  email     text      @unique @required
  createdAt datetime  @default(now)
}
```

### Étape 2 — Synchroniser

Ctrl+S → **⚡ Sync** dans la sidebar.

### Étape 3 — HTML du formulaire (`index.html`)

```html
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <title>Inscription</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <form id="form">
    <input id="prenom" type="text"  placeholder="Prénom" required />
    <input id="nom"    type="text"  placeholder="Nom" />
    <input id="email"  type="email" placeholder="Email" required />
    <button type="submit">S'inscrire</button>
  </form>
  <p id="msg"></p>
  <script src="app.js"></script>
</body>
</html>
```

### Étape 4 — JavaScript (`app.js`)

```js
document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const prenom = document.getElementById('prenom').value.trim();
  const nom    = document.getElementById('nom').value.trim();
  const email  = document.getElementById('email').value.trim();
  const msg    = document.getElementById('msg');

  try {
    const subscriber = await LeMat.Subscriber.create({ prenom, nom, email });
    msg.textContent = `Merci ${subscriber.prenom} ! Inscription réussie.`;
    msg.style.color = 'green';
    e.target.reset();
  } catch (err) {
    if (err?.detail?.includes('UNIQUE')) {
      msg.textContent = 'Cet email est déjà inscrit.';
    } else {
      msg.textContent = 'Une erreur est survenue. Réessaie.';
    }
    msg.style.color = 'red';
  }
});
```

### Étape 5 — Lancer et tester

1. **▶ Run** → le projet s'ouvre dans le navigateur
2. Remplis le formulaire → les données sont insérées dans `monapp.db`
3. Dans la sidebar, clique sur **Subscriber** → la ligne apparaît dans la grille de données
4. Modifie le CSS → **Ctrl+S** → la page se recharge automatiquement

---

## Architecture interne (pour les curieux)

```
Navigateur                    Serveur Le Mat (FastAPI)
─────────────                 ────────────────────────
/editor/           ──GET──►  StaticFiles (index.html, app.js, style.css)
/api/projects      ──GET──►  Liste des projets dans /data/projects/
/api/projects/X/tree         Arbre de fichiers du projet X
/api/projects/X/files/path   CRUD fichiers (GET/PUT/DELETE)
/api/projects/X/schema       Informations sur le schéma .lemat
/api/projects/X/schema/sync  Parse .lemat → CREATE TABLE SQLite
/api/projects/X/lemat-sdk.js SDK JS auto-généré à partir du .lemat
/api/projects/X/data/Table   CRUD données (GET/POST/PUT/DELETE)
/api/projects/X/exec/file    SSE streaming d'exécution (Python/Node/Bash)
/projects/X/       ──GET──►  Sert index.html + injecte live-reload + SDK
ws://.../livereload           WebSocket pour déclencher location.reload()
```

---

*Le Mat — fait pour déployer vite, sans friction.*
