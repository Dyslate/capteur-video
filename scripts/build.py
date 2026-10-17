#!/usr/bin/env python3
"""Packages the extension into dist/.

  python scripts/build.py            builds both zips
  python scripts/build.py personal   personal build only (YouTube via the local helper)
  python scripts/build.py store      Chrome Web Store build only

The store build:
  - sets BUILD = "store" in lib/config.js (YouTube excluded, no local helper);
  - removes the "nativeMessaging" permission and the fixed "key" from the manifest;
  - leaves out help.html / help.js / lib/helper.js usage stays inert (BUILD check).
"""

import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")

INCLUDE_DIRS = ["icons", "lib", "vendor", "workers"]
INCLUDE_FILES = ["manifest.json", "background.js", "panel.html", "panel.css", "panel.js", "help.html", "help.js",
                 "log.html", "log.js", "LICENSE"]


def files():
    for name in INCLUDE_FILES:
        yield name
    for d in INCLUDE_DIRS:
        for base, _, names in os.walk(os.path.join(ROOT, d)):
            for n in sorted(names):
                yield os.path.relpath(os.path.join(base, n), ROOT).replace(os.sep, "/")


def build(flavour):
    manifest = json.load(open(os.path.join(ROOT, "manifest.json"), encoding="utf-8"))
    version = manifest["version"]
    if flavour == "store":
        manifest.pop("key", None)
        manifest["permissions"] = [p for p in manifest["permissions"] if p != "nativeMessaging"]
        manifest["description"] = "Détecte les vidéos des pages que vous visitez et les enregistre en MP4 ou en MP3 (Instagram, Facebook, Vimeo et la plupart des sites)."

    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, "capteur-video-%s-%s.zip" % (flavour, version))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in files():
            if flavour == "store" and rel in ("help.html", "help.js"):
                continue
            src = os.path.join(ROOT, rel)
            if rel == "manifest.json":
                z.writestr(rel, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
            elif rel == "lib/config.js":
                text = open(src, encoding="utf-8").read()
                text = re.sub(r'export const BUILD = "\w+";', 'export const BUILD = "%s";' % flavour, text)
                z.writestr(rel, text)
            else:
                z.write(src, rel)
    # Every page and script referenced by the manifest or the pages must be in the zip.
    with zipfile.ZipFile(out) as z:
        names = set(z.namelist())
    for page in ("panel.html", "log.html") + (() if flavour == "store" else ("help.html",)):
        html = open(os.path.join(ROOT, page), encoding="utf-8").read()
        for ref in re.findall(r'(?:src|href)="([^":#?]+\.(?:js|css|html))"', html):
            if ref not in names and not (flavour == "store" and ref == "help.html"):
                sys.exit("missing from %s build: %s (referenced by %s)" % (flavour, ref, page))
    print("built", os.path.relpath(out, ROOT), "(%d KB)" % (os.path.getsize(out) // 1024))
    return out


if __name__ == "__main__":
    wanted = sys.argv[1:] or ["personal", "store"]
    for flavour in wanted:
        if flavour not in ("personal", "store"):
            sys.exit("unknown build: " + flavour)
        build(flavour)
