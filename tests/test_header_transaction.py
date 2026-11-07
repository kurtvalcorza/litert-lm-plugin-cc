"""Failure-injection tests for the model-header transaction (RFC #18, PR A).

Every test works on a small but real container: a genuine flatbuffer header built with
the runtime's own schema, so `patch` runs its real round-trip guard. Like the bounds
tests beside it, this needs the litert-lm runtime importable and self-skips without it.
"""

import contextlib
import hashlib
import importlib
import io
import os
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest import mock

_TOOLS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "plugins", "litertlm", "tools",
)
if _TOOLS not in sys.path:
    sys.path.insert(0, _TOOLS)

RUNTIME_OK = True
_IMPORT_ERR = ""
try:
    import litertlm_backend as lb  # type: ignore
except BaseException as exc:  # noqa: BLE001 — SystemExit is not an Exception
    RUNTIME_OK = False
    _IMPORT_ERR = f"{type(exc).__name__}: {exc}"


def _kv(key, value):
    sv = lb.SCHEMA.StringValueT()
    sv.value = value
    kv = lb.SCHEMA.KeyValuePairT()
    kv.key = key
    kv.valueType = lb.SCHEMA.VData.StringValue
    kv.value = sv
    return kv


def _header(begin=16384, end=16384 + 4096, constraint=None):
    """A real header: one prefill/decode section plus system metadata."""
    sec = lb.SCHEMA.SectionObjectT()
    sec.beginOffset = begin
    sec.endOffset = end
    sec.dataType = lb.SCHEMA.AnySectionDataType.TFLiteModel
    sec.items = [_kv("model_type", lb.PREFILL_DECODE)]
    if constraint is not None:
        sec.items.append(_kv(lb.KEY, constraint))
    section_md = lb.SCHEMA.SectionMetadataT()
    section_md.objects = [sec]
    system_md = lb.SCHEMA.SystemMetadataT()
    system_md.entries = [_kv("author", "the test suite")]
    meta = lb.SCHEMA.LiteRTLMMetaDataT()
    meta.sectionMetadata = section_md
    meta.systemMetadata = system_md
    builder = lb.flatbuffers.Builder(0)
    builder.Finish(meta.Pack(builder))
    return bytes(builder.Output())


def _container(path, **kw):
    """Write a container whose payload is recognisably not zeros."""
    head = _header(**kw)
    end = lb.CORE.HEADER_BEGIN_BYTE_OFFSET + len(head)
    block = bytearray(lb.CORE.BLOCK_SIZE)
    block[:8] = lb.CORE.HEADER_MAGIC_BYTES
    struct.pack_into("<Q", block, lb.CORE.HEADER_END_LOCATION_BYTE_OFFSET, end)
    block[lb.CORE.HEADER_BEGIN_BYTE_OFFSET:end] = head
    with open(path, "wb") as f:
        f.write(bytes(block))
        f.write(bytes(range(256)) * 16)
    return bytes(block)


def _first_block(path):
    with open(path, "rb") as f:
        return f.read(lb.CORE.BLOCK_SIZE)


def _payload_digest(path):
    with open(path, "rb") as f:
        f.seek(lb.CORE.BLOCK_SIZE)
        return hashlib.sha256(f.read()).hexdigest()


def _patch(path, backend="gpu"):
    with contextlib.redirect_stdout(io.StringIO()):
        lb.cmd_patch(SimpleNamespace(model=path, backend=backend, yes=True,
                                     legacy_header_edit=True))


def _restore(path, original=False, force=False):
    with contextlib.redirect_stdout(io.StringIO()):
        lb.cmd_restore(SimpleNamespace(model=path, original=original, force=force, yes=True))


def _discard(path):
    with contextlib.redirect_stdout(io.StringIO()):
        lb.cmd_discard_backup(SimpleNamespace(model=path, yes=True))


class _Crash(BaseException):
    """Stands in for the power cut: not an Exception, so nothing can swallow it."""


def _crash_at_write(n):
    """Let n-1 positioned writes land, then die on the n-th."""
    real = lb._pwrite
    calls = {"n": 0}

    def cut(f, offset, data):
        calls["n"] += 1
        if calls["n"] == n:
            raise _Crash()
        real(f, offset, data)
    return mock.patch.object(lb, "_pwrite", cut)


@unittest.skipUnless(RUNTIME_OK, f"litert-lm runtime not importable here ({_IMPORT_ERR})")
class Case(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.model = os.path.join(self.dir, "model.litertlm")
        self.backup = lb._backup_path(self.model)
        self.original = lb._original_path(self.model)
        self.block = _container(self.model)
        self.payload = _payload_digest(self.model)


class SuccessfulPatch(Case):
    def test_rewrites_only_the_header_and_leaves_no_backup(self):
        _patch(self.model)
        _, seen = lb.read_header(self.model)
        self.assertEqual(lb._main_constraint(seen), ["gpu"])
        self.assertEqual(lb._layout(seen), lb._layout(lb._block_header(self.block)[1]))
        self.assertEqual(_payload_digest(self.model), self.payload)
        self.assertFalse(os.path.lexists(self.backup))

    def test_original_block_survives_later_patches(self):
        _patch(self.model, "gpu")
        _patch(self.model, "cpu")
        _patch(self.model, "gpu")
        with open(self.original, "rb") as f:
            self.assertEqual(f.read(), self.block)

    def test_reversal_by_backend_is_behaviour_not_bytes(self):
        """F-09, stated as a test: this is why `restore --original` has to exist."""
        _patch(self.model, "gpu")
        _patch(self.model, "cpu")
        self.assertNotEqual(_first_block(self.model), self.block)

    def test_restore_original_is_byte_exact_and_clears_the_copy(self):
        _patch(self.model, "gpu")
        _patch(self.model, "cpu")
        _restore(self.model, original=True)
        self.assertEqual(_first_block(self.model), self.block)
        self.assertEqual(_payload_digest(self.model), self.payload)
        self.assertFalse(os.path.lexists(self.original))
        self.assertFalse(os.path.lexists(self.backup))

    def test_next_patch_after_restore_records_a_fresh_original(self):
        _patch(self.model)
        _restore(self.model, original=True)
        _patch(self.model)
        with open(self.original, "rb") as f:
            self.assertEqual(f.read(), self.block)


class ExistingBackup(Case):
    def test_valid_backup_refuses_patch_and_is_untouched(self):
        sentinel = bytes(reversed(self.block))
        with open(self.backup, "wb") as f:
            f.write(sentinel)
        before = _first_block(self.model)
        with self.assertRaises(SystemExit) as caught:
            _patch(self.model)
        self.assertIn("already present", str(caught.exception))
        with open(self.backup, "rb") as f:
            self.assertEqual(f.read(), sentinel)
        self.assertEqual(_first_block(self.model), before)

    def test_check_reports_it_too(self):
        with open(self.backup, "wb") as f:
            f.write(self.block)
        with self.assertRaises(SystemExit):
            lb.cmd_check(SimpleNamespace(model=self.model, backend="gpu"))

    def test_directory_at_backup_path_is_left_alone(self):
        os.mkdir(self.backup)
        with self.assertRaises(SystemExit) as caught:
            _patch(self.model)
        self.assertIn("other than a regular file", str(caught.exception))
        self.assertTrue(os.path.isdir(self.backup))
        self.assertEqual(_first_block(self.model), self.block)

    def _symlink(self, target, link):
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError) as e:
            self.skipTest(f"cannot create symlinks here: {e}")

    def test_symlink_at_backup_path_never_writes_through(self):
        victim = os.path.join(self.dir, "victim.txt")
        with open(victim, "wb") as f:
            f.write(b"do not touch")
        self._symlink(victim, self.backup)
        with self.assertRaises(SystemExit):
            _patch(self.model)
        with open(victim, "rb") as f:
            self.assertEqual(f.read(), b"do not touch")
        self.assertEqual(_first_block(self.model), self.block)

    def test_dangling_symlink_is_refused_not_created_through(self):
        target = os.path.join(self.dir, "would-be-created")
        self._symlink(target, self.backup)
        with self.assertRaises(SystemExit):
            _patch(self.model)
        self.assertFalse(os.path.exists(target))

    def test_link_planted_after_the_check_still_cannot_redirect(self):
        """The pre-check is advice; exclusive creation is the defence. Plant the link in
        the gap between them, which is the race a check-then-open would lose."""
        victim = os.path.join(self.dir, "victim.txt")
        with open(victim, "wb") as f:
            f.write(b"do not touch")
        real = lb._validate

        def plant(*args):
            out = real(*args)
            self._symlink(victim, self.backup)
            return out

        with mock.patch.object(lb, "_validate", plant):
            with self.assertRaises(SystemExit):
                _patch(self.model)
        with open(victim, "rb") as f:
            self.assertEqual(f.read(), b"do not touch")
        self.assertEqual(_first_block(self.model), self.block)

    def test_symlinked_backup_is_not_read_by_restore(self):
        decoy = os.path.join(self.dir, "decoy.bin")
        with open(decoy, "wb") as f:
            f.write(self.block)
        self._symlink(decoy, self.backup)
        with self.assertRaises(SystemExit):
            _restore(self.model)

    def test_symlinked_model_is_refused(self):
        link = os.path.join(self.dir, "link.litertlm")
        self._symlink(self.model, link)
        with self.assertRaises(SystemExit) as caught:
            _patch(link)
        self.assertIn("not a regular file", str(caught.exception))
        self.assertEqual(_first_block(self.model), self.block)

    def test_discard_keeps_the_model_and_clears_the_way(self):
        with open(self.backup, "wb") as f:
            f.write(self.block)
        _discard(self.model)
        self.assertFalse(os.path.lexists(self.backup))
        self.assertEqual(_first_block(self.model), self.block)
        _patch(self.model)

    def test_discard_refuses_while_the_header_is_broken(self):
        with _crash_at_write(2), self.assertRaises(_Crash), contextlib.redirect_stderr(io.StringIO()):
            _patch(self.model)
        with open(self.model, "r+b") as f:
            f.seek(lb.CORE.HEADER_END_LOCATION_BYTE_OFFSET)
            f.write(struct.pack("<Q", 3))
        with self.assertRaises(SystemExit):
            _discard(self.model)
        self.assertTrue(os.path.isfile(self.backup))


class Interruption(Case):
    def _interrupted(self, n):
        with _crash_at_write(n), self.assertRaises(_Crash), contextlib.redirect_stderr(io.StringIO()):
            _patch(self.model)
        self.assertTrue(os.path.isfile(self.backup))

    def test_before_any_write(self):
        self._interrupted(1)
        self.assertEqual(_first_block(self.model), self.block)
        _restore(self.model)
        self.assertEqual(_first_block(self.model), self.block)

    def test_between_header_and_length(self):
        self._interrupted(2)
        self.assertNotEqual(_first_block(self.model), self.block)
        _restore(self.model)
        self.assertEqual(_first_block(self.model), self.block)
        self.assertFalse(os.path.lexists(self.backup))
        self.assertEqual(_payload_digest(self.model), self.payload)

    def test_after_the_length_update_failed_verification(self):
        """Both writes landed, and the bytes on disk are not what was meant."""
        real = lb._pwrite

        def corrupt(f, offset, data):
            if offset == lb.CORE.HEADER_BEGIN_BYTE_OFFSET:
                data = b"\xff" * len(data)
            real(f, offset, data)

        with mock.patch.object(lb, "_pwrite", corrupt), self.assertRaises(SystemExit) as caught:
            _patch(self.model)
        self.assertIn("failed verification", str(caught.exception))
        self.assertTrue(os.path.isfile(self.backup))
        _restore(self.model, force=True)
        self.assertEqual(_first_block(self.model), self.block)

    def test_a_second_patch_after_a_crash_cannot_replace_the_backup(self):
        self._interrupted(2)
        with open(self.backup, "rb") as f:
            saved = f.read()
        with self.assertRaises(SystemExit):
            _patch(self.model)
        with open(self.backup, "rb") as f:
            self.assertEqual(f.read(), saved)
        self.assertEqual(saved, self.block)

    def test_interrupted_exact_restore_can_itself_be_recovered(self):
        _patch(self.model)
        patched = _first_block(self.model)
        with _crash_at_write(1), self.assertRaises(_Crash):
            _restore(self.model, original=True)
        self.assertEqual(_first_block(self.model), patched)
        with open(self.backup, "rb") as f:
            self.assertEqual(f.read(), patched)
        self.assertTrue(os.path.isfile(self.original))
        _restore(self.model)
        self.assertEqual(_first_block(self.model), patched)

    def test_exact_restore_works_when_the_header_no_longer_parses(self):
        _patch(self.model)
        with open(self.model, "r+b") as f:
            f.seek(lb.CORE.HEADER_END_LOCATION_BYTE_OFFSET)
            f.write(struct.pack("<Q", 3))
        _restore(self.model, original=True)
        self.assertEqual(_first_block(self.model), self.block)

    def test_failed_original_save_writes_nothing_and_releases_the_lock(self):
        with mock.patch.object(lb, "_save_original", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                _patch(self.model)
        self.assertEqual(_first_block(self.model), self.block)
        self.assertFalse(os.path.lexists(self.backup))


class MismatchedCopy(Case):
    def test_backup_from_another_file_is_refused(self):
        other = os.path.join(self.dir, "other.litertlm")
        block = _container(other, begin=16384, end=16384 + 512)
        with open(self.backup, "wb") as f:
            f.write(block)
        with self.assertRaises(SystemExit) as caught:
            _restore(self.model)
        self.assertIn("section layout differs", str(caught.exception))
        self.assertEqual(_first_block(self.model), self.block)

    def test_force_overrides_the_layout_check_but_not_the_size_check(self):
        other = os.path.join(self.dir, "other.litertlm")
        with open(self.backup, "wb") as f:
            f.write(_container(other, end=16384 + 512))
        _restore(self.model, force=True)

        with open(self.backup, "wb") as f:
            f.write(_container(other, end=1 << 40))
        with self.assertRaises(SystemExit) as caught:
            _restore(self.model, force=True)
        self.assertIn("past the end", str(caught.exception))

    def test_truncated_and_oversized_backups_are_refused(self):
        for size in (100, lb.CORE.BLOCK_SIZE + 1):
            with open(self.backup, "wb") as f:
                f.write(self.block[:8].ljust(size, b"\0"))
            with self.assertRaises(SystemExit):
                _restore(self.model)

    def test_stale_original_from_a_reimport_is_refused(self):
        with open(self.original, "wb") as f:
            f.write(self.block)
        _container(self.model, end=16384 + 512)
        with self.assertRaises(SystemExit):
            _restore(self.model, original=True)


class Concurrency(Case):
    def test_only_one_of_two_writers_gets_authority(self):
        """Hold both at the point of no return, so neither can finish first."""
        barrier = threading.Barrier(2, timeout=10)
        real = lb._copy_first_block
        results = []

        def racing(model):
            barrier.wait()
            return real(model)

        def run():
            try:
                _patch(self.model)
                results.append("wrote")
            except SystemExit as e:
                results.append(str(e))

        with mock.patch.object(lb, "_copy_first_block", racing):
            threads = [threading.Thread(target=run) for _ in range(2)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(20)
        self.assertEqual(len(results), 2)
        wrote = results.count("wrote")
        # Either one lost on the exclusive create, or it ran second and noticed that the
        # file had moved on. Both writing is the failure; both refusing is not reachable.
        self.assertEqual(wrote, 1, results)
        self.assertEqual(lb._main_constraint(lb.read_header(self.model)[1]), ["gpu"])

    def test_a_patch_that_lands_before_authority_is_detected(self):
        real = lb._validate

        def stale_view(*args):
            out = real(*args)
            _container(self.model, constraint="cpu")
            return out

        with mock.patch.object(lb, "_validate", stale_view):
            with self.assertRaises(SystemExit) as caught:
                _patch(self.model)
        self.assertIn("changed while it was being checked", str(caught.exception))
        self.assertFalse(os.path.lexists(self.backup))


class MalformedContainers(Case):
    def _set_end(self, value):
        with open(self.model, "r+b") as f:
            f.seek(lb.CORE.HEADER_END_LOCATION_BYTE_OFFSET)
            f.write(struct.pack("<Q", value))

    def test_show_applies_the_bound_before_upstream_parses(self):
        self._set_end(lb.CORE.BLOCK_SIZE * 1024)
        with self.assertRaises(SystemExit) as caught:
            lb.cmd_show(SimpleNamespace(model=self.model))
        self.assertIn("outside", str(caught.exception))

    def test_resolve_reports_a_row_rather_than_a_traceback(self):
        models = os.path.join(self.dir, "models")
        os.makedirs(os.path.join(models, "bad"))
        self._set_end(0)
        shutil.copy(self.model, os.path.join(models, "bad", "model.litertlm"))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            lb.cmd_resolve(SimpleNamespace(models_dir=models))
        self.assertIn("ERROR", out.getvalue())

    def test_flipped_header_bytes_never_escape_as_a_traceback(self):
        """A small deterministic mutation pass: a bad byte must end in a refusal or a
        clean run, and the file must be unchanged unless a patch reported success."""
        head_len = len(_header())
        for offset in range(lb.CORE.HEADER_BEGIN_BYTE_OFFSET,
                            lb.CORE.HEADER_BEGIN_BYTE_OFFSET + head_len, 7):
            with self.subTest(offset=offset):
                mutated = bytearray(self.block)
                mutated[offset] ^= 0xFF
                with open(self.model, "r+b") as f:
                    f.write(bytes(mutated))
                try:
                    with contextlib.redirect_stdout(io.StringIO()):
                        lb.cmd_check(SimpleNamespace(model=self.model, backend="gpu"))
                except SystemExit:
                    pass
                self.assertEqual(_first_block(self.model), bytes(mutated))


class Checksum(Case):
    def _run(self, *args, env=None):
        tool = os.path.join(_TOOLS, "payload_checksum.py")
        return subprocess.run([sys.executable, tool, *args], capture_output=True, text=True,
                              env=env, check=False)

    def test_no_runtime_is_a_refusal_not_a_guessed_constant(self):
        sys.modules.pop("payload_checksum", None)
        pc = importlib.import_module("payload_checksum")
        with mock.patch.object(pc, "_runtime_block_size", return_value=None):
            with self.assertRaises(SystemExit) as caught:
                pc.resolve_block_size(None)
        self.assertIn("refusing to guess", str(caught.exception))

    def test_explicit_size_is_used_and_printed(self):
        r = self._run("--block-size", str(lb.CORE.BLOCK_SIZE), self.model)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(self.payload, r.stdout)
        self.assertIn(f"first {lb.CORE.BLOCK_SIZE} excluded", r.stdout)

    def test_digest_is_unchanged_by_a_patch(self):
        before = self._run(self.model)
        _patch(self.model)
        after = self._run(self.model)
        self.assertEqual(before.returncode, 0, before.stderr)
        self.assertEqual(before.stdout, after.stdout)


class ImportPaths(unittest.TestCase):
    def test_relative_override_is_refused(self):
        import litert_lm_paths as paths  # noqa: PLC0415
        with mock.patch.dict(os.environ, {"LITERT_LM_SITE_PACKAGES": "relative/dir"}):
            with self.assertRaises(SystemExit):
                paths.explicit_site_packages()

    @unittest.skipUnless(os.name == "posix", "mode bits are a POSIX question")
    def test_world_writable_candidate_is_skipped(self):
        import litert_lm_paths as paths  # noqa: PLC0415
        with tempfile.TemporaryDirectory() as d:
            os.chmod(d, stat.S_IRWXU)
            self.assertTrue(paths._safe_to_import_from(d))
            os.chmod(d, stat.S_IRWXU | stat.S_IWOTH)
            self.assertFalse(paths._safe_to_import_from(d))


if __name__ == "__main__":
    unittest.main()
