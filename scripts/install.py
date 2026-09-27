#!/usr/bin/env python3
"""Register and install Stash TV through Stash's package manager."""
import argparse
import json
import os
import time
import urllib.request

SOURCE = "https://quietframe-player.github.io/stash-tv/index.yml"


def install(url, source=SOURCE, apply=False, enable_delete=False, timeout=600):
    def api(query, variables=None):
        headers = {"Content-Type": "application/json"}
        if os.environ.get("STASH_API_KEY"):
            headers["ApiKey"] = os.environ["STASH_API_KEY"]
        request = urllib.request.Request(url.rstrip("/") + "/graphql",
            data=json.dumps({"query": query, "variables": variables or {}}).encode(), headers=headers)
        with urllib.request.urlopen(request, timeout=60) as response:
            result = json.load(response)
        if result.get("errors"):
            raise RuntimeError(str(result["errors"]))
        return result["data"]

    config = api("{configuration{general{pluginPackageSources{name url local_path}}}}")
    sources = config["configuration"]["general"]["pluginPackageSources"]
    if not apply:
        return {"mode": "preview", "url": url, "source": source, "enableDelete": enable_delete}
    if not any(entry["url"] == source for entry in sources):
        if any(entry["local_path"] == "stash-tv" for entry in sources):
            raise RuntimeError("Another plugin source already uses local path stash-tv")
        sources.append({"name": "Stash TV", "url": source, "local_path": "stash-tv"})
        api("mutation($input:ConfigGeneralInput!){configureGeneral(input:$input){pluginPackageSources{url}}}",
            {"input": {"pluginPackageSources": sources}})
    result = api("mutation($packages:[PackageSpecInput!]!){installPackages(type:Plugin,packages:$packages)}",
                 {"packages": [{"id": "stash-tv", "sourceURL": source}]})
    job = result["installPackages"]
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        queue = api("{jobQueue{id status}}")['jobQueue'] or []
        if not any(entry['id'] == job for entry in queue):
            break
        time.sleep(1)
    else:
        raise RuntimeError(f"Plugin installation job {job} did not finish within {timeout}s")
    api("mutation{reloadPlugins}")
    result = api("{plugins{id name enabled version} installedPackages(type:Plugin){package_id sourceURL version}}")
    plugin = next((entry for entry in result['plugins'] if entry['id'] == 'stash-tv'), None)
    package = next((entry for entry in result['installedPackages']
                    if entry['package_id'] == 'stash-tv' and entry['sourceURL'] == source), None)
    if not plugin or not package:
        raise RuntimeError(f"Plugin installation job {job} did not install Stash TV")
    if not plugin['enabled']:
        api('mutation($enabled:BoolMap!){setPluginsEnabled(enabledMap:$enabled)}',
            {'enabled': {'stash-tv': True}})
    if enable_delete:
        api('mutation($input:Map!){configurePlugin(plugin_id:"stash-tv",input:$input)}',
            {"input": {"enableDelete": True}})
    readback = api('{plugins{id enabled} configuration{plugins(include:["stash-tv"])}}')
    if not any(entry['id'] == 'stash-tv' and entry['enabled'] for entry in readback['plugins']):
        raise RuntimeError("Plugin is not enabled after installation")
    if enable_delete and not readback['configuration']['plugins'].get('stash-tv', {}).get('enableDelete'):
        raise RuntimeError("Permanent deletion setting did not persist")
    plugin['enabled'] = True
    return {"installed": True, "plugin": plugin, "package": package, "job": job}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--source", default=SOURCE)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--enable-delete", action="store_true")
    args = parser.parse_args()
    print(json.dumps(install(args.url, args.source, args.apply, args.enable_delete), indent=2))
