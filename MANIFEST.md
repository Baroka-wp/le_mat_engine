# LEMAT — Manifest v1.0

> *Build data-centric web apps the way they should be built: start with the data, let everything else follow.*

---

## Ce qu'est LEMAT

LEMAT est un **Data-Centric App Builder** pour développeurs. Il combine un environnement de développement et un runtime d'exécution pour créer, déployer et faire évoluer des applications web métier rapidement, en toute sécurité, sans plomberie répétitive.

LEMAT n'est pas un framework. Ce n'est pas non plus un outil no-code. C'est un **environnement opinionné** qui automatise tout ce qui peut l'être — et laisse le développeur maître de tout ce qui doit l'être.

---

## Le problème

Construire une app web data-centrique aujourd'hui impose de répéter les mêmes tâches pour chaque projet :

- Définir un schéma de base de données et gérer les migrations
- Écrire des endpoints CRUD pour chaque modèle
- Implémenter un système d'authentification et de gestion des rôles
- Câbler le frontend à l'API
- Configurer un déploiement

Ce travail de plomberie représente 60 à 80 % du temps de développement initial, pour une valeur métier proche de zéro.

---

## La réponse LEMAT

**Un seul flux canonique, du schéma à l'app déployée :**

```
Schema (.lemat)
  ↓
Base de données auto-migrée (SQLite / PostgreSQL)
  ↓
API CRUD auto-générée + règles d'accès déclaratives
  ↓
SDK client auto-généré (JS)
  ↓
UI déduite (Table, Form, Dashboard, Detail)
  + Logique custom (Python hooks, Cron, SMTP, WebSocket, LLM, Paiement)
  ↓
Deploy one-click
```

Le développeur définit **quoi** — LEMAT gère **comment**.

---

## Principes fondamentaux

### 1. Data First
L'application naît du modèle de données. Le schéma est la source de vérité. Tout — API, UI, permissions — en est une déduction directe ou un enrichissement explicite.

### 2. Sécurité by Default
Aucune donnée n'est exposée sans déclaration explicite. L'authentification, l'isolation des projets et le contrôle d'accès par rôle (RBAC) sont activés d'office. La sécurité ne se configure pas — elle se désactive intentionnellement si nécessaire.

### 3. Logique en langage haut-niveau
La logique métier s'exprime dans un DSL proche du langage naturel ou en Python simple, sans boilerplate. Les hooks (`before_create`, `after_update`, `on_delete`) permettent d'étendre le comportement sans toucher au runtime.

### 4. Le développeur reste maître du code
LEMAT n'est pas une boîte noire. Le code généré est lisible, les fichiers sont exportables, il n'y a pas de lock-in. Un projet LEMAT peut être éjecté vers un projet FastAPI/SQLite standard à tout moment.

### 5. Services de première classe
SMTP, Cron, WebSocket, LLM, Paiement, APIs externes — ces services ne sont pas des plugins ajoutés après coup. Ce sont des primitives du langage LEMAT, déclarées dans le schéma, aussi simplement que l'on déclare un champ.

---

## Ce que LEMAT cible

**Cible principale : développeurs web (junior à senior)**
qui construisent des apps métier, des portails, des outils internes, des dashboards, des SaaS data-centriques.

**Classes d'applications couvertes :**
- CRM, ERP, outils de gestion interne
- Portails clients / fournisseurs
- Dashboards et reporting
- Apps de formulaires et workflows
- Petits SaaS data-driven

**Hors scope délibéré :**
- Jeux vidéo
- Apps temps-réel ultra-complexes (trading, streaming vidéo)
- Sites vitrines purement statiques
- Apps avec UX très custom nécessitant un framework frontend dédié (React/Vue full custom)

---

## Le modèle de projet LEMAT

```
/mon-projet/
  schema.lemat          ← Définition des modèles de données, relations, types
  config.lemat          ← Auth, rôles, services activés, variables d'environnement
  logic/
    hooks.py            ← Fonctions Python (before_create, after_update, …)
    crons.py            ← Jobs planifiés
  pages/
    index.lemat-page    ← Pages UI (layout + composants bindés aux données)
  static/               ← Assets statiques (images, fonts, overrides CSS)
  .lemat/
    db.sqlite           ← Base de données du projet (isolée)
    migrations/         ← Historique des migrations auto-générées
```

---

## Le runtime LEMAT

Chaque projet LEMAT est une **application isolée** avec :

- Ses propres routes HTTP (`/p/<project>/...`)
- Sa propre base de données (`data/<project>/db.sqlite`)
- Son propre contexte d'authentification
- Son propre système de permissions

Le runtime LEMAT est le serveur FastAPI central qui interprète les schémas, sert les apps, et orchestre les services. Il n'est pas un framework — c'est un moteur d'exécution.

---

## Feuille de route

| Phase | Objectif | Statut |
|-------|----------|--------|
| **0 — Runtime** | Isolation projet, router LEMAT, structure de fichiers standard | 🔄 En cours |
| **1 — Data Layer** | Schéma riche, migrations auto, Data Browser, relations | ⬜ Planifié |
| **2 — Controller Layer** | API auto-générée, permissions RBAC, hooks Python | ⬜ Planifié |
| **3 — UI Layer** | Vues auto-déduites, composants, query builder, binding | ⬜ Planifié |
| **4 — Auth & Sécurité** | Auth intégrée, RBAC, row-level security | ⬜ Planifié |
| **5 — Services** | WebSocket, LLM, Paiement, Storage | ⬜ Planifié |
| **6 — Deploy** | One-click deploy, export sans lock-in | 🔄 Partiel |

---

## Ce que LEMAT n'est pas

- **Pas WordPress** — pas de thèmes, pas de plugins opaques
- **Pas Bubble** — pas de no-code, le développeur écrit du vrai code
- **Pas un générateur de scaffold** — il n'écrit pas de code que vous maintenez ensuite seul
- **Pas un ORM** — il abstrait plus haut que ça
- **Pas un cloud propriétaire** — il tourne sur votre infrastructure

---

## Le standard de qualité

Une feature n'entre dans LEMAT que si elle respecte les trois règles :

1. **Elle réduit le code à écrire**, pas seulement la complexité perçue.
2. **Elle ne cache pas** ce qui se passe — un développeur peut toujours inspecter, déboguer, remplacer.
3. **Elle compose** avec le reste du système sans friction.

---

*LEMAT — Less boilerplate. More product.*
