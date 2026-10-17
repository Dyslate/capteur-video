# CLAUDE.md — mémoire du projet

Contexte pour les sessions Claude qui reprennent ce dépôt.

## Le projet

Extension Chrome **Manifest V3** qui détecte les vidéos lues dans un onglet et permet de les enregistrer :
vidéos directes (`.mp4`, `.webm`…) et flux **HLS** (`.m3u8`) non chiffrés.
Langue de l'interface, des commentaires et de la doc : **français**.

## Architecture

| Fichier | Rôle |
| --- | --- |
| `manifest.json` | Permissions : `webRequest`, `downloads`, `storage`, `declarativeNetRequestWithHostAccess`, `host_permissions: <all_urls>` |
| `background.js` | Service worker. Observe `webRequest.onHeadersReceived`, classe les réponses (`classify`), range les flux par onglet dans `chrome.storage.session` sous la clé `tab:<id>`, met à jour le badge. Vide la liste à chaque requête `main_frame`. |
| `popup.html` / `popup.js` | Liste les flux de l'onglet actif. Lit chaque playlist HLS pour afficher les qualités, masque les sous-playlists déjà référencées par une playlist maître, signale les flux chiffrés. |
| `downloader.html` / `downloader.js` | Page ouverte dans un onglet pour un flux HLS : ajoute une règle DNR de session (Referer/Origin de la page, limitée à cet onglet), télécharge les segments en parallèle (`pool`, 6 à la fois, 3 essais), assemble un `Blob`, lance `chrome.downloads.download`. |
| `common.js` | `HLS.parse` (maître ou média, `EXT-X-MAP`, `EXT-X-BYTERANGE`, `EXT-X-KEY`), `HLS.fetchText`, `HLS.variantLabel`, et `Util` (noms de fichiers, formats). Exporte aussi en CommonJS pour les tests Node. |
| `style.css` | Styles partagés, variables CSS, thème clair et sombre. |

Paramètres passés à `downloader.html` par l'URL : `url`, `title`, `page` (URL de la page d'origine), `label` (qualité).

## Règles à respecter

- **Ne jamais contourner une protection** : un flux avec `EXT-X-KEY` ou `EXT-X-SESSION-KEY` dont `METHOD` n'est pas `NONE` est refusé. Pas de prise en charge du DRM (Widevine, FairPlay, PlayReady), ni du déchiffrement AES-128.
- Pas de code distant, pas de `eval`, pas de script inline (CSP de Manifest V3).
- Pas de dépendance ni d'étape de build : l'extension se charge telle quelle avec « Charger l'extension non empaquetée ».
- Les permissions restent minimales ; toute nouvelle permission doit être justifiée dans le README.

## Vérifier ses changements

```bash
for f in *.js; do node --check "$f"; done
node -e "const {HLS}=require('./common.js'); console.log(HLS.parse('#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST','https://x/y.m3u8'))"
```

Test manuel : charger le dossier dans `chrome://extensions`, ouvrir une page avec un flux HLS public de test, lancer la lecture, puis ouvrir la popup.

## Où en est-on

La feuille de route est dans [TODO.md](TODO.md). Cocher les cases au fur et à mesure.

## Conventions

- Commits en français, à l'impératif ou descriptifs (« Ajoute la prise en charge du DASH »).
- Code : JavaScript vanilla, `async/await`, pas de framework.
- Textes affichés à l'utilisateur en français.
