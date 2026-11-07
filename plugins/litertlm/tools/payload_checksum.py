#!/usr/bin/env python3
"""Checksum a .litertlm file's payload, excluding the header block.

Repairing a model rewrites only the 16 KB header, so the payload must be
byte-identical before and after. This tool makes that assertion runnable, which is
what turns SC-005 ("payload remains byte-identical") and SC-011 (reversibility) from
claims into checks.

Skipping the first block is the point: hashing the whole file would differ
after a legitimate repair and prove nothing.

Usage:
    payload_checksum.py [--block-size <n>] <model.litertlm> [more.litertlm ...]

Exit codes: 0 ok, 1 unreadable file or unknown block size, 2 usage error.
"""

from __future__ import annotations

import hashlib
import os
import sys

from litert_lm_paths import candidate_site_packages, explicit_site_packages


def _runtime_block_size():
    """BLOCK_SIZE as the installed runtime defines it, or None if it cannot be read."""
    for c in filter(None, [explicit_site_packages(), *candidate_site_packages()]):
        if os.path.isdir(os.path.join(c, "litert_lm_builder")):
            sys.path.insert(0, c)
            break
    try:
        from litert_lm_builder import litertlm_core  # noqa: PLC0415
        return int(litertlm_core.BLOCK_SIZE)
    except Exception:  # noqa: BLE001
        return None


def resolve_block_size(explicit):
    """The block size to skip: the runtime's, or the one the caller named.

    There is deliberately no built-in fallback. This tool used to assume 16384 when the
    runtime could not be imported, and a wrong value hashes the wrong byte range: the
    "payload unchanged" comparison then means nothing, and its failure looks exactly
    like a pass. So guessing is refused, and the size in use is printed with every hash
    so that two runs which disagreed about it cannot be compared by accident.
    """
    if explicit is not None:
        return explicit
    size = _runtime_block_size()
    if size is None:
        raise SystemExit(
            "ERROR: could not read BLOCK_SIZE from the litert-lm runtime, so the header\n"
            "  boundary is unknown and refusing to guess it. Install the runtime, or set\n"
            "  LITERT_LM_SITE_PACKAGES, or pass --block-size <n> if you know the value.")
    return size


CHUNK = 1 << 20


def payload_sha256(path: str, block_size: int) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        f.seek(block_size)
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv: list[str]) -> int:
    explicit = None
    if argv[:1] == ["--block-size"]:
        try:
            explicit = int(argv[1])
        except (IndexError, ValueError):
            print("ERROR: --block-size requires an integer", file=sys.stderr)
            return 2
        if explicit <= 0:
            print("ERROR: --block-size must be positive", file=sys.stderr)
            return 2
        argv = argv[2:]
    if not argv:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    try:
        block_size = resolve_block_size(explicit)
    except SystemExit as exc:
        print(exc, file=sys.stderr)
        return 1

    rc = 0
    for raw in argv:
        # Expand ~ ourselves: PowerShell does not expand it inside quoted arguments,
        # so a path like "~/.litert-lm/..." arrives here literally.
        path = os.path.expanduser(raw)
        if not os.path.isfile(path):
            print(f"ERROR: not a file: {path}", file=sys.stderr)
            rc = 1
            continue
        size = os.path.getsize(path)
        if size <= block_size:
            print(f"ERROR: file smaller than one block, nothing to hash: {path}",
                  file=sys.stderr)
            rc = 1
            continue
        print(f"{payload_sha256(path, block_size)}  {os.path.basename(os.path.dirname(path))}"
              f"  ({size:,} bytes, first {block_size} excluded)")
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
