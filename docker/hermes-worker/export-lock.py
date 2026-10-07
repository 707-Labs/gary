"""Export exact Linux/CPython wheel URLs from the pinned Hermes uv.lock.

No resolver, index queries, optional Hermes extras, sdists or build scripts.
Uses packaging already bundled in the pinned official Python image's pip.
"""
import hashlib
import json
import platform
import sys
import tomllib
from collections import defaultdict
from pip._vendor.packaging.markers import Marker, default_environment
from pip._vendor.packaging.tags import sys_tags
from pip._vendor.packaging.utils import parse_wheel_filename
from urllib.parse import urlparse, unquote

assert sys.version_info[:2] == (3, 11) and sys.platform == "linux"
assert platform.machine() == "aarch64"
raw = sys.stdin.buffer.read()
lock = tomllib.loads(raw.decode())
packages = defaultdict(list)
for package in lock["package"]:
    packages[package["name"]].append(package)
environment = default_environment()
environment["extra"] = ""
def applies(dependency):
    return "marker" not in dependency or Marker(dependency["marker"]).evaluate(environment)
def select(dependency):
    choices = [p for p in packages[dependency["name"]]
               if ("version" not in dependency or p["version"] == dependency["version"])
               and (not p.get("resolution-markers") or any(Marker(m).evaluate(environment) for m in p["resolution-markers"]))]
    assert len(choices) == 1, (dependency, len(choices))
    return choices[0]
root = select({"name": "hermes-agent"})
queue = list(root["dependencies"])
selected = {}
processed = set()
while queue:
    dep = queue.pop()
    if not applies(dep):
        continue
    package = select(dep)
    assert package["source"] == {"registry": "https://pypi.org/simple"}, package["name"]
    key = (package["name"], package["version"])
    assert package["name"] not in selected or selected[package["name"]]["version"] == package["version"]
    selected[package["name"]] = package
    if (key, "base") not in processed:
        processed.add((key, "base"))
        queue.extend(package.get("dependencies", []))
    for extra in dep.get("extra", []):
        if (key, extra) not in processed:
            processed.add((key, extra))
            queue.extend(package.get("optional-dependencies", {})[extra])
tags = {tag: i for i, tag in enumerate(sys_tags())}
requirements = []
artifacts = []
for name, package in sorted(selected.items()):
    candidates = []
    for wheel in package.get("wheels", []):
        url = urlparse(wheel["url"])
        assert url.scheme == "https" and url.hostname == "files.pythonhosted.org" and not url.username and not url.query
        _, version, _, wheel_tags = parse_wheel_filename(unquote(url.path.rsplit("/", 1)[1]))
        assert str(version) == package["version"]
        matched = [tags[t] for t in wheel_tags if t in tags]
        if matched:
            candidates.append((min(matched), wheel["url"], wheel))
    assert candidates, "No locked binary wheel for " + name
    wheel = min(candidates)[2]
    assert len(wheel["hash"]) == 71 and wheel["hash"].startswith("sha256:")
    requirements.append(name + " @ " + wheel["url"] + " --hash=" + wheel["hash"])
    artifacts.append({"name": name, "version": package["version"], **wheel})
print(json.dumps({"scope": "upstream core dependencies, no Hermes optional extras", "python": platform.python_version(),
                  "platform": "linux/arm64", "uvLockSha256": hashlib.sha256(raw).hexdigest(),
                  "requirements": "\n".join(requirements) + "\n", "artifacts": artifacts}, sort_keys=True, indent=2))
