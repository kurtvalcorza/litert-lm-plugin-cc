#!/usr/bin/env python3
"""Checksum a .litertlm file's payload, excluding the header block.

Repairing a model rewrites only the 16 KB header, so the payload must be
byte-identical before and after. This tool makes that assertion runnable, which is
what turns SC-005 ("payload remains byte-identical") and SC-011 (reversibility) from
claims into checks.

Skipping the first BLOCK_SIZE bytes is the point: hashing the whole file would differ
after a legitimate repair and prove nothing.

Usage:
    payload_checksum.py <model.litertlm> [more.litertlm ...]

Exit codes: 0 ok, 1 unreadable file, 2 usage error.
"""

from __future__ import annotations

import hashlib
import os
import sys

BLOCK_SIZE = 16384  # litertlm section alignment; header lives below this
CHUNK = 1 << 20


def payload_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        f.seek(BLOCK_SIZE)
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__.strip(), file=sys.stderr)
        return 2

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
        if size <= BLOCK_SIZE:
            print(f"ERROR: file smaller than one block, nothing to hash: {path}",
                  file=sys.stderr)
            rc = 1
            continue
        print(f"{payload_sha256(path)}  {os.path.basename(os.path.dirname(path))}"
              f"  ({size:,} bytes, header excluded)")
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
