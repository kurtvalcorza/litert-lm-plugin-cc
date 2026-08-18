"""Regression tests for litertlm_backend.read_header bounds.

WHY THIS RUNS WHERE IT DOES
---------------------------
litertlm_backend imports the litert-lm runtime at module load and raises
SystemExit if it is absent, so this suite can only import — and therefore only
run — where that runtime is installed (the maintainer's machine, the box the
plugin actually operates on). Everywhere else, including the current node-only
GitHub CI, it self-skips rather than failing. Run it with:

    python -m unittest discover -s tests -p 'test_*.py'
"""

import os
import struct
import sys
import tempfile
import unittest

# The module lives outside tests/; add tools/ to the path before importing.
_TOOLS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "plugins", "litertlm", "tools",
)
if _TOOLS not in sys.path:
    sys.path.insert(0, _TOOLS)

RUNTIME_OK = True
_IMPORT_ERR = ""
try:  # importing runs load_litertlm_modules(), which SystemExits without the runtime
    from litertlm_backend import read_header, CORE  # type: ignore
except BaseException as exc:  # noqa: BLE001 — SystemExit is not an Exception
    RUNTIME_OK = False
    _IMPORT_ERR = f"{type(exc).__name__}: {exc}"


def _write_litertlm(path, apparent_size, header_end):
    """Write a minimal .litertlm header, then extend the file to `apparent_size`
    bytes by seeking past the end. Sizes here are kept just over BLOCK_SIZE so this
    is fast and cross-platform (a genuinely multi-GB sparse file is not portable —
    Windows may zero-fill it)."""
    with open(path, "wb") as f:
        f.write(CORE.HEADER_MAGIC_BYTES)
        f.seek(CORE.HEADER_END_LOCATION_BYTE_OFFSET)
        f.write(struct.pack("<Q", header_end))
        if apparent_size > 0:
            f.seek(apparent_size - 1)
            f.write(b"\x00")


@unittest.skipUnless(RUNTIME_OK, f"litert-lm runtime not importable here ({_IMPORT_ERR})")
class ReadHeaderBoundsTest(unittest.TestCase):
    def test_header_end_equal_to_file_size_is_rejected(self):
        """The blocker from PR #16 review. With the old `header_end <= file_size`
        bound, header_end == file_size passed and read the whole file into memory —
        the DoS on a crafted multi-GB (sparse) model. This exercises the identical
        code path with a file just over BLOCK_SIZE: header_end == file_size but
        > BLOCK_SIZE must now be refused. Fails against the old bound, passes the new."""
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "crafted.litertlm")
            size = CORE.BLOCK_SIZE + 512
            _write_litertlm(p, apparent_size=size, header_end=size)
            with self.assertRaises(SystemExit):
                read_header(p)

    def test_header_end_just_past_block_size_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "over.litertlm")
            over = CORE.BLOCK_SIZE + 1
            _write_litertlm(p, apparent_size=over + 8, header_end=over)
            with self.assertRaises(SystemExit):
                read_header(p)

    def test_header_end_below_header_begin_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "under.litertlm")
            _write_litertlm(p, apparent_size=CORE.BLOCK_SIZE, header_end=0)
            with self.assertRaises(SystemExit):
                read_header(p)

    def test_valid_small_header_is_accepted(self):
        """A well-formed header within the first block must NOT be rejected —
        guards against the bound over-tightening into a false positive."""
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "ok.litertlm")
            header_end = CORE.HEADER_BEGIN_BYTE_OFFSET + 64
            _write_litertlm(p, apparent_size=CORE.BLOCK_SIZE, header_end=header_end)
            end, data = read_header(p)
            self.assertEqual(end, header_end)
            self.assertEqual(len(data), 64)


if __name__ == "__main__":
    unittest.main()
