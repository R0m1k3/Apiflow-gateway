# Gateway Hostinger — frps + miroir PostgreSQL

Côté VPS Hostinger. Reçoit le tunnel frp du serveur Debian du magasin et recopie chaque jour
la base PostgreSQL Debian dans le PostgreSQL Hostinger (`postgres_db`).

## Architecture

```
Serveur Debian (magasin)                       VPS Hostinger (réseau Docker externe nginx_default)
┌──────────────────────────┐   tunnel frp     ┌──────────────────────────────────────────────────┐
│ frpc 0.71.0 ─────────────┼── :7000 (TLS) ──▶│ ff_frps (snowdreamtech/frps:0.71.0-alpine)       │
│   API Debian  :3000 ─────┼──────────────────│   → ff_frps:13000  (API Debian)                  │
│   PostgreSQL  :5432 ─────┼──────────────────│   → ff_frps:15432  (PostgreSQL Debian)           │
└──────────────────────────┘                  │                                                  │
                                              │ ff_sync_hostinger (Node 22)                      │
                                              │   lit  frps:15432  (source, lecture seule)       │
                                              │   écrit postgres_db:5432 (destination)           │
                                              │   dashboard :3002 ◀── Nginx Proxy Manager (HTTPS)│
                                              └──────────────────────────────────────────────────┘
```

- Seul le port **7000** est publié sur l'hôte (connexion frpc). Les ports 13000/15432 et le
  dashboard 3002 ne sont joignables que depuis le réseau `nginx_default`.
- frps n'accepte que les ports distants 13000 et 15432 (`allowPorts`) et des connexions TLS.

## Fichiers

| Fichier | Rôle |
|---|---|
| `docker-compose.yml` | services `frps` et `sync` (aucun secret) |
| `frps.toml.example` | modèle de config frps → copier en `frps.toml` (ignoré par git) |
| `.env.example` | modèle des variables → copier en `.env` (ignoré par git) |
| `sync/` | service Node du miroir PostgreSQL + dashboard |
| `sync/test/` | tests des fonctions SQL pures (`npm test`) |

L'ancien `init.sql` (schéma écrit à la main) et `sync/tables.js` (liste de tables) ont été
**supprimés** : ils avaient dérivé de la source (colonnes et tables manquantes). Le schéma de la
destination est désormais recopié automatiquement depuis la source à chaque exécution.
`sync/sync.sh` (pg_dump, jamais utilisé) a aussi été supprimé.

## Variables d'environnement (`.env`)

| Variable | Défaut | Description |
|---|---|---|
| `SRC_HOST` / `SRC_PORT` | `frps` / `15432` | PostgreSQL Debian via le tunnel |
| `SRC_DB` / `SRC_USER` / `SRC_PASS` | — (obligatoire) | identifiants source (idéalement rôle lecture seule) |
| `DST_HOST` / `DST_PORT` | `postgres_db` / `5432` | PostgreSQL Hostinger |
| `DST_DB` / `DST_USER` / `DST_PASS` | — (obligatoire) | identifiants destination |
| `SYNC_CRON` | `30 7 * * *` | planification (cron 5 champs) |
| `SYNC_TZ` | `Europe/Paris` | fuseau du cron |
| `EXCLUDE_TABLES` | vide | tables source à ne pas répliquer (`a,b,c`) |
| `WINDOW_TABLES` | liste du code | surcharge des tables « fenêtre » (`table:colonne_date,…`) |
| `WINDOW_RECENT_DAYS` | `10` | jours toujours rechargés pour les tables « fenêtre » |
| `DEBIAN_WAIT_POLL_MIN` / `DEBIAN_WAIT_MAX_MIN` | `2` / `180` | attente de la fin de la sync Debian |
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | vide | Basic auth ; **vide = dashboard désactivé (503)** |
| `ALERT_WEBHOOK_URL` | vide | webhook Slack/Discord/Mattermost (POST `{text, content}`) |

## Fonctionnement du miroir

Une exécution (cron, bouton du dashboard ou CLI) :

1. **Verrou** `pg_try_advisory_lock` sur la destination : deux exécutions ne peuvent jamais se
   chevaucher, même depuis deux process (service + `docker exec`). La ligne `_run` de `sync_log`
   (destination) passe à `running`.
2. **Attente de la sync Debian** : tant que `sync_log` source a `table_name='_run'` et
   `status='running'`, on attend (contrôle toutes les 2 min, 3 h max). Si la ligne n'existe pas,
   on continue. Après 3 h : alerte, puis copie quand même.
3. **Lecture du catalogue source** (`pg_catalog`) : toutes les tables de base du schéma `public`
   (sauf `EXCLUDE_TABLES`), colonnes dans l'ordre avec leur type exact (`format_type`), NOT NULL,
   clé primaire, index.
4. Pour chaque table (chacune dans son propre try/catch, résultat écrit dans `sync_log`) :
   - **Schéma** : `CREATE TABLE IF NOT EXISTS` (mêmes colonnes et PK), `ADD COLUMN IF NOT EXISTS`
     pour les colonnes manquantes (ajoutées NULLables). Un type différent est seulement signalé.
     Rien n'est jamais supprimé côté destination (tables ou colonnes en trop conservées).
   - **Données** (voir stratégies ci-dessous), en lisant la source par curseur serveur
     (`FETCH 5000`) et en insérant par `INSERT` multi-lignes paramétrés
     (`floor(60000 / nb_colonnes)` lignes par requête). Les valeurs transitent en texte brut :
     aucune perte de précision (timestamps, numeric, bytea…).
   - **Index** après la copie : index source recréés avec le même nom (`IF NOT EXISTS`), clé
     primaire ajoutée si la table destination n'en avait pas. Si un index utilise `pg_trgm`, on
     tente `CREATE EXTENSION IF NOT EXISTS pg_trgm` ; en cas d'échec, ces index sont ignorés
     (avertissement).
5. `sync_log` source → table destination **`source_sync_log`** (la table `sync_log` de la
   destination est celle du miroir et n'est jamais écrasée).
6. Fin : `_run` = `ok` ou `error`, verrou libéré, **alerte webhook** si au moins une table a échoué.

### Stratégies de copie

**`full`** (toutes les tables sauf les tables « fenêtre ») :
`BEGIN; DELETE FROM; INSERT de toutes les lignes; COMMIT` dans une seule transaction. Grâce au
MVCC, les lecteurs continuent de lire l'ancienne version sans être bloqués (pas de verrou ACCESS
EXCLUSIVE comme avec TRUNCATE) et ne voient jamais une table vide ou partielle ; l'autovacuum
récupère l'espace des anciennes lignes. `lock_timeout` de 60 s par sécurité.
**Garde-fou volume** : si la source a moins de 50 % des lignes de la destination (et la
destination plus de 100 lignes), la table n'est pas copiée et passe en erreur (alerte).

**`window`** (tables de mouvements, configurées dans `sync/config.js` : `mvtart`, `mvtreg`,
`mvtart_motif`, `histo_art_gamme`, `demarques`, `meteo`, `fidelite_jour` ; une table absente de la
source est ignorée) :

1. Signature par mois des deux côtés :
   `date_trunc('month', col), count(*), sum(hashtext(ROW(colonnes source)::text)::bigint)`.
2. Garde-fou volume sur le total des lignes.
3. Les **10 derniers jours** sont toujours rechargés (DELETE + INSERT dans une transaction).
4. Chaque mois dont la signature diffère (ou présent d'un seul côté) est rechargé dans sa propre
   transaction (`DELETE` du mois + réinsertion depuis la source).

Résultat : coût incrémental chaque nuit, propagation des corrections et suppressions anciennes,
et **remplissage automatique d'une nouvelle colonne** (tous les mois diffèrent une fois, puis plus).
Les deux connexions utilisent les mêmes paramètres de session (`TimeZone=UTC`, `DateStyle=ISO`,
`extra_float_digits=3`…) pour que les signatures soient comparables. Si un type de colonne diffère
entre source et destination, les mois concernés seront rechargés à chaque exécution : corriger le
type à la main côté destination.

**Mode forcé** (bouton « Forcer » avec confirmation, ou `--force`) : garde-fou volume ignoré et
tables « fenêtre » rechargées entièrement (stratégie `full`).

## Dashboard

- Exposé uniquement sur `nginx_default` : dans Nginx Proxy Manager, créer un proxy host vers
  `ff_sync_hostinger`, port `3002`, **avec certificat SSL et « Force SSL »** (Basic auth en clair
  sinon).
- HTTP Basic auth (`DASHBOARD_USER` / `DASHBOARD_PASSWORD`). Sans ces variables : 503.
- `GET /healthz` sans authentification (healthcheck Docker).
- Bouton « Lancer la sync » = exécution normale ; « Forcer » = mode forcé (confirmation).
- Par table : stratégie, dernière sync, lignes, durée, statut, détail ou erreur.

## Déploiement (VPS Hostinger)

```bash
cd ~/gateway                     # emplacement du dépôt sur le VPS
git pull

# 1. Secrets (une seule fois, puis à chaque rotation)
cp -n .env.example .env          # compléter DST_*, DASHBOARD_*, ALERT_WEBHOOK_URL…
cp -n frps.toml.example frps.toml   # si frps.toml n'existe pas encore
#    → dans frps.toml existant, ajouter allowPorts / additionalScopes / tls.force (voir l'exemple)
chmod 600 .env frps.toml

# 2. Changer le mot de passe PostgreSQL destination (voir ci-dessous) et le reporter dans .env

# 3. Construire et démarrer
docker compose up -d --build
docker compose ps                # ff_sync_hostinger doit passer "healthy"
docker logs -f ff_sync_hostinger

# 4. Première exécution manuelle (facultatif, sinon cron 07:30 Paris)
docker exec ff_sync_hostinger node index.js --once
```

Le premier passage crée les tables/colonnes/index manquants et recharge tous les mois des tables
« fenêtre » : il est plus long que les suivants.

Commandes utiles :

```bash
docker exec ff_sync_hostinger node index.js --once    # exécution normale
docker exec ff_sync_hostinger node index.js --force   # exécution forcée
docker exec -it postgres_db psql -U post -d post -c "SELECT * FROM sync_log ORDER BY last_sync DESC"
```

## Rotation des secrets

### Token frp

```bash
openssl rand -hex 32
```

1. Mettre le nouveau token dans `frps.toml` (Hostinger) **et** dans `frpc.toml` (Debian).
2. `docker compose restart frps` côté Hostinger, puis redémarrer frpc côté Debian.
3. Vérifier : `docker logs ff_frps` (connexion du client, proxys 13000 et 15432 acceptés).

frpc doit être en **0.71.0** (`snowdreamtech/frpc:0.71.0-alpine`) avec
`auth.additionalScopes = ["HeartBeats", "NewWorkConns"]` et `transport.tls.enable = true`
(valeur par défaut), sinon frps refusera la connexion.

### Mot de passe PostgreSQL `post` (destination)

L'ancien mot de passe de `post` a été commité dans l'historique git de ce dépôt : il doit être
considéré comme public et **changé sur le serveur**.

```bash
NEWPASS=$(openssl rand -hex 24)
docker exec -it postgres_db psql -U post -d post -c "ALTER USER post WITH PASSWORD '$NEWPASS';"
# Reporter $NEWPASS dans .env (DST_PASS) ET dans la config de tout autre service qui utilise ce
# compte (API Hostinger, outils…), puis :
docker compose up -d sync
```

Réécrire l'historique git ne suffit pas (copies existantes) : seule la rotation protège.

### Dashboard

Changer `DASHBOARD_PASSWORD` dans `.env` puis `docker compose up -d sync`.

## Tests

```bash
cd sync && npm ci && npm test     # fonctions SQL pures, sans base de données
```
