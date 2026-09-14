import copy
import importlib.util
import json
from pathlib import Path
import struct
import unittest
from unittest.mock import patch
import zlib


spec = importlib.util.spec_from_file_location("glb_pack", Path(__file__).resolve().parents[1] / "scripts/imo3d-glb-pack.py")
packer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packer)


def png(width=1, height=1):
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"\0\xff\x00\x00\xff")) + chunk(b"IEND", b"")


def primitive():
    return {"positions": [[-.1, 0, 0], [2, 0, 0], [0, 0, 3]], "normals": [[0, 2, 0]] * 3,
            "uv": [[0, 0], [1, 0], [0, 1]], "indices": [0, 1, 2], "roomId": "dining", "kind": "floor"}


def parse(data):
    magic, version, total = struct.unpack_from("<4sII", data)
    assert (magic, version, total) == (b"glTF", 2, len(data))
    json_length, json_kind = struct.unpack_from("<I4s", data, 12)
    assert json_kind == b"JSON" and json_length % 4 == 0
    document = json.loads(data[20:20 + json_length])
    offset = 20 + json_length
    bin_length, bin_kind = struct.unpack_from("<I4s", data, offset)
    assert bin_kind == b"BIN\0" and bin_length % 4 == 0
    assert offset + 8 + bin_length == len(data)
    return document, data[offset + 8:]


class GlbPackTests(unittest.TestCase):
    def test_colored_glb_contains_actual_rgb_and_rgba_accessors_without_images_or_uv(self):
        for colors in ([[1, 0, .5], [0, 1, .25], [.5, .25, 1]], [[1, 0, .5, 1], [0, 1, .25, .5], [.5, .25, 1, 0]]):
            mesh = {key: value for key, value in primitive().items() if key in ("positions", "normals", "indices")}
            mesh["colors"] = colors
            before = copy.deepcopy(mesh)
            document, binary = parse(packer.pack_colored_glb([mesh], extras={"source": "observed-depth"}))
            self.assertEqual(mesh, before)
            self.assertTrue({"images", "textures", "samplers", "extensionsUsed", "extensionsRequired"}.isdisjoint(document))
            attributes = document["meshes"][0]["primitives"][0]["attributes"]
            self.assertEqual(set(attributes), {"POSITION", "NORMAL", "COLOR_0"})
            accessor = document["accessors"][attributes["COLOR_0"]]
            width = len(colors[0])
            self.assertEqual((accessor["componentType"], accessor["type"], accessor["count"]), (5126, f"VEC{width}", 3))
            view = document["bufferViews"][accessor["bufferView"]]
            self.assertEqual(struct.unpack_from("<" + "f" * width * 3, binary, view["byteOffset"]), tuple(value for row in colors for value in row))
            self.assertEqual(document["nodes"][0]["extras"], {"roomId": "observed-component-0", "kind": "interior"})
            self.assertEqual(document["materials"][0]["pbrMetallicRoughness"], {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 1})
            self.assertTrue(document["materials"][0]["doubleSided"])
            self.assertTrue(all(view["byteOffset"] % 4 == 0 for view in document["bufferViews"]))

    def test_colored_glb_rejects_color_range_and_shape_mismatches(self):
        for colors in ([[1, 0, 0]] * 2, [[1, 0]] * 3, [[1, 0, 0], [1, 0, 0, 1], [1, 0, 0]], [[1.000000001, 0, 0]] * 3, [[-.001, 0, 0]] * 3, [[float("nan"), 0, 0]] * 3, [[float("inf"), 0, 0]] * 3):
            with self.subTest(colors=colors), self.assertRaises(ValueError):
                packer.pack_colored_glb([{**primitive(), "kind": "interior", "colors": colors}])

    def test_complete_binary_embeds_one_png_and_preserves_inputs(self):
        meshes = [primitive(), {**primitive(), "kind": "wall"}]
        before = copy.deepcopy(meshes)
        document, binary = parse(packer.pack_glb(meshes, png(), extras={"units": "camera_height", "metric": False}))
        self.assertEqual(meshes, before)
        self.assertEqual(len(document["images"]), 1)
        self.assertEqual(len(document["meshes"]), 2)
        self.assertEqual(document["extras"]["units"], "camera_height")
        self.assertNotIn("extensionsUsed", document)
        self.assertNotIn("uri", document["images"][0])
        self.assertNotIn("uri", document["buffers"][0])
        image = document["bufferViews"][document["images"][0]["bufferView"]]
        self.assertEqual(binary[image["byteOffset"]:image["byteOffset"] + image["byteLength"]], png())
        self.assertLessEqual(len(binary) - document["buffers"][0]["byteLength"], 3)
        for view in document["bufferViews"]:
            self.assertEqual(view["byteOffset"] % 4, 0)
            self.assertLessEqual(view["byteOffset"] + view["byteLength"], document["buffers"][0]["byteLength"])
        for node, mesh in zip(document["nodes"], document["meshes"]):
            self.assertEqual(node["extras"], mesh["extras"])
            self.assertEqual(node["extras"]["roomId"], "dining")
            self.assertEqual(set(node), {"mesh", "extras"})
        material = document["materials"][0]
        self.assertEqual((material["alphaMode"], material["alphaCutoff"], material["doubleSided"]), ("MASK", .5, True))
        self.assertEqual(material["pbrMetallicRoughness"]["metallicFactor"], 0)
        self.assertEqual(material["pbrMetallicRoughness"]["roughnessFactor"], 1)

    def test_interior_and_furniture_kinds_are_preserved_without_extensions_or_transforms(self):
        document, _ = parse(packer.pack_glb([{**primitive(), "kind": kind} for kind in ("interior", "furniture")], png()))
        self.assertEqual([mesh["extras"]["kind"] for mesh in document["meshes"]], ["interior", "furniture"])
        self.assertEqual([node["extras"]["kind"] for node in document["nodes"]], ["interior", "furniture"])
        def check(value):
            if isinstance(value, dict):
                self.assertFalse({"extensions", "extensionsUsed", "extensionsRequired", "matrix", "translation", "rotation", "scale"}.intersection(value))
                for child in value.values():
                    check(child)
            elif isinstance(value, list):
                for child in value:
                    check(child)
        check(document)

    def test_accessors_match_encoded_float_bounds_normalized_normals_and_indices(self):
        document, binary = parse(packer.pack_glb([primitive()], png()))
        for accessor in document["accessors"]:
            view = document["bufferViews"][accessor["bufferView"]]
            width = 1 if accessor["type"] == "SCALAR" else int(accessor["type"][-1])
            fmt = "f" if accessor["componentType"] == 5126 else "I"
            values = struct.unpack_from("<" + fmt * accessor["count"] * width, binary, view["byteOffset"])
            self.assertEqual(accessor["min"], [min(values[axis::width]) for axis in range(width)])
            self.assertEqual(accessor["max"], [max(values[axis::width]) for axis in range(width)])
        normal = document["accessors"][1]
        normal_offset = document["bufferViews"][normal["bufferView"]]["byteOffset"]
        self.assertEqual(struct.unpack_from("<3f", binary, normal_offset), (0, 1, 0))
        indices = document["accessors"][3]
        self.assertEqual(struct.unpack_from("<3I", binary, document["bufferViews"][indices["bufferView"]]["byteOffset"]), (0, 1, 2))

    def test_invalid_indices_shapes_and_mesh_metadata_reject(self):
        for update in ({"indices": [0, 1, 3]}, {"indices": [0, -1, 2]}, {"indices": [0, 1.0, 2]},
                       {"indices": [0, True, 2]}, {"indices": [0, 1]}, {"normals": [[0, 1, 0]]},
                       {"uv": [[0, 0, 0]] * 3}, {"roomId": ""}, {"kind": "ceiling"}):
            with self.subTest(update=update), self.assertRaises(ValueError):
                packer.pack_glb([{**primitive(), **update}], png())

    def test_nonfinite_float_overflow_zero_normals_and_nonfinite_extras_reject(self):
        for key, value in (("positions", float("nan")), ("positions", 1e100), ("uv", float("inf")), ("normals", float("-inf"))):
            p = primitive(); p[key] = copy.deepcopy(p[key]); p[key][0][0] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                packer.pack_glb([p], png())
        with self.assertRaises(ValueError):
            packer.pack_glb([{**primitive(), "normals": [[0, 0, 0]] * 3}], png())
        with self.assertRaises(ValueError):
            packer.pack_glb([primitive()], png(), extras={"scale": float("nan")})

    def test_png_header_dimensions_corruption_and_trailing_data_reject(self):
        for value in (b"not png", png(4097, 1), png(1, 4097), png(0, 1), png()[:-1], png() + b"external", png()[:20] + b"bad" + png()[23:]):
            with self.subTest(length=len(value)), self.assertRaises(ValueError):
                packer.pack_glb([primitive()], value)

    def test_global_triangle_texel_and_final_file_caps(self):
        with self.assertRaisesRegex(ValueError, "350000"):
            packer.pack_glb([{**primitive(), "indices": [0, 1, 2] * 175001}] * 2, png())
        with patch.object(packer, "MAX_TEXELS", 1), self.assertRaisesRegex(ValueError, "texel"):
            packer.pack_glb([primitive()], png(2, 1))
        # Set the cap between valid binary payload and its complete GLB length:
        # JSON and both chunk headers must count towards the final size limit.
        data = packer.pack_glb([primitive()], png())
        with patch.object(packer, "MAX_BYTES", len(data) - 1), self.assertRaisesRegex(ValueError, "40 MiB"):
            packer.pack_glb([primitive()], png())


if __name__ == "__main__":
    unittest.main()
