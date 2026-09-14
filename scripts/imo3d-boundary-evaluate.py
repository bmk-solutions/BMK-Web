"""Replay cached image-boundary predictions locally without mutating a tour.

This checks projection/fit consistency, not agreement with surveyed architecture.
No reference-service geometry, model access or remote request is used.
"""
import argparse
import importlib.util
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profiles", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("envelope", Path(__file__).with_name("imo3d-room-envelope.py"))
    envelope = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(envelope)
    profiles = json.loads(Path(args.profiles).read_text(encoding="utf-8-sig"))["profiles"]
    results = []
    for scene_id, profile in profiles.items():
        try:
            result = envelope.outline_from_profiles(profile)
            results.append({"sceneId": scene_id, "vertices": len(result["outline"]),
                            "confidence": result["confidence"], "evidence": result["evidence"],
                            "outline": result["outline"]})
        except (ValueError, ArithmeticError) as error:
            results.append({"sceneId": scene_id, "error": str(error)})
    summary = {"profiles": len(profiles), "projected": sum("error" not in r for r in results),
               "regularized": sum(r.get("evidence", {}).get("regularized", False) for r in results),
               "independentWallFits": sum(r.get("evidence", {}).get("method") == "observed-independent-wall-lines" for r in results),
               "note": "Cached photographic boundary consistency only; no ground-truth architectural accuracy established."}
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps({"summary": summary, "results": results}, indent=2), encoding="utf-8")
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
