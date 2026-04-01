# TODO : optimise
things proposed by codex : (ask before implementing each one)

passer le GPS de 10 s à 30-60 s
ne pas recalculer la ville/frontière à chaque refresh
mettre en cache la frontière déjà chargée
ne recalculer le pourcentage que lorsqu’un nouveau point est ajouté
séparer DB et réseau sur des executors différents
couper enableMyLocation() quand l’écran n’est pas au premier plan si ce n’est pas indispensable
