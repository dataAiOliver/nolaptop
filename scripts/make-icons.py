#!/usr/bin/env python3
"""Generate the PWA icons.

No image library on the box, so this writes PNGs directly: RGBA pixels, zlib,
CRC32. The mark is a terminal prompt — a chevron and a cursor bar — on the
Claude accent colour, drawn with a signed-distance field so the edges stay
smooth at every size.
"""

import math
import struct
import zlib
from pathlib import Path

ACCENT = (217, 119, 87)
INK = (26, 15, 10)
OUT = Path(__file__).resolve().parent.parent / "public"

Point = tuple[float, float]


def rounded_rect_sdf(x: float, y: float, size: float, radius: float) -> float:
    """Distance to a centred rounded square; negative inside."""
    half = size / 2
    dx = abs(x - half) - (half - radius)
    dy = abs(y - half) - (half - radius)
    ax, ay = max(dx, 0.0), max(dy, 0.0)
    return math.hypot(ax, ay) + min(max(dx, dy), 0.0) - radius


def segment_sdf(x: float, y: float, a: Point, b: Point) -> float:
    """Distance from (x, y) to the line segment a—b."""
    ax, ay = a
    bx, by = b
    px, py = x - ax, y - ay
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    t = 0.0 if length_sq == 0 else max(0.0, min(1.0, (px * dx + py * dy) / length_sq))
    return math.hypot(px - dx * t, py - dy * t)


def blend(base: tuple[int, int, int], over: tuple[int, int, int], alpha: float):
    return tuple(round(b + (o - b) * alpha) for b, o in zip(base, over))


def render(size: int, padded: bool) -> bytes:
    """One RGBA image. `padded` leaves the safe margin a maskable icon needs."""
    s = float(size)
    # A maskable icon may be cropped to a circle, so keep the mark well inside.
    inset = s * 0.18 if padded else 0.0
    mark_size = s - 2 * inset
    radius = s * 0.22 if not padded else 0.0
    stroke = mark_size * 0.085
    aa = s * 0.012  # antialiasing width

    # Chevron ">" and the cursor bar, in mark-local coordinates.
    cx, cy = inset + mark_size * 0.40, inset + mark_size * 0.50
    arm = mark_size * 0.17
    chevron = [
        ((cx - arm, cy - arm), (cx + arm * 0.35, cy)),
        ((cx + arm * 0.35, cy), (cx - arm, cy + arm)),
    ]
    bar = (
        (inset + mark_size * 0.56, cy + arm),
        (inset + mark_size * 0.80, cy + arm),
    )

    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            x, y = px + 0.5, py + 0.5

            if padded:
                # Full-bleed background: the platform does the masking.
                pixel = ACCENT
                alpha = 1.0
            else:
                d = rounded_rect_sdf(x, y, s, radius)
                alpha = max(0.0, min(1.0, 0.5 - d / aa))
                pixel = ACCENT

            if alpha > 0:
                dist = min(
                    min(segment_sdf(x, y, *seg) for seg in chevron),
                    segment_sdf(x, y, *bar),
                )
                ink = max(0.0, min(1.0, 0.5 - (dist - stroke / 2) / aa))
                if ink > 0:
                    pixel = blend(pixel, INK, ink)

            row += bytes((*pixel, round(alpha * 255)))
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + row for row in rows)
    return png(size, size, raw)


def png(width: int, height: int, raw: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, True),
        ("favicon-32.png", 32, False),
    ]
    for name, size, padded in targets:
        (OUT / name).write_bytes(render(size, padded))
        print(f"wrote public/{name} ({size}px)")


if __name__ == "__main__":
    main()
