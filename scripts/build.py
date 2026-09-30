#!/usr/bin/env python3
"""Build a deterministic ZIP and a native Stash package index."""
import hashlib
import json
from datetime import date
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "stash-tv"


def build():
    metadata = json.loads((ROOT / "package.json").read_text())
    version = metadata["version"]
    release_date = date.fromisoformat(metadata["releaseDate"])
    manifest = (PLUGIN / "stash-tv.yml").read_text()
    if f"version: {version}\n" not in manifest:
        raise RuntimeError("package.json and stash-tv.yml versions differ")
    output = ROOT / "dist"
    output.mkdir(exist_ok=True)
    archive = output / "stash-tv.zip"
    files = [PLUGIN / "stash-tv.yml", PLUGIN / "launcher.js", *sorted((PLUGIN / "web").glob("*"))]
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as package:
        for path in files:
            if not path.is_file():
                raise RuntimeError(f"Unexpected package entry: {path.name}")
            entry = zipfile.ZipInfo(path.relative_to(PLUGIN).as_posix(), (2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            package.writestr(entry, path.read_bytes())
        for name in ["LICENSE", "README.md"]:
            entry = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            package.writestr(entry, (ROOT / name).read_bytes())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    index = (f"- id: stash-tv\n  name: Stash TV\n  metadata:\n"
             f"    description: Lightweight fullscreen player for TV remotes, phones, and desktop browsers.\n"
             f"  version: {version}\n  date: {release_date} 00:00:00\n"
             f"  path: stash-tv.zip\n  sha256: {digest}\n")
    (output / "index.yml").write_text(index)
    (output / ".nojekyll").touch()
    landing = (ROOT / "site" / "index.html").read_text()
    landing = landing.replace("{{VERSION}}", version).replace(
        "{{SOURCE_URL}}", "https://quietframe-player.github.io/stash-tv/index.yml")
    (output / "index.html").write_text(landing)
    shutil.copytree(ROOT / "site" / "assets", output / "assets", dirs_exist_ok=True)
    print(json.dumps({"version": version, "archive": str(archive), "sha256": digest}))


if __name__ == "__main__":
    build()
