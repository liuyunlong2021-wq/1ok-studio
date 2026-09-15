#!/usr/bin/env python3
"""Fail when a bundled Mach-O requires a newer macOS than advertised."""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path


MACHO_MAGICS = {
    b"\xfe\xed\xfa\xce",
    b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf",
    b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe",
    b"\xbe\xba\xfe\xca",
    b"\xca\xfe\xba\xbf",
    b"\xbf\xba\xfe\xca",
}


def version(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in value.split("."))


def files_under(path: Path):
    if path.is_file():
        yield path
    elif path.is_dir():
        yield from (item for item in path.rglob("*") if item.is_file() and not item.is_symlink())


def macho_minimums(path: Path) -> list[str]:
    try:
        with path.open("rb") as stream:
            if stream.read(4) not in MACHO_MAGICS:
                return []
    except OSError:
        return []

    result = subprocess.run(
        ["/usr/bin/otool", "-l", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    return re.findall(r"^\s*minos\s+([0-9.]+)\s*$", result.stdout, re.MULTILINE)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max", required=True, dest="maximum")
    parser.add_argument("paths", nargs="+")
    args = parser.parse_args()

    maximum = version(args.maximum)
    checked = 0
    incompatible: list[tuple[Path, str]] = []
    seen: set[Path] = set()

    for root in map(Path, args.paths):
        for path in files_under(root):
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            minimums = macho_minimums(path)
            checked += bool(minimums)
            incompatible.extend(
                (path, minimum) for minimum in minimums if version(minimum) > maximum
            )

    if incompatible:
        print(f"❌ macOS compatibility check failed (declared maximum: {args.maximum})")
        for path, minimum in incompatible:
            print(f"  minos {minimum}: {path}")
        return 1

    print(f"✓ macOS compatibility: {checked} Mach-O files support macOS {args.maximum}+")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
