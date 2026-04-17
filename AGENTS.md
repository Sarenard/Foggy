# Consignes générales pour agents de coding

## Structure de la database

Le schéma de la DB est présent ici :
- dans LocationHistoryDatabase.kt 
- dans set_db.sh sur le test de cohérence
- dans app.js, dans "pret a charger une app v4"
- dans app.js, dans le parsing de la db
Pense à le modif partout si tu le changfes
De plus, si jamais un autre fichier se met a contenir un lien avec le schéma de DB, demande moi de modifier AGENTS.md pour le rajouter à la liste (ne le fait pas tout seul !)

## Visualizer

Le dossier `visual/` contient un visualiseur web de la DB Foggy.

- Les outils du visualizer doivent rester uniquement visuels tant que ce n'est pas explicitement une action d'édition ou de sauvegarde.
- La timeline ne doit pas modifier la DB : elle filtre seulement l'affichage des cellules.
- Quand la timeline est tout à droite, elle doit représenter explicitement la dernière cellule enregistrée et afficher toute la DB visible, sans état intermédiaire ambigu.
- Le bouton `Clean` doit d'abord afficher un aperçu des cellules concernées avant d'appliquer les changements.
- Le bouton `Sauver DB` doit afficher un récapitulatif des changements avant d'exporter la DB.
