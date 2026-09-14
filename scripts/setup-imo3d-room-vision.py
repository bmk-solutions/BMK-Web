"""Explicit one-time download of pinned public model assets; no photo access.

Inference never invokes this setup script and never downloads anything.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib
import json
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "HuggingFaceTB/SmolVLM-500M-Instruct"
REVISION = "a7da5b986cb59b408707209984f360a5f4ad7e47"
TARGET = ROOT / "work" / "room-vision-models" / "SmolVLM-500M-Instruct"
# Hashes are pinned independently of the remote model metadata.
FILES = {
    "README.md": "8465c1a46b0db5d5d0d0945df04032d1b405bb2fa12cdab3da1652bd75fca4b9",
    "added_tokens.json": "74135b8664b56088c0006f1c8e848d79a8eba003411f72ebf1dc2ee96227be3a",
    "chat_template.json": "a68ad1a42681ae44eacd109ff8dd56a840f761c03d72f4ff4c515d092f882168",
    "config.json": "daacbbca6af3c34e50466c72aed2df4553a08084f6a0551d4ae420a241cb66c6",
    "generation_config.json": "067a2a54e5f87162ecac6e0e911cc4665fc8f7f3324794ecbac0f76badb56636",
    "merges.txt": "0b54e8aa4e53d5383e2e4bc635a56b43f9647f7b13832d5d9ecd8f82dac4f510",
    "model.safetensors": "d05b567eeaf534e83d375551f068ed57b5f52d37c657197f644af5ef9db091a2",
    "preprocessor_config.json": "6cb6e36d6fcb88ca1502c4a26750715dc3e7dedddc9a8f17b27d8d167d1457e7",
    "processor_config.json": "e7bff42da73ae9eec9042ef20e066e11f1ee20f025358ff79131e3c0fb549b46",
    "special_tokens_map.json": "aa0ff906077086dfa9734a7f97f68c825877a48f9468807be65504495cdeef09",
    "tokenizer.json": "5ece781dc8d2b2f3e2f289ca0ae50b17cfc27dd27bfe7971bb8241e0b964331a",
    "tokenizer_config.json": "36c6fd44d07d10fd8180ee6b46dcccf69fb7c06753968ff0d7e17b8bfe17b777",
    "vocab.json": "82b84012e3add4d01d12ba14442026e49b8cbbaead1f79ecf3d919784f82dc79",
}
DETECTOR_REPOSITORY = "PekingU/rtdetr_v2_r18vd"
DETECTOR_REVISION = "5650961749fa93567c0d46fc7f43ea4f9e914107"
DETECTOR_FILES = {
    "README.md": "4a26a3a6de73500f181e4edbc75b3f3f19ca6dde0fdaceeeb78167f223973305",
    "config.json": "ed051ec77cb41c5d9d5e3af21a979b1e890599dfd68434d7636ff82ded4c1527",
    "model.safetensors": "d18309d0d7ea57048138885c4c6ecfcb1e24506fc6153b94ad484f8ab62c7115",
    "preprocessor_config.json": "cd38cd59999e7a95d68e487fbe5132df3d4e5c32a0836add57e6126ba0c4eaf1",
}


def checksum(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def download(name, repository=REPOSITORY, revision=REVISION, files=FILES, target=TARGET):
    path = target / name
    expected = files[name]
    if not path.is_file() or checksum(path) != expected:
        temporary = path.with_suffix(path.suffix + ".part")
        with urllib.request.urlopen(f"https://huggingface.co/{repository}/resolve/{revision}/{name}", timeout=120) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        if checksum(temporary) != expected:
            raise RuntimeError("Model artifact checksum mismatch: " + name)
        temporary.replace(path)
    print(json.dumps({"event": "artifact_ready", "name": name, "bytes": path.stat().st_size}), flush=True)
    return {"name": name, "sha256": expected, "bytes": path.stat().st_size}


def main():
    models = [(REPOSITORY, REVISION, FILES, TARGET),
              (DETECTOR_REPOSITORY, DETECTOR_REVISION, DETECTOR_FILES, TARGET.parent / "rtdetr_v2_r18vd")]
    for repository, revision, files, target in models:
        target.mkdir(parents=True, exist_ok=True)
        with ThreadPoolExecutor(max_workers=3) as pool:
            artifacts = list(pool.map(lambda name: download(name, repository, revision, files, target), files))
        (target / "manifest.json").write_text(json.dumps({"repository": repository, "revision": revision, "files": artifacts}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
