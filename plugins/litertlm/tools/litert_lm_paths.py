"""Where the litert-lm CLI's site-packages live, for the tools that need its modules.

One home on purpose. `litertlm_backend.py` and `payload_checksum.py` each carried this
list, and a location only one of them knew meant the two could read different
installations — or that one fell back to a guessed constant while the other used the
real one, a mismatch that reads as a pass.
"""

from __future__ import annotations

import glob
import os
import stat


def _safe_to_import_from(path):
    """May modules be imported from this auto-discovered directory?

    `sys.path` is code execution: a directory anyone else can write to is one anyone
    else can run code from, as this user, the next time a tool starts. POSIX can
    answer that from the mode and owner. Windows reports neither through `os.stat`,
    and these candidates sit under the user's own profile there, so it is not asked.
    """
    if os.name != "posix":
        return True
    try:
        st = os.stat(path)
    except OSError:
        return False
    if st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        return False
    return st.st_uid == os.getuid()


def candidate_site_packages():
    """Plausible locations of the litert-lm CLI's site-packages, across platforms."""
    home = os.path.expanduser("~")
    pats = []
    appdata = os.environ.get("APPDATA")
    if appdata:  # Windows, `uv tool install`
        pats.append(os.path.join(appdata, "uv", "tools", "litert-lm", "Lib", "site-packages"))
    pats += [
        # Linux / macOS, `uv tool install`
        os.path.join(home, ".local", "share", "uv", "tools", "litert-lm",
                     "lib", "python*", "site-packages"),
        # pipx
        os.path.join(home, ".local", "pipx", "venvs", "litert-lm",
                     "lib", "python*", "site-packages"),
    ]
    out = []
    for p in pats:
        found = sorted(glob.glob(p)) if "*" in p else ([p] if os.path.isdir(p) else [])
        out.extend(c for c in found if _safe_to_import_from(c))
    return out


def explicit_site_packages():
    """LITERT_LM_SITE_PACKAGES, or None. Must be absolute when set.

    A relative value resolves against whatever directory the tool happens to run in,
    which turns "the repository I just cloned" into an import path.
    """
    override = os.environ.get("LITERT_LM_SITE_PACKAGES")
    if not override:
        return None
    if not os.path.isabs(override):
        raise SystemExit(
            f"LITERT_LM_SITE_PACKAGES must be an absolute path, got:\n  {override}\n"
            "  A relative value would import from the current directory.")
    return override
