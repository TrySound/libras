#!/usr/bin/env python3
"""Fetch the latest private export during CI. No source URL/credentials enter the site."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

MAX_BYTES = 2 * 1024**3
METADATA = {"search3.json", "assets.json", "credits.json", "credits.html", "dates.json", "sources.json", "summary.json"}
FOLDERS = {"audio", "covers", "albums", "artists", "evidence"}


class ExportError(Exception):
    """Safe to log: messages must never contain source URLs or credentials."""


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ExportError("Export source redirected; refusing to forward credentials.")


def source_url(value):
    try:
        parsed = urlsplit(value)
        valid = parsed.scheme == "https" and parsed.hostname and not (parsed.username or parsed.password or parsed.query or parsed.fragment)
        if not valid:
            raise ValueError()
        return value.rstrip("/") + "/"
    except ValueError:
        raise ExportError("DEMO_EXPORT_URL must be an HTTPS export-directory URL without credentials, query or fragment.") from None


def file_inventory(manifest):
    files = manifest["files"]
    if not isinstance(files, list) or len(files) > 10000:
        raise ExportError("Invalid export inventory.")
    indexed = {}
    total = 0
    for entry in files:
        name, size, checksum = entry["path"], entry["size"], entry["sha256"]
        path = PurePosixPath(name)
        if (not name or path.is_absolute() or ".." in path.parts or "\\" in name
                or path.as_posix() != name or name in indexed
                or (path.parts[0] not in FOLDERS and name not in METADATA)
                or not isinstance(size, int) or size < 0
                or not re.fullmatch(r"[a-f0-9]{64}", checksum)):
            raise ExportError("Unsafe or invalid export inventory.")
        total += size
        indexed[name] = entry
    if total > MAX_BYTES or not METADATA.issubset(indexed):
        raise ExportError("Incomplete or oversized export inventory.")
    return indexed


def extract(archive, output, files, forbidden):
    seen = set()
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            entry = files.get(member.name)
            if not member.isfile() or not entry or member.name in seen or member.size != entry["size"]:
                raise ExportError("Unexpected archive entry.")
            target = output / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            overlap = b""
            longest = max(map(len, forbidden), default=1)
            with tar.extractfile(member) as source, target.open("xb") as destination:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    check = overlap + block
                    if any(secret in check for secret in forbidden):
                        raise ExportError("Export contains a private source identifier or credential; refusing publication.")
                    overlap = check[-longest:]
                    digest.update(block)
                    destination.write(block)
            if digest.hexdigest() != entry["sha256"]:
                raise ExportError("Extracted file checksum mismatch.")
            seen.add(member.name)
    if seen != files.keys():
        raise ExportError("Archive is incomplete.")


def download(output, export_url, password, username="demo", opener=None):
    if output.exists():
        raise ExportError("Catalog destination already exists; refusing to mix releases.")
    if not export_url or not password or not username:
        raise ExportError("Set DEMO_EXPORT_URL and DEMO_MEDIA_PASSWORD in Actions secrets.")
    base = source_url(export_url)
    authorization = "Basic " + base64.b64encode((username + ":" + password).encode()).decode()
    opener = opener or build_opener(NoRedirects())

    def get(path):
        try:
            return opener.open(Request(base + path, headers={"Authorization": authorization}), timeout=120)
        except HTTPError as error:
            raise ExportError(f"Export download failed (HTTP {error.code}); check the source secrets.") from None
        except (URLError, OSError):
            raise ExportError("Could not reach the export source.") from None

    def metadata(path):
        with get(path) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ExportError("Export metadata exceeds size limit.")
            return json.loads(raw)

    # Resolve latest once, then use only the immutable release for this build.
    release = metadata("latest.json")["release"]
    if not isinstance(release, str) or not re.fullmatch(r"[a-f0-9]{64}", release):
        raise ExportError("Invalid export release.")
    manifest = metadata(release + "/manifest.json")
    fingerprint = hashlib.sha256(json.dumps(manifest["files"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if manifest["schemaVersion"] != 1 or manifest["release"] != release or fingerprint != release:
        raise ExportError("Invalid export manifest fingerprint.")
    files = file_inventory(manifest)
    item = manifest["archives"]["full"]
    if (item["path"] != "catalog.tar.gz" or not isinstance(item["size"], int)
            or not 0 < item["size"] <= MAX_BYTES
            or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"])):
        raise ExportError("Invalid archive metadata.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".demo-download-", dir=output.parent) as tmp:
        root = Path(tmp)
        archive = root / "catalog.tar.gz"
        digest, size = hashlib.sha256(), 0
        with get(release + "/catalog.tar.gz") as response, archive.open("wb") as destination:
            for block in iter(lambda: response.read(1024 * 1024), b""):
                size += len(block)
                if size > item["size"]:
                    raise ExportError("Archive exceeds declared size.")
                digest.update(block)
                destination.write(block)
        if size != item["size"] or digest.hexdigest() != item["sha256"]:
            raise ExportError("Archive checksum mismatch.")
        stage = root / "catalog"
        stage.mkdir()
        # Check the raw export before copying it to Pages. Check across chunk boundaries too.
        forbidden = [base.encode(), urlsplit(base).hostname.encode(), password.encode(), authorization.encode()]
        extract(archive, stage, files, forbidden)
        search = json.loads((stage / "search3.json").read_text())["subsonic-response"]
        if search["status"] != "ok" or not search["searchResult3"]["song"]:
            raise ExportError("Export has no usable music catalog.")
        assets = json.loads((stage / "assets.json").read_text())
        for asset in assets.values():
            entry = files.get(asset["path"])
            if not entry or (asset.get("sha256") and entry["sha256"] != asset["sha256"]):
                raise ExportError("Export references a missing or corrupt asset.")
        stage.rename(output)
    return release


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        release = download(args.output, os.environ.get("DEMO_EXPORT_URL", ""),
                           os.environ.get("DEMO_MEDIA_PASSWORD", ""), os.environ.get("DEMO_MEDIA_USERNAME", "demo"))
    except ExportError as error:
        parser.exit(1, f"Demo export failed: {error}\n")
    except Exception:
        # Library exceptions can embed request URLs; never print their repr/traceback in CI.
        parser.exit(1, "Demo export failed: invalid or unavailable catalog.\n")
    print("Verified demo export:", release)


if __name__ == "__main__":
    main()
