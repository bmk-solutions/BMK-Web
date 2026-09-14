"""Dependency-free glTF 2.0 binary packing for the private room reconstruction.

The atlas is embedded once. No files, network resources, extensions, or scene
coordinates are read or changed by this module.
"""

import json
import math
import numbers
import struct
import zlib


MAX_TRIANGLES = 350_000
MAX_TEXTURE_SIDE = 4096
MAX_TEXELS = 16 * 1024 * 1024
MAX_BYTES = 40 * 1024 * 1024
_PNG = b"\x89PNG\r\n\x1a\n"


def _validate_png(value):
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise ValueError("Atlas must be PNG bytes")
    if len(value) > MAX_BYTES:
        raise ValueError("Atlas exceeds the GLB size limit")
    data = bytes(value)
    if len(data) < 33 or not data.startswith(_PNG):
        raise ValueError("Invalid PNG signature or header")
    offset = 8
    saw_header = saw_data = False
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError("Truncated PNG chunk")
        size, kind = struct.unpack_from(">I4s", data, offset)
        end = offset + 12 + size
        if end > len(data):
            raise ValueError("Truncated PNG chunk")
        body = data[offset + 8:offset + 8 + size]
        crc = struct.unpack_from(">I", data, offset + 8 + size)[0]
        if zlib.crc32(kind + body) & 0xFFFFFFFF != crc:
            raise ValueError("Invalid PNG checksum")
        if not saw_header and kind != b"IHDR":
            raise ValueError("PNG must begin with IHDR")
        if kind == b"IHDR":
            if saw_header or size != 13:
                raise ValueError("Invalid PNG IHDR")
            width, height, bits, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", body)
            if not 0 < width <= MAX_TEXTURE_SIDE or not 0 < height <= MAX_TEXTURE_SIDE or width * height > MAX_TEXELS:
                raise ValueError("PNG exceeds 4096-side or 16 Mi-texel limit")
            depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
            if bits not in depths.get(color, ()) or compression != 0 or filtering != 0 or interlace not in (0, 1):
                raise ValueError("Invalid PNG format")
            saw_header = True
        elif kind == b"IDAT":
            saw_data = True
        elif kind == b"IEND":
            if size != 0 or not saw_data or end != len(data):
                raise ValueError("Invalid PNG termination")
            return data
        offset = end
    raise ValueError("PNG has no IEND")


def _length(value, label):
    try:
        size = len(value)
    except (TypeError, AttributeError) as error:
        raise ValueError(f"{label} must be an array") from error
    if isinstance(value, (str, bytes, bytearray, dict)):
        raise ValueError(f"{label} must be a numeric array")
    return size


def _float_array(rows, width, label, *, normalize=False):
    packed = bytearray()
    minima, maxima = [math.inf] * width, [-math.inf] * width
    for row in rows:
        if _length(row, label) != width:
            raise ValueError(f"{label} rows must have {width} values")
        values = []
        for value in row:
            if isinstance(value, bool) or not isinstance(value, numbers.Real):
                raise ValueError(f"{label} values must be finite numbers")
            number = float(value)
            if not math.isfinite(number):
                raise ValueError(f"{label} values must be finite numbers")
            values.append(number)
        if normalize:
            length = math.hypot(*values)
            if not math.isfinite(length) or length <= 1e-12:
                raise ValueError("Normals must have a finite nonzero length")
            values = [number / length for number in values]
        try:
            encoded = struct.pack("<" + "f" * width, *values)
        except (OverflowError, struct.error) as error:
            raise ValueError(f"{label} values exceed float32 range") from error
        # Bounds describe the actual float32 data, including its rounding.
        stored = struct.unpack("<" + "f" * width, encoded)
        if not all(math.isfinite(value) for value in stored):
            raise ValueError(f"{label} values exceed float32 range")
        for axis, number in enumerate(stored):
            minima[axis] = min(minima[axis], number)
            maxima[axis] = max(maxima[axis], number)
        packed.extend(encoded)
    return packed, minima, maxima


def pack_glb(primitives, png_bytes, *, extras=None):
    """Return a self-contained GLB from triangle meshes and one PNG atlas.

    Numeric array-like rows (including caller-owned NumPy arrays) are accepted
    without importing numerical packages. Normals are normalized in the output.
    Invalid input raises ValueError; the caller's arrays are never modified.
    """
    primitive_count = _length(primitives, "Primitives")
    if not 0 < primitive_count <= 4096:
        raise ValueError("Expected 1 to 4096 primitives")
    png = _validate_png(png_bytes)
    try:
        copied_extras = None if extras is None else json.loads(json.dumps(extras, allow_nan=False))
    except (TypeError, ValueError, OverflowError, RecursionError) as error:
        raise ValueError("Extras must be finite JSON data") from error
    document = {
        "asset": {"version": "2.0", "generator": "IMO 3D local architectural mesh"},
        "scene": 0, "scenes": [{"nodes": []}], "nodes": [], "meshes": [],
        "buffers": [{"byteLength": 0}], "bufferViews": [], "accessors": [],
        "images": [], "textures": [{"sampler": 0, "source": 0}],
        "samplers": [{"magFilter": 9729, "minFilter": 9729, "wrapS": 33071, "wrapT": 33071}],
        "materials": [{"name": "Embedded room atlas", "pbrMetallicRoughness": {
            "baseColorTexture": {"index": 0, "texCoord": 0}, "metallicFactor": 0,
            "roughnessFactor": 1}, "doubleSided": True, "alphaMode": "MASK", "alphaCutoff": .5}],
    }
    if copied_extras is not None:
        document["extras"] = copied_extras
    binary = bytearray()

    def view(data, target=None):
        binary.extend(b"\0" * (-len(binary) % 4))
        if len(binary) + len(data) > MAX_BYTES:
            raise ValueError("GLB exceeds 40 MiB limit")
        result = {"buffer": 0, "byteOffset": len(binary), "byteLength": len(data)}
        if target is not None:
            result["target"] = target
        binary.extend(data)
        index = len(document["bufferViews"])
        document["bufferViews"].append(result)
        return index

    def accessor(data, count, width, component, target, minima, maxima):
        index = len(document["accessors"])
        document["accessors"].append({"bufferView": view(data, target), "byteOffset": 0,
            "componentType": component, "count": count, "type": "SCALAR" if width == 1 else f"VEC{width}",
            "min": minima, "max": maxima})
        return index

    triangles = vertices = 0
    for primitive in primitives:
        if not isinstance(primitive, dict) or any(key not in primitive for key in ("positions", "normals", "uv", "indices", "roomId", "kind")):
            raise ValueError("Incomplete mesh primitive")
        room_id, kind = primitive["roomId"], primitive["kind"]
        if not isinstance(room_id, str) or not room_id or len(room_id) > 256 or kind not in ("floor", "wall", "furniture", "interior"):
            raise ValueError("Invalid roomId or primitive kind")
        count = _length(primitive["positions"], "Positions")
        index_count = _length(primitive["indices"], "Indices")
        if count < 3 or index_count < 3 or index_count % 3:
            raise ValueError("A primitive must contain complete indexed triangles")
        triangles += index_count // 3
        vertices += count
        if triangles > MAX_TRIANGLES or vertices > MAX_TRIANGLES * 3:
            raise ValueError("Mesh exceeds 350000-triangle or vertex limit")
        if _length(primitive["normals"], "Normals") != count or _length(primitive["uv"], "UV") != count:
            raise ValueError("Positions, normals and UV counts must agree")
        attributes = {}
        for name, key, width in (("POSITION", "positions", 3), ("NORMAL", "normals", 3), ("TEXCOORD_0", "uv", 2)):
            data, low, high = _float_array(primitive[key], width, key, normalize=key == "normals")
            attributes[name] = accessor(data, count, width, 5126, 34962, low, high)
        indices = bytearray()
        low, high = count, -1
        for value in primitive["indices"]:
            if isinstance(value, bool) or not isinstance(value, numbers.Integral) or not 0 <= int(value) < count:
                raise ValueError("Indices must be integer references to existing vertices")
            index = int(value)
            indices.extend(struct.pack("<I", index))
            low, high = min(low, index), max(high, index)
        index_accessor = accessor(indices, index_count, 1, 5125, 34963, [low], [high])
        metadata = {"roomId": room_id, "kind": kind}
        mesh_index = len(document["meshes"])
        document["meshes"].append({"name": f"{room_id}:{kind}", "extras": dict(metadata),
            "primitives": [{"attributes": attributes, "indices": index_accessor, "material": 0, "mode": 4}]})
        document["nodes"].append({"mesh": mesh_index, "extras": dict(metadata)})
        document["scenes"][0]["nodes"].append(mesh_index)
    document["images"].append({"bufferView": view(png), "mimeType": "image/png"})
    document["buffers"][0]["byteLength"] = len(binary)
    json_chunk = json.dumps(document, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf8")
    json_chunk += b" " * (-len(json_chunk) % 4)
    binary.extend(b"\0" * (-len(binary) % 4))
    total = 12 + 8 + len(json_chunk) + 8 + len(binary)
    if total > MAX_BYTES:
        raise ValueError("GLB exceeds 40 MiB limit")
    return b"".join((struct.pack("<4sII", b"glTF", 2, total),
        struct.pack("<I4s", len(json_chunk), b"JSON"), json_chunk,
        struct.pack("<I4s", len(binary), b"BIN\0"), binary))


def pack_colored_glb(primitives, *, extras=None):
    """Pack observed triangle surfaces using per-vertex COLOR_0, without images.

    Colors are RGB or RGBA floats in [0, 1]. The room identifier defaults to an
    observed component label; no room polygon, texture, or UV is required.
    """
    if not 0 < _length(primitives, "Primitives") <= 4096:
        raise ValueError("Expected 1 to 4096 primitives")
    try:
        copied_extras = None if extras is None else json.loads(json.dumps(extras, allow_nan=False))
    except (TypeError, ValueError, OverflowError, RecursionError) as error:
        raise ValueError("Extras must be finite JSON data") from error
    document = {
        "asset": {"version": "2.0", "generator": "IMO 3D observed depth mesh"},
        "scene": 0, "scenes": [{"nodes": []}], "nodes": [], "meshes": [],
        "buffers": [{"byteLength": 0}], "bufferViews": [], "accessors": [],
        "materials": [{"name": "Observed surface colors", "pbrMetallicRoughness": {
            "baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0,
            "roughnessFactor": 1}, "doubleSided": True}],
    }
    if copied_extras is not None:
        document["extras"] = copied_extras
    binary = bytearray()

    def accessor(data, count, width, component, target, minima, maxima):
        binary.extend(b"\0" * (-len(binary) % 4))
        if len(binary) + len(data) > MAX_BYTES:
            raise ValueError("GLB exceeds 40 MiB limit")
        view_index = len(document["bufferViews"])
        document["bufferViews"].append({"buffer": 0, "byteOffset": len(binary),
            "byteLength": len(data), "target": target})
        binary.extend(data)
        index = len(document["accessors"])
        document["accessors"].append({"bufferView": view_index, "byteOffset": 0,
            "componentType": component, "count": count,
            "type": "SCALAR" if width == 1 else f"VEC{width}", "min": minima, "max": maxima})
        return index

    triangles = vertices = 0
    for primitive in primitives:
        if not isinstance(primitive, dict) or any(key not in primitive for key in ("positions", "normals", "colors", "indices")):
            raise ValueError("Incomplete colored mesh primitive")
        room_id, kind = primitive.get("roomId", "observed-component-0"), primitive.get("kind", "interior")
        if not isinstance(room_id, str) or not room_id or len(room_id) > 256 or kind != "interior":
            raise ValueError("Invalid observed component identifier or kind")
        count, index_count = _length(primitive["positions"], "Positions"), _length(primitive["indices"], "Indices")
        if count < 3 or index_count < 3 or index_count % 3:
            raise ValueError("A primitive must contain complete indexed triangles")
        triangles += index_count // 3
        vertices += count
        if triangles > MAX_TRIANGLES or vertices > MAX_TRIANGLES * 3:
            raise ValueError("Mesh exceeds 350000-triangle or vertex limit")
        if _length(primitive["normals"], "Normals") != count or _length(primitive["colors"], "Colors") != count:
            raise ValueError("Positions, normals and colors counts must agree")
        color_width = _length(primitive["colors"][0], "Colors")
        if color_width not in (3, 4):
            raise ValueError("Colors must contain RGB or RGBA rows")
        for row in primitive["colors"]:
            if _length(row, "Colors") != color_width or any(isinstance(value, bool) or not isinstance(value, numbers.Real) or not math.isfinite(float(value)) or not 0 <= float(value) <= 1 for value in row):
                raise ValueError("Colors must be finite RGB or RGBA values in [0, 1]")
        attributes = {}
        for name, key, width in (("POSITION", "positions", 3), ("NORMAL", "normals", 3), ("COLOR_0", "colors", color_width)):
            data, low, high = _float_array(primitive[key], width, key, normalize=key == "normals")
            attributes[name] = accessor(data, count, width, 5126, 34962, low, high)
        indices = bytearray()
        low, high = count, -1
        for value in primitive["indices"]:
            if isinstance(value, bool) or not isinstance(value, numbers.Integral) or not 0 <= int(value) < count:
                raise ValueError("Indices must be integer references to existing vertices")
            index = int(value)
            indices.extend(struct.pack("<I", index))
            low, high = min(low, index), max(high, index)
        index_accessor = accessor(indices, index_count, 1, 5125, 34963, [low], [high])
        mesh_index = len(document["meshes"])
        metadata = {"roomId": room_id, "kind": kind}
        document["meshes"].append({"name": f"{room_id}:{kind}", "extras": dict(metadata),
            "primitives": [{"attributes": attributes, "indices": index_accessor, "material": 0, "mode": 4}]})
        document["nodes"].append({"mesh": mesh_index, "extras": dict(metadata)})
        document["scenes"][0]["nodes"].append(mesh_index)
    document["buffers"][0]["byteLength"] = len(binary)
    json_chunk = json.dumps(document, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf8")
    json_chunk += b" " * (-len(json_chunk) % 4)
    binary.extend(b"\0" * (-len(binary) % 4))
    total = 12 + 8 + len(json_chunk) + 8 + len(binary)
    if total > MAX_BYTES:
        raise ValueError("GLB exceeds 40 MiB limit")
    return b"".join((struct.pack("<4sII", b"glTF", 2, total),
        struct.pack("<I4s", len(json_chunk), b"JSON"), json_chunk,
        struct.pack("<I4s", len(binary), b"BIN\0"), binary))
