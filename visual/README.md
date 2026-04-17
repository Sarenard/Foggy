# Foggy Visual

Petit visualiseur web pour les bases SQLite Foggy au format v4.

## Lancer

Depuis la racine du repo :

```bash
python3 -m http.server 4173
```

Puis ouvrir :

```text
http://localhost:4173/visual/
```

Le bouton **Charger local** essaie de lire `../location_history.db`. Le champ **DB** permet aussi de choisir une autre base `.db`.

## Format attendu

La base doit contenir une table `gps_points` avec les colonnes v4 :

- `grid_column`
- `grid_row`
- `recorded_at`
- `edit_state`

Les cellules utilisent la même grille Web Mercator de 15 m que l'app Android.
