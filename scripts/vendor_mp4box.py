#!/usr/bin/env python3
"""Rebuild the pinned, lazy MP4 parser. Normal plugin builds use the committed artifact."""
import argparse
import base64
import hashlib
from pathlib import Path
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VERSION = "2.4.1"
URL = f"https://registry.npmjs.org/mp4box/-/mp4box-{VERSION}.tgz"
INTEGRITY = "0HGX7nXoDIX6FKLVl4a3wtYjBlwqsN3xuQC3GXzNtKp98FXUOhDSq623azsz8DG5ptd9ZXcXodDkgbdMZOjWvw=="


def run(apply):
    print(f"MP4Box.js {VERSION}, BSD-3-Clause, exports createFile and DataStream; built with Bun 1.4.0")
    if not apply:
        print(f"Preview only: {URL}")
        return
    if subprocess.check_output(["bun", "--version"], text=True).strip() != "1.4.0":
        raise RuntimeError("Use Bun 1.4.0 to reproduce the committed parser")
    with urllib.request.urlopen(URL, timeout=30) as response:
        data = response.read()
    if base64.b64encode(hashlib.sha512(data).digest()).decode() != INTEGRITY:
        raise RuntimeError("Pinned package integrity mismatch")
    with tempfile.TemporaryDirectory(prefix="stash-tv-mp4box-") as directory:
        path = Path(directory)
        archive = path / "package.tgz"
        archive.write_bytes(data)
        with tarfile.open(archive) as package:
            package.extractall(path, filter="data")
        entry = path / "parser.js"
        entry.write_text('export {createFile,DataStream} from "./package/dist/mp4box.all.mjs";\n')
        output = ROOT / "plugins/stash-tv/web/mp4box-parser.js"
        subprocess.run(["bun", "build", str(entry), "--target", "browser", "--minify", "--outfile", str(output)], check=True)
        (output.parent / "MP4BOX-LICENSE.txt").write_bytes((path / "package/LICENSE").read_bytes())
        print("sha256 " + hashlib.sha256(output.read_bytes()).hexdigest())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    run(parser.parse_args().apply)
