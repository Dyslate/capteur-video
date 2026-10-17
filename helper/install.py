#!/usr/bin/env python3
"""Installs (or removes) the Capteur vidéo local helper.

What it does:
  1. creates a private Python environment in the app folder;
  2. installs yt-dlp (with its YouTube extras) and a bundled ffmpeg;
  3. copies capteur_helper.py and writes a small launcher;
  4. registers the native messaging host for Chrome, Edge, Brave and Chromium.

Usage:
  python install.py                    install or update
  python install.py --uninstall        remove everything
  python install.py --extension-id ID  allow another extension ID (e.g. a store build)
"""

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import venv

HOST_NAME = "com.dyslate.capteur_video"
# ID derived from the "key" in manifest.json: identical on every machine.
DEFAULT_EXTENSION_ID = "gkbhlagbekepghjaegeolhjkmbnkcjpn"
HERE = os.path.dirname(os.path.abspath(__file__))
SYSTEM = platform.system()

BROWSERS_REGISTRY = [
    r"Software\Google\Chrome\NativeMessagingHosts",
    r"Software\Microsoft\Edge\NativeMessagingHosts",
    r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
    r"Software\Chromium\NativeMessagingHosts",
]
BROWSERS_MAC = ["Google/Chrome", "Microsoft Edge", "BraveSoftware/Brave-Browser", "Chromium"]
BROWSERS_LINUX = ["google-chrome", "microsoft-edge", "BraveSoftware/Brave-Browser", "chromium"]


def app_dir():
    if SYSTEM == "Windows":
        return os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "CapteurVideo")
    return os.path.join(os.path.expanduser("~"), ".capteur-video")


def venv_python(base):
    if SYSTEM == "Windows":
        return os.path.join(base, "venv", "Scripts", "python.exe")
    return os.path.join(base, "venv", "bin", "python")


def host_manifest_dirs():
    home = os.path.expanduser("~")
    if SYSTEM == "Darwin":
        return [os.path.join(home, "Library", "Application Support", b, "NativeMessagingHosts") for b in BROWSERS_MAC]
    return [os.path.join(home, ".config", b, "NativeMessagingHosts") for b in BROWSERS_LINUX]


def step(text):
    print("\n==> " + text, flush=True)


def install(extension_ids):
    base = app_dir()
    os.makedirs(base, exist_ok=True)

    step("Création de l'environnement Python")
    if not os.path.exists(venv_python(base)):
        venv.create(os.path.join(base, "venv"), with_pip=True)
    py = venv_python(base)

    step("Installation de yt-dlp et de ffmpeg (quelques minutes la première fois)")
    subprocess.check_call([py, "-m", "pip", "install", "--upgrade", "pip"], stdout=subprocess.DEVNULL)
    subprocess.check_call([py, "-m", "pip", "install", "--upgrade", "yt-dlp[default]", "imageio-ffmpeg"])

    step("Copie du module")
    shutil.copy2(os.path.join(HERE, "capteur_helper.py"), os.path.join(base, "capteur_helper.py"))
    if SYSTEM == "Windows":
        launcher = os.path.join(base, "capteur_helper.bat")
        with open(launcher, "w", encoding="utf-8", newline="\r\n") as f:
            f.write('@echo off\n"%s" -u "%s" %%*\n' % (py, os.path.join(base, "capteur_helper.py")))
    else:
        launcher = os.path.join(base, "capteur_helper.sh")
        with open(launcher, "w", encoding="utf-8") as f:
            f.write('#!/bin/sh\nexec "%s" -u "%s" "$@"\n' % (py, os.path.join(base, "capteur_helper.py")))
        os.chmod(launcher, 0o755)

    manifest = {
        "name": HOST_NAME,
        "description": "Capteur vidéo - module local (yt-dlp)",
        "path": launcher,
        "type": "stdio",
        "allowed_origins": ["chrome-extension://%s/" % i for i in extension_ids],
    }
    manifest_path = os.path.join(base, HOST_NAME + ".json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    step("Enregistrement auprès des navigateurs")
    if SYSTEM == "Windows":
        import winreg

        for key in BROWSERS_REGISTRY:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key + "\\" + HOST_NAME) as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, manifest_path)
    else:
        for d in host_manifest_dirs():
            os.makedirs(d, exist_ok=True)
            shutil.copy2(manifest_path, os.path.join(d, HOST_NAME + ".json"))

    step("Vérifications")
    has_ffmpeg = bool(shutil.which("ffmpeg")) or subprocess.call(
        [py, "-c", "import imageio_ffmpeg; imageio_ffmpeg.get_ffmpeg_exe()"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0
    print("  ffmpeg      :", "OK" if has_ffmpeg else "INTROUVABLE")
    runtime = next((n for n in ("deno", "node", "bun") if shutil.which(n)), None)
    print("  JavaScript  :", runtime or "aucun (nécessaire pour YouTube)")
    if not runtime:
        hint = {
            "Windows": "winget install DenoLand.Deno",
            "Darwin": "brew install deno",
        }.get(SYSTEM, "curl -fsSL https://deno.land/install.sh | sh")
        print("  -> Pour YouTube, installez Deno :  " + hint)

    print("\nModule installé dans : " + base)
    print("Redémarrez Chrome, puis rouvrez le panneau de l'extension.")


def uninstall():
    base = app_dir()
    step("Suppression de l'enregistrement")
    if SYSTEM == "Windows":
        import winreg

        for key in BROWSERS_REGISTRY:
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key + "\\" + HOST_NAME)
            except OSError:
                pass
    else:
        for d in host_manifest_dirs():
            path = os.path.join(d, HOST_NAME + ".json")
            if os.path.exists(path):
                os.remove(path)
    step("Suppression des fichiers")
    shutil.rmtree(base, ignore_errors=True)
    print("Module désinstallé.")


def main():
    if sys.version_info < (3, 9):
        sys.exit("Python 3.9 ou plus récent est nécessaire.")
    parser = argparse.ArgumentParser(description="Installe le module local de Capteur vidéo")
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--extension-id", action="append", default=[])
    args = parser.parse_args()
    if args.uninstall:
        uninstall()
    else:
        install([DEFAULT_EXTENSION_ID, *args.extension_id])


if __name__ == "__main__":
    main()
