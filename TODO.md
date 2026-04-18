# Todo : le rendu initial doit se faire en local

# TODO : optimise
things proposed by codex : (ask before implementing each one)

ne pas recalculer la ville/frontière à chaque refresh
mettre en cache la frontière déjà chargée
ne recalculer le pourcentage que lorsqu’un nouveau point est ajouté
séparer DB et réseau sur des executors différents
couper enableMyLocation() quand l’écran n’est pas au premier plan si ce n’est pas indispensable
Fix ceci :
La petite différence : l’app Android, pour les MultiPolygon, garde actuellement le plus grand polygone seulement via parseMultiPolygonCoordinates. Le visualiseur, lui, compte tous les polygones d’un MultiPolygon. Pour une commune française classique ça ne changera souvent rien, mais pour des communes avec îles/morceaux séparés, le visualiseur peut être plus complet que l’app.