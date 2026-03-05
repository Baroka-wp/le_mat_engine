# 🚀 Le Mat - Guide de Déploiement

Déployez vos applications Le Mat en un clic et accédez-y depuis n'importe où.

---

## 📋 Sommaire

1. [Déployer un projet](#-déployer-un-projet)
2. [Lien de déploiement](#-lien-de-déploiement)
3. [Domaine personnalisé](#-domaine-personnalisé)
4. [API de déploiement](#-api-de-déploiement)
5. [Configuration DNS](#-configuration-dns)

---

## 🎯 Déployer un projet

### Via l'interface

1. Ouvrez votre projet dans Le Mat
2. Cliquez sur le bouton 🚀 dans le sidebar
3. Cliquez sur **"Déployer maintenant"**
4. Votre lien unique est généré instantanément

### Via l'API

```bash
curl -X POST http://localhost:8000/api/projects/{nom_projet}/deploy
```

**Réponse :**
```json
{
  "deployed": true,
  "deploy_url": "https://monprojet-a1b2c3d4.deploy.lemat.app",
  "token": "a1b2c3d4",
  "message": "Projet déployé avec succès"
}
```

---

## 🔗 Lien de déploiement

Chaque projet déployé reçoit un lien unique :

```
https://{projet}-{token}.deploy.lemat.app
```

- **{projet}** : Nom de votre projet
- **{token}** : Token d'authentification unique (8 caractères)

### Token d'authentification

Le token sert à authentifier les requêtes API vers votre projet déployé.

**Exemple d'utilisation :**
```javascript
fetch('https://monprojet-a1b2c3d4.deploy.lemat.app/api/data', {
  headers: {
    'X-Deploy-Token': 'a1b2c3d4'
  }
})
```

---

## 🌐 Domaine personnalisé

### Configuration

1. Dans le modal de déploiement, entrez votre domaine :
   - `app.example.com`
   - `monsite.fr`
   - `www.monapp.com`

2. Cliquez sur **"Configurer"**

3. Configurez l'enregistrement DNS chez votre registrar :

```
Type:    CNAME
Nom:     app.example.com
Valeur:  monprojet-a1b2c3d4.deploy.lemat.app
TTL:     3600 (1h)
```

4. Cliquez sur **"Vérifier la configuration DNS"**

### Exemples de configuration DNS

**Cloudflare :**
```
Type: CNAME
Name: app
Target: monprojet-a1b2c3d4.deploy.lemat.app
TTL: Auto
```

**OVH :**
```
Champ: app
Type: CNAME
Cible: monprojet-a1b2c3d4.deploy.lemat.app
```

**Namecheap :**
```
Type: CNAME Record
Host: app
Value: monprojet-a1b2c3d4.deploy.lemat.app
TTL: 1h
```

### Propagation DNS

La propagation DNS peut prendre de quelques minutes à 48 heures selon votre registrar.

---

## 🛠️ API de déploiement

### Récupérer les infos de déploiement

```http
GET /api/projects/{project}/deploy
```

```json
{
  "deployed": true,
  "deploy_url": "https://monprojet-a1b2c3d4.deploy.lemat.app",
  "token": "a1b2c3d4",
  "custom_domain": "app.example.com",
  "dns_configured": true,
  "created_at": "2025-03-05T10:30:00Z"
}
```

### Déployer un projet

```http
POST /api/projects/{project}/deploy
```

### Configurer un domaine personnalisé

```http
POST /api/projects/{project}/deploy/domain
Content-Type: application/json

{
  "domain": "app.example.com"
}
```

### Vérifier la configuration DNS

```http
GET /api/projects/{project}/deploy/verify
```

### Supprimer un domaine personnalisé

```http
DELETE /api/projects/{project}/deploy/domain
```

### Arrêter le déploiement

```http
DELETE /api/projects/{project}/deploy
```

### Lister tous les déploiements

```http
GET /api/deployments
```

---

## 📁 Structure des fichiers déployés

Votre projet déployé contient :

```
{projet}/
├── index.html          # Page d'accueil
├── style.css           # Feuilles de style
├── app.js              # Scripts JavaScript
├── *.db                # Base de données SQLite
├── smtp.json           # Configuration SMTP
├── crons.json          # Tâches planifiées
└── ...                 # Autres fichiers
```

Tous les fichiers statiques sont accessibles publiquement via le lien de déploiement.

---

## 🔐 Sécurité

- **Token unique** : Chaque déploiement génère un token aléatoire
- **Isolation** : Les projets sont isolés les uns des autres
- **HTTPS** : Les liens de déploiement utilisent HTTPS (via le proxy inverse)

### Bonnes pratiques

1. **Ne partagez pas votre token** avec des personnes non autorisées
2. **Utilisez un domaine personnalisé** pour une URL professionnelle
3. **Sauvegardez votre token** dans un gestionnaire de mots de passe

---

## ⚙️ Configuration avancée

### Variable d'environnement

Pour changer le domaine de déploiement par défaut :

```bash
export DEPLOY_HOST="deploy.mondomaine.com"
python main.py
```

### Proxy inverse (Nginx)

Pour router les domaines personnalisés vers Le Mat :

```nginx
server {
    listen 80;
    server_name *.deploy.lemat.app;

    location / {
        proxy_pass http://localhost:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## ❓ FAQ

### Puis-je redéployer un projet déjà déployé ?
Oui, le déploiement est idempotent. Si le projet est déjà déployé, vous recevrez les mêmes informations.

### Que se passe-t-il si je supprime un projet déployé ?
Le déploiement est automatiquement arrêté et le domaine personnalisé est libéré.

### Puis-je changer le domaine personnalisé ?
Oui, supprimez l'ancien domaine et configurez-en un nouveau.

### Le déploiement est-il persistant ?
Oui, les déploiements sont stockés dans `/data/deployments.json`.

---

## 📞 Support

Pour toute question ou problème, consultez la documentation principale ou ouvrez une issue.
