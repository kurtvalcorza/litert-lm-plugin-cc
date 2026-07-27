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

def _block_size():
    """Read BLOCK_SIZE from the runtime rather than hardcoding it.

    A wrong value here would silently hash the wrong byte range and make the
    "payload unchanged" comparison meaningless — the failure would look like a
    pass. Fall back to the observed 16384 only if the runtime is unavailable,
    since this tool must still work without it.
    """
    try:
        import glob  # noqa: PLC0415
        import os as _os  # noqa: PLC0415
        import sys as _sys  # noqa: PLC0415

        home = _os.path.expanduser("~")
        cands = [_os.environ.get("LITERT_LM_SITE_PACKAGES")]
        appdata = _os.environ.get("APPDATA")
        if appdata:
            cands.append(_os.path.join(appdata, "uv", "tools", "litert-lm",
                                       "Lib", "site-packages"))
        cands += glob.glob(_os.path.join(home, ".local", "share", "uv", "tools",
                                         "litert-lm", "lib", "python*", "site-packages"))
        for c in filter(None, cands):
            if _os.path.isdir(_os.path.join(c, "litert_lm_builder")):
                _sys.path.insert(0, c)
                break
        from litert_lm_builder import litertlm_core  # noqa: PLC0415
        return int(litertlm_core.BLOCK_SIZE)
    except Exception:  # noqa: BLE001
        return 16384


BLOCK_SIZE = _block_size()
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
