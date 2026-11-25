# Othmane-cliping-omar-

## Football Ticketing: stade 3D (Redvale Park)

Un site de billetterie foot où l'on choisit sa place directement dans un stade en 3D, inspiré de la vidéo de référence.

- **Vue aérienne** du stade : survole une tribune pour voir le prix et le nombre de places libres.
- **Clic sur une tribune** : la caméra vole jusqu'à la section, avec les panneaux LED (Lower tier dès £48, Club boxes dès £240, Upper tier dès £34).
- **Choix des places** : clique sur les sièges rouges, ou « Find the best 2 together » pour trouver les meilleures places côte à côte (elles s'allument en orange).
- **Vue depuis le siège** : la caméra se place à hauteur des yeux, on peut regarder autour.
- **Panier et réservation** : récapitulatif avec frais, puis billets « Admit one » (démo, aucun paiement).

Le match, le stade, les prix et la disponibilité sont des exemples fictifs.

### Lancer le site

Aucune installation. Il suffit de servir le dossier en local (les modules ES ne marchent pas en `file://`) :

```bash
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

Three.js 0.160 est chargé depuis jsDelivr, la police Archivo depuis Google Fonts.

### Fichiers

- `index.html` : structure de la page et des panneaux
- `style.css` : mise en page (bureau et mobile)
- `main.js` : le stade 3D (tribunes, sièges, caméra, panier)

Pour changer le match, les noms ou les prix, voir le haut de `main.js` (`MATCH`, `FEE`, et la fonction `addSection` pour les tarifs).
