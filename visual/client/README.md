# Foggy Visual

Petit visualiseur web pour les bases SQLite Foggy au format v4.

## Lancer

Lancer l'API depuis la racine du repo :

```bash
visual/serveur/start.sh
```

L'API écoute par défaut ici :

```text
http://127.0.0.1:4173/
```

Le port peut être changé avec `FOGGY_VISUAL_PORT=4180 visual/serveur/start.sh`.

Le client n'est pas hébergé par ce serveur. Ouvre `visual/client/index.html` avec ton serveur web habituel. Par défaut, le client appelle l'API sur `http://127.0.0.1:4173`.

Si l'API tourne ailleurs, définir l'URL avant `app.js` :

```html
<script>
  window.FOGGY_VISUAL_API_URL = "http://127.0.0.1:4180";
</script>
```

Le bouton **Charger local** essaie de lire `../location_history.db`. Le champ **DB** permet aussi de choisir une autre base `.db`. Dans les deux cas, le client envoie d'abord la DB brute au serveur local pour qu'il la récupère, puis le navigateur parse SQLite avec `sql.js` et affiche les cellules. Le serveur ne lit plus le schéma SQLite de la DB.

Après le parsing local, le client envoie les cellules déjà calculées au serveur pour lancer le leaderboard. Le serveur garde un cache de frontières dans `visual/serveur/city_boundary_cache.json`. La réponse initiale reste volontairement rapide. Ensuite, le serveur garde un job en arrière-plan, récupère une nouvelle frontière Nominatim toutes les 1,2 seconde par défaut, met le cache à jour, puis pousse le leaderboard recalculé au client via `GET /api/leaderboard-stream`.

Le cache contient :

- `items` : villes validées, stockées sous forme de `gridRows` compressées par ligne, avec `totalGridCells` déjà calculé.
- `misses` : cellules déjà testées qui n'ont pas donné de frontière exploitable, pour ne pas retenter les mêmes points à chaque lancement.

Une entrée `gridRows` contient des intervalles de colonnes par ligne de grille :

```json
{
  "432156": [[171234, 171250], [171260, 171280]],
  "432157": [[171233, 171251]]
}
```

L'intervalle est réglable avec `FOGGY_VISUAL_LEADERBOARD_REFRESH_SECONDS` :

```bash
FOGGY_VISUAL_LEADERBOARD_REFRESH_SECONDS=10 visual/serveur/start.sh
```

## Format attendu

La base doit contenir une table `gps_points` avec les colonnes v4 :

- `grid_column`
- `grid_row`
- `recorded_at`
- `edit_state`

Les cellules utilisent la même grille Web Mercator de 15 m que l'app Android.
