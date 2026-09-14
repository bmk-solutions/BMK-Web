"""Read-only verification of the pinned Argus source staged inside this project.

No model download, inference, package installation or tour mutation is performed.
Run Python with -B to avoid bytecode files outside the project.
"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REVIEW = ROOT / "work" / "argus-review"
COMMIT = "4f1b9ddae6d24970aa8fb346838be87390684ccf"


def contained(path):
    resolved = path.resolve()
    if not resolved.is_relative_to(ROOT):
        raise ValueError("Argus input escapes BMK-Web")
    return resolved


def inspect_source():
    tree = json.loads(contained(REVIEW / "tree.json").read_text(encoding="utf-8-sig"))
    commit = json.loads(contained(REVIEW / "commit.json").read_text(encoding="utf-8-sig"))
    if commit["sha"] != COMMIT or tree["sha"] != commit["commit"]["tree"]["sha"] or tree.get("truncated"):
        raise ValueError("Source metadata does not match the reviewed commit")
    checked = 0
    for entry in tree["tree"]:
        if entry["type"] != "blob" or entry["path"].startswith(("examples/", "assets/")):
            continue
        path = contained(REVIEW / "source" / entry["path"])
        data = path.read_bytes()
        digest = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if digest != entry["sha"]:
            raise ValueError(f"Source verification failed: {entry['path']}")
        checked += 1
    return {
        "source": "https://github.com/realsee-developer/Argus",
        "commit": COMMIT,
        "verified_files": checked,
        "source_license": "Apache-2.0",
        "weights_license": "CC-BY-NC-4.0; provider approval required",
        "weights_page": "https://huggingface.co/RealseeTechnology/argus-realsee3d",
        "inference_tested": False,
        "production_enabled": False,
    }


if __name__ == "__main__":
    print(json.dumps(inspect_source(), indent=2))
