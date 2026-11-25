# Othmane-cliping-omar-

Deux sites de réservation en 3D :

- `index.html` (racine) : billetterie foot dans un stade, choix de la tribune puis du siège.
- `avion/` : réservation de vol, choix de la classe, de la place puis du siège.

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

## Avion : réservation de vol en 3D (dossier `avion/`)

Même principe que le stade, mais dans un avion long-courrier au-dessus des nuages, au coucher du soleil.

- **Vue extérieure** de l'avion, puis le toit s'ouvre (vue en coupe) pour montrer les 4 cabines.
- **Choix de la classe** : Économie (3-3-3, dès 420 €), Premium Économie (2-3-2, dès 890 €), Affaires (1-2-1, lit plat, dès 2 650 €), Première (6 suites, dès 6 900 €).
- **Choix de la place** : Hublot, Couloir, Milieu ou Espace+ (rangs avec plus d'espace pour les jambes). Les autres sièges s'estompent.
- **Choix du siège** : clic sur un siège, ou « Trouver le meilleur siège » pour 1 à 4 voyageurs côte à côte.
- **Carte d'embarquement en direct** : elle change quand on survole ou choisit un siège (classe, siège, embarquement, prix).
- **Vue depuis le siège**, puis réservation avec une carte d'embarquement par voyageur (démo, aucun paiement).

Le vol (MV 210 Casablanca → New York), la compagnie Mirava, les prix et les places libres sont fictifs.

Pour le lancer : `python3 -m http.server 8000`, puis ouvrir http://localhost:8000/avion/
