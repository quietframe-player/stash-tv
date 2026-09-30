#!/usr/bin/env python3
"""Exercise the real Stash TV player against an isolated Stash server and public video."""
import argparse
import hashlib
import functools
import http.server
import threading
from install import install
import json
from pathlib import Path
import shutil
import socket
import sys
import subprocess
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
VIDEO_URL = "https://media.w3.org/2010/05/sintel/trailer.mp4"
VIDEO_SHA256 = "b670602fa00934ca27c4351bb0efe7ea7a07fae57284e44226025eeed7c51254"
IMAGE = "stashapp/stash:v0.31.1@sha256:df744af5a0c976e2ec671052ecc1f8a9aa757fa12b8f9930b59910b7295f0da6"
CLI = ["npx", "--yes", "--package", "@playwright/cli@0.1.21", "playwright-cli"]


def command(arguments, **options):
    return subprocess.run(arguments, cwd=ROOT, check=True, text=True, **options)


def run(args):
    browsers = args.browser or ["chrome", "webkit"]
    if not args.apply:
        print(json.dumps({"mode": "preview", "video": VIDEO_URL, "image": IMAGE,
                          "browsers": browsers, "scope": "isolated local Docker only"}))
        return
    token = uuid.uuid4().hex[:10]
    report = ROOT / ".tmp" / "stash-tv-integration" / token
    report.mkdir(parents=True)
    media = report / "media"
    config = report / "config"
    media.mkdir()
    config.mkdir()
    for directory in ["generated", "generated/tmp", "generated/vtt", "generated/screenshots", "generated/previews", "cache", "metadata", "blobs"]:
        (config / directory).mkdir(parents=True, exist_ok=True)
    cached = ROOT / ".cache" / "stash-tv" / "sintel-trailer.mp4"
    cached.parent.mkdir(parents=True, exist_ok=True)
    if not cached.exists():
        print("Downloading public Sintel trailer", flush=True)
        with urllib.request.urlopen(VIDEO_URL, timeout=60) as response:
            video = response.read()
        if hashlib.sha256(video).hexdigest() != VIDEO_SHA256:
            raise RuntimeError("Downloaded video checksum differs from the reviewed fixture")
        cached.write_bytes(video)
    if hashlib.sha256(cached.read_bytes()).hexdigest() != VIDEO_SHA256:
        raise RuntimeError("Cached video checksum mismatch")
    shutil.copyfile(cached, media / "sintel.mp4")
    (config / "config.yml").write_text("""host: 0.0.0.0
port: 9999
database: /config/stash.sqlite
generated: /config/generated
cache: /config/cache
metadata: /config/metadata
blobs_path: /config/blobs
blobs_storage: FILESYSTEM
calculate_md5: false
video_file_naming_algorithm: OSHASH
parallel_tasks: 1
nobrowser: true
stash:
  - path: /media
plugins_path: /config/plugins
""")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    base_url = f"http://127.0.0.1:{port}"
    container = "stash-tv-test-" + token
    command(["python3", "scripts/build.py"])
    server = http.server.ThreadingHTTPServer(("0.0.0.0", 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "dist")))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    package_url = f"http://host.docker.internal:{server.server_port}/index.yml"
    started = False
    receipts = []

    def api(query, variables=None):
        request = urllib.request.Request(
            base_url + "/graphql",
            data=json.dumps({"query": query, "variables": variables or {}}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.load(response)
        if body.get("errors"):
            raise RuntimeError(json.dumps(body["errors"]))
        return body["data"]

    try:
        docker_host = ["--add-host", "host.docker.internal:host-gateway"] if sys.platform == "linux" else []
        command(["docker", "run", *docker_host, "--detach", "--name", container,
                 "--label", "stash-tv.test=true", "--publish", f"127.0.0.1:{port}:9999",
                 "--mount", f"type=bind,source={config},target=/config",
                 "--mount", f"type=bind,source={media},target=/media",
                 IMAGE, "stash", "--config", "/config/config.yml"], capture_output=True)
        started = True
        for _ in range(60):
            try:
                if api("{systemStatus{status}}")['systemStatus']['status'] == "OK":
                    break
            except (OSError, RuntimeError):
                pass
            time.sleep(1)
        else:
            raise RuntimeError("Isolated Stash did not become ready")
        print(json.dumps(install(base_url, package_url, apply=True)), flush=True)
        print(json.dumps(install(base_url, package_url, apply=True)), flush=True)
        if args.suite == "mobile":
            command(["docker", "exec", container, "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "/media/sintel.mp4", "-t", "50", "-c", "copy", "/media/sintel-short.mp4"])
        api("mutation($input:ScanMetadataInput!){metadataScan(input:$input)}", {
            "input": {"paths": ["/media"], "scanGenerateSprites": True,
                      "scanGenerateCovers": True, "scanGeneratePreviews": False,
                      "scanGeneratePhashes": False},
        })
        for _ in range(90):
            scanned = api("{findScenes{count}jobQueue{id}}")
            if scanned['findScenes']['count'] == (2 if args.suite == 'mobile' else 1) and not scanned['jobQueue']:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Sintel scan and preview generation did not finish")
        source = (ROOT / {"plugin": "tests/plugin-browser.js", "mobile": "tests/mobile-browser.js", "playback": "tests/browser.js"}[args.suite]).read_text()
        source = source.replace("export default ", "", 1)
        for browser in browsers:
            session = f"stash-tv-{token}-{browser}"
            prefix = CLI + ["-s=" + session]
            print(f"Testing {browser} against {base_url}", flush=True)
            try:
                command(prefix + ["open", "about:blank", "--browser", browser], capture_output=True)
                options = {"baseURL": base_url, "browser": browser, "reportDir": str(report), "destructive": browser == browsers[-1]}
                script = "async page => (" + source + ")(page," + json.dumps(options) + ")"
                output = command(prefix + ["run-code", script], capture_output=True).stdout
                (report / (browser + ".log")).write_text(output)
                marker = "### Result\n"
                if marker not in output:
                    raise RuntimeError("Browser runner did not return a result: " + output[:1000])
                receipt = json.loads(output.split(marker, 1)[1].split("\n###", 1)[0])
                receipts.append(receipt)
                print(json.dumps({"browser": browser, "passed": receipt['passed'],
                                  "checks": len(receipt['results']), "error": receipt.get('error')}), flush=True)
            finally:
                subprocess.run(prefix + ["close"], cwd=ROOT, capture_output=True)
        (report / "results.json").write_text(json.dumps({"video": VIDEO_URL, "sha256": VIDEO_SHA256,
                                                        "image": IMAGE, "browsers": receipts}, indent=2))
        if not all(receipt['passed'] for receipt in receipts):
            raise RuntimeError("Integration checks failed; see " + str(report / "results.json"))
        if args.suite == "plugin" and (media / "sintel.mp4").exists():
            raise RuntimeError("Deleted scene left its original video file behind")
        print("PASS: " + str(report / "results.json"), flush=True)
    finally:
        server.shutdown()
        server.server_close()
        if started:
            logs = subprocess.run(["docker", "logs", container], capture_output=True, text=True)
            (report / "stash.log").write_text(logs.stdout + logs.stderr)
            subprocess.run(["docker", "rm", "--force", container], check=True, capture_output=True)
        print("Reports: " + str(report), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Download the fixture and run isolated local integration tests")
    parser.add_argument("--suite", choices=["playback", "plugin", "mobile"], default="playback")
    parser.add_argument("--browser", choices=["chrome", "webkit"], action="append")
    run(parser.parse_args())
