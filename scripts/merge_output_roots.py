#!/usr/bin/env python3
"""One-off: merge a stray ``<repo>/output`` data root into the user data root.

Why this exists
---------------
Every runtime path in the backend is relative (``self.data_file =
"output/projects.json"``, ``StaticFiles(directory="output/assets")``, ...), so
which physical ``output/`` you got depended on the launcher's cwd:

  * ``npm run dev`` / ``start_backend.sh`` / ``tauri dev``  -> ``<repo>/output``
  * packaged app (``sidecar_entry.py`` -> ``os.chdir(~/.1okstudio)``) -> ``~/.1okstudio/output``

That split is fixed in ``api.py`` (it now chdirs to the user data dir at import).
This script repairs the data that was written to the two roots in the meantime.

Usage
-----
    python scripts/merge_output_roots.py                 # dry run, prints the plan
    python scripts/merge_output_roots.py --apply         # do it
    python scripts/merge_output_roots.py --check-only    # verify a merged root

Policy
------
* JSON dict stores (``projects.json``, ``series.json``, ``library_assets.json``):
  union by key. On a key collision the record with the newer ``updated_at``
  (then ``created_at``) wins, and the collision is reported — guessing further
  would be worse than telling you.
* JSON list stores (``playground_history.json``, ``playground_templates.json``,
  ``script_skills.json``): union, de-duplicated by ``id``.
* Everything else (``assets/``, ``uploads/``, ``video/``, ``playground/``,
  ``skill_packages/``, ...): copy file by file. Existing files are never
  clobbered by an older one; collisions are reported.

Nothing is deleted from the source root, so the source stays as a free backup.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = REPO_ROOT / "output"
DEFAULT_TARGET = Path(os.environ.get("ONEOKSTUDIO_DATA_DIR", "~/.1okstudio")).expanduser() / "output"

DICT_STORES = ("projects.json", "series.json", "library_assets.json")
LIST_STORES = ("playground_history.json", "playground_templates.json", "script_skills.json")


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _write_json(path: Path, payload: Any) -> None:
    """Atomic write: a half-written projects.json is how data goes missing."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def _recency(record: Any) -> float:
    if not isinstance(record, dict):
        return 0.0
    for key in ("updated_at", "created_at", "timestamp", "created"):
        value = record.get(key)
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            try:
                from datetime import datetime

                return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
            except ValueError:
                continue
    return 0.0


def merge_dict_store(src: Path, dst: Path, apply: bool) -> List[str]:
    lines: List[str] = []
    source = _read_json(src)
    target = _read_json(dst) if dst.exists() else {}
    if not isinstance(source, dict) or not isinstance(target, dict):
        lines.append(f"  !! {src.name}: unexpected shape (src={type(source).__name__}, dst={type(target).__name__}) — skipped")
        return lines

    added = [k for k in source if k not in target]
    conflicts = [k for k in source if k in target]
    merged = dict(target)
    for key in added:
        merged[key] = source[key]
    for key in conflicts:
        if _recency(source[key]) > _recency(target[key]):
            merged[key] = source[key]
            lines.append(f"  ~~ {src.name}: '{key}' collision, took source (newer)")
        else:
            lines.append(f"  ~~ {src.name}: '{key}' collision, kept target (newer or undated)")

    lines.append(f"  ++ {src.name}: +{len(added)} added, {len(conflicts)} collision(s) -> {len(target)} becomes {len(merged)}")
    for key in added:
        label = merged[key].get("title") if isinstance(merged[key], dict) else None
        lines.append(f"       + {key}{f'  ({label})' if label else ''}")
    if apply and (added or conflicts):
        _write_json(dst, merged)
    return lines


def merge_list_store(src: Path, dst: Path, apply: bool) -> List[str]:
    lines: List[str] = []
    source = _read_json(src)
    target = _read_json(dst) if dst.exists() else []
    if not isinstance(source, list) or not isinstance(target, list):
        lines.append(f"  !! {src.name}: unexpected shape — skipped")
        return lines

    seen = {item.get("id") for item in target if isinstance(item, dict) and item.get("id")}
    merged = list(target)
    added = 0
    for item in source:
        item_id = item.get("id") if isinstance(item, dict) else None
        if item_id and item_id in seen:
            continue
        merged.append(item)
        added += 1
        if item_id:
            seen.add(item_id)
    lines.append(f"  ++ {src.name}: +{added} added -> {len(target)} becomes {len(merged)}")
    if apply and added:
        _write_json(dst, merged)
    return lines


def merge_tree(src_root: Path, dst_root: Path, apply: bool) -> Tuple[List[str], int, int]:
    lines: List[str] = []
    copied = kept = 0
    # JSON stores are merged key-by-key above; copying them wholesale would
    # clobber the merged result.
    handled = set(DICT_STORES) | set(LIST_STORES)
    for src_file in sorted(src_root.rglob("*")):
        if not src_file.is_file():
            continue
        rel = src_file.relative_to(src_root)
        if rel.as_posix() in handled:
            continue
        dst_file = dst_root / rel
        if not dst_file.exists():
            copied += 1
            if apply:
                dst_file.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src_file, dst_file)
            continue
        src_stat, dst_stat = src_file.stat(), dst_file.stat()
        if src_stat.st_size == dst_stat.st_size:
            kept += 1
            continue
        kept += 1
        lines.append(
            f"  ~~ {rel}: exists in both (src {src_stat.st_size}B vs dst {dst_stat.st_size}B) — kept target"
        )
    lines.append(f"  ++ files: +{copied} copied, {kept} already present")
    return lines, copied, kept


def check_root(root: Path) -> List[str]:
    """Post-merge check: every relative media path a project points at must exist."""
    problems: List[str] = []
    projects_path = root / "projects.json"
    if not projects_path.exists():
        return [f"  !! no projects.json under {root}"]
    projects = _read_json(projects_path)

    def walk(node: Any, project_id: str, key_path: str) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, project_id, f"{key_path}.{key}" if key_path else key)
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, project_id, f"{key_path}[{index}]")
        elif isinstance(node, str) and node.startswith("output/"):
            if not (root.parent / node).exists():
                problems.append(f"  !! {project_id[:8]} {key_path}: missing {node}")

    for project_id, project in projects.items():
        walk(project, project_id, "")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="stray root to drain (default: <repo>/output)")
    parser.add_argument("--target", type=Path, default=DEFAULT_TARGET, help="user data root to keep (default: ~/.1okstudio/output)")
    parser.add_argument("--apply", action="store_true", help="actually write (default: dry run)")
    parser.add_argument("--check-only", action="store_true", help="only run the post-merge reference check on --target")
    args = parser.parse_args()

    source: Path = args.source.expanduser().resolve()
    target: Path = args.target.expanduser().resolve()

    if args.check_only:
        problems = check_root(target)
        for line in problems:
            print(line)
        print(f"check: {len(problems)} dangling reference(s) under {target}")
        return 1 if problems else 0

    if source == target:
        print("source and target are the same directory — nothing to do")
        return 1
    for path in (source, target):
        if not path.is_dir():
            print(f"not a directory: {path}")
            return 1

    mode = "APPLY" if args.apply else "DRY RUN"
    print(f"[{mode}] {source}\n         -> {target}\n")

    report: List[str] = []
    for name in DICT_STORES:
        src_file, dst_file = source / name, target / name
        if not src_file.exists():
            report.append(f"  -- {name}: absent in source")
            continue
        report += merge_dict_store(src_file, dst_file, args.apply)
    for name in LIST_STORES:
        src_file, dst_file = source / name, target / name
        if not src_file.exists():
            report.append(f"  -- {name}: absent in source")
            continue
        report += merge_list_store(src_file, dst_file, args.apply)

    tree_lines, copied, kept = merge_tree(source, target, args.apply)
    report += tree_lines

    print("\n".join(report))

    target.mkdir(parents=True, exist_ok=True)
    if not (target / "projects.json").exists():
        report_projects = next((p for p in (source / "projects.json",) if p.exists()), None)
        if report_projects:
            if args.apply:
                shutil.copy2(report_projects, target / "projects.json")

    print("\n--- post-merge reference check ---")
    if args.apply:
        problems = check_root(target)
        for line in problems:
            print(line)
        print(f"check: {len(problems)} dangling reference(s)")
    else:
        print("  (skipped in dry run)")
    print(f"\n{'(dry run — rerun with --apply)' if not args.apply else 'done'} | source left untouched: {source}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
