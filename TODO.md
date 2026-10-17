# TODO

Feuille de route de l'extension. Cochez au fur et à mesure.

## Fait

- [x] Détection des vidéos directes (`.mp4`, `.webm`, `.mov`, `.m4v`)
- [x] Détection des flux HLS (`.m3u8`) par extension et par `Content-Type`
- [x] Choix de la qualité depuis une playlist maître
- [x] Téléchargement parallèle des segments avec nouvelles tentatives
- [x] Assemblage en `.ts`, `.mp4` (fMP4) ou `.aac`
- [x] Prise en charge de `EXT-X-MAP` et `EXT-X-BYTERANGE`
- [x] Pistes audio séparées proposées à part
- [x] Ajout du `Referer` de la page d'origine
- [x] Flux chiffrés ou DRM signalés et ignorés
- [x] Badge avec le nombre de flux par onglet
- [x] Thème clair et sombre

## Prochaines étapes

### Fonctionnalités

- [ ] Prise en charge du DASH (`.mpd`)
- [ ] Fusion vidéo + audio séparés directement dans l'extension (ffmpeg.wasm)
- [ ] Conversion automatique `.ts` → `.mp4` (ffmpeg.wasm)
- [ ] Enregistrement des directs en continu, avec bouton « Arrêter »
- [ ] Choix de la qualité dans la page de téléchargement si on arrive sur une playlist maître
- [ ] Téléchargement des sous-titres (`.vtt`)
- [ ] Bouton « Copier l'URL » et « Copier la commande yt-dlp / ffmpeg »

### Fiabilité

- [ ] Écriture progressive sur le disque (File System Access API) pour les très gros fichiers
- [ ] Reprise d'un téléchargement interrompu
- [ ] Rafraîchir la playlist quand les URLs de segments expirent
- [ ] Meilleur filtrage des segments fMP4 qui portent l'extension `.mp4`
- [ ] Gestion des sites à navigation sans rechargement (SPA) : vider la liste au changement d'URL

### Interface

- [ ] Miniature et titre de la vidéo dans la popup
- [ ] Historique des téléchargements
- [ ] Page d'options (concurrence, nombre d'essais, dossier, format du nom de fichier)
- [ ] Traduction en anglais (`_locales`)

### Projet

- [ ] Tests automatisés du parseur HLS dans le dépôt (`node --test`)
- [ ] Intégration continue GitHub Actions (lint + tests)
- [ ] Script de packaging (`.zip` prêt pour le Chrome Web Store)
- [ ] Captures d'écran dans le README
- [ ] Licence (MIT ?)
