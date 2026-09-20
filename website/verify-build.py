#!/usr/bin/env python3
"""Check the combined Pages artifact without credentials or network access."""
import argparse
import json
from pathlib import Path, PurePosixPath


def verify(root):
    demo = root / "demo"
    if not (root / "index.html").is_file() or not (root / "sw.js").is_file():
        raise ValueError("Regular application/PWA build is missing")
    if not (demo / "index.html").is_file():
        raise ValueError("Demo build is missing")
    if any(path.is_file() and (path.name in {"sw.js", "manifest.webmanifest"} or path.name.startswith("workbox-")) for path in demo.rglob("*")):
        raise ValueError("Demo must not contain PWA artifacts")
    html = (demo / "index.html").read_text()
    if 'rel="manifest"' in html:
        raise ValueError("Demo HTML must not declare a PWA manifest")
    catalog = demo / "catalog"
    for required in ["search3.json", "assets.json", "credits.html", "credits.json", "dates.json", "sources.json"]:
        if not (catalog / required).is_file():
            raise ValueError("Demo catalog metadata is incomplete")
    assets = json.loads((catalog / "assets.json").read_text())
    for asset in assets.values():
        path = PurePosixPath(asset["path"])
        if path.is_absolute() or ".." in path.parts or path.parts[0] not in {"audio", "covers"}:
            raise ValueError("Unsafe demo asset path")
        file = catalog / path
        if not file.is_file() or file.is_symlink():
            raise ValueError("Missing demo audio or artwork")
    search = json.loads((catalog / "search3.json").read_text())["subsonic-response"]["searchResult3"]
    if not search["song"] or any(song["id"] not in assets for song in search["song"]):
        raise ValueError("Missing demo tracks")
    size = sum(path.stat().st_size for path in root.rglob("*") if path.is_file())
    if size > 1024**3:
        raise ValueError("Combined Pages site exceeds 1 GiB")
    return len(search["song"]), size


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("dist"))
    args = parser.parse_args()
    tracks, size = verify(args.root)
    print(f"Pages artifact verified: {tracks} demo tracks; {size / 1024**2:.1f} MiB total")
