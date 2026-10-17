# Capteur de flux vidéo

Extension Chrome (Manifest V3) qui repère les vidéos lues dans un onglet et permet de les enregistrer.

## Ce qu'elle sait faire

- **Vidéos directes** (`.mp4`, `.webm`, `.mov`) : téléchargement en un clic.
- **Flux HLS** (`.m3u8`) non chiffrés : choix de la qualité, téléchargement de tous les segments en parallèle, puis assemblage en un seul fichier (`.mp4` pour les flux fMP4, `.ts` sinon).
- **Pistes audio séparées** : proposées à part quand le flux les sépare de la vidéo.
- Ajout automatique du `Referer` de la page d'origine, que certains serveurs exigent.

## Ce qu'elle ne fait pas

- Les contenus protégés par DRM ou chiffrés (Netflix, Disney+, Prime Video, Canal+…) sont signalés comme protégés et ignorés.
- YouTube utilise son propre format de diffusion : utilisez plutôt [yt-dlp](https://github.com/yt-dlp/yt-dlp), dans le respect des conditions du site.
- Le DASH (`.mpd`) n'est pas encore pris en charge.
- Pour un direct, seuls les segments disponibles au moment du clic sont enregistrés.

## Installation

1. Ouvrez `chrome://extensions`.
2. Activez le **Mode développeur** (en haut à droite).
3. Cliquez sur **Charger l'extension non empaquetée** et choisissez ce dossier.
4. Épinglez l'icône de l'extension dans la barre d'outils.

## Utilisation

1. Ouvrez la page et **lancez la lecture** de la vidéo.
2. Le badge de l'icône indique le nombre de flux détectés.
3. Cliquez sur l'icône, puis sur la qualité voulue.
4. Pour un flux HLS, un onglet de progression s'ouvre. Laissez-le ouvert jusqu'à la fin.

Les fichiers `.ts` se lisent avec VLC. Pour les convertir en `.mp4` sans perte :

```
ffmpeg -i fichier.ts -c copy fichier.mp4
```

Pour fusionner une vidéo et une piste audio téléchargées séparément :

```
ffmpeg -i video.mp4 -i audio.aac -c copy resultat.mp4
```

## Structure

| Fichier | Rôle |
| --- | --- |
| `background.js` | Observe le réseau et range les flux détectés par onglet |
| `popup.html`, `popup.js` | Liste des flux de l'onglet actif |
| `downloader.html`, `downloader.js` | Téléchargement et assemblage des segments HLS |
| `common.js` | Lecture des playlists HLS et utilitaires |
| `style.css` | Styles (thème clair et sombre) |

## Limites connues

- Le fichier est assemblé en mémoire : pour des vidéos de plusieurs Go, Chrome peut manquer de mémoire.
- Certains sites lient les URLs de segments à une session courte : si le téléchargement échoue, relancez la lecture puis réessayez.

## Feuille de route

Les prochaines évolutions prévues sont listées dans [TODO.md](TODO.md).

## Usage responsable

Réservez l'extension aux contenus libres de droits, aux vôtres, ou à ceux que vous avez le droit de copier pour un usage privé.
