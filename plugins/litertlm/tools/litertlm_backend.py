#!/usr/bin/env python3
"""Inspect and repair the backend declaration inside a .litertlm model file.

WHY THIS EXISTS
---------------
`litert-lm serve` has no `--backend` flag (as of v0.14.0). It resolves the backend
from the model file's own metadata, via `litert_lm_cli.model.model_default_backend()`:
it looks for a `backend_constraint` key on the main section and, when the key is
absent, falls back to a hardcoded "cpu".

Several published models simply omit that key. `gemma-4-E4B-it.litertlm` is one, so
it serves on CPU even on a machine with a perfectly capable GPU — roughly a 4-5x
slowdown, silently. `gemma-4-12B-it.litertlm` declares `backend_constraint = gpu`
and does not have the problem.

The fix is to write the missing declaration into the model's own header.

WHY IT IS CHEAP
---------------
A .litertlm file is: 8-byte magic, version triple, a u64 at offset 24 holding
header_end, a flatbuffer header starting at offset 32, then section payloads
aligned to BLOCK_SIZE (16384). A typical header uses under 2 KB of that first
16 KB block, so adding one key rewrites only the header — multi-GB payloads never
move and every section offset stays valid.

`patch` refuses to write unless a no-op unpack/repack round-trip reproduces the
original content exactly, and unless the new header still fits below the block
boundary.

USAGE
-----
    litertlm_backend.py resolve [MODEL_DIR]        # what backend each model resolves to
    litertlm_backend.py show    <model.litertlm>   # dump section metadata
    litertlm_backend.py check   <model.litertlm>   # dry-run the patch, writes nothing
    litertlm_backend.py patch   <model.litertlm> [--backend gpu] [--yes]
    litertlm_backend.py restore <model.litertlm>   # undo an INTERRUPTED patch
    litertlm_backend.py restore <model.litertlm> --original   # the bytes as first seen
    litertlm_backend.py discard-backup <model.litertlm>       # the model is fine; drop it

REVERSING
---------
A patch that COMPLETED reverses two ways, and they are not the same thing:

    litertlm_backend.py patch <model.litertlm> --backend cpu --yes    # behaviour
    litertlm_backend.py restore <model.litertlm> --original --yes     # the exact bytes

Re-patching changes what the model resolves to, but a model that never carried the
key keeps one afterwards. `restore --original` puts back the first block byte for byte,
from `<model>.litertlm.hdrorig`, which the first patch writes and no later one touches.

A patch that was INTERRUPTED is a different problem: the header bytes and the length
that describes them live at different offsets, so a crash between the two writes leaves
them disagreeing and the file stops parsing — `patch` cannot reverse what it never
finished writing. So `patch` first copies the 16 KB header block to
`<model>.litertlm.hdrbak`, and removes it only after a fresh read of the file proves the
new header is what was intended. If that file is still there, the previous run died or
failed verification, and `patch` refuses to run again until you decide:

    litertlm_backend.py restore <model.litertlm>          # go back
    litertlm_backend.py discard-backup <model.litertlm>   # keep what is there

Refusing is the point. The backup is the only way back from a partial write, so a second
attempt must never replace it — and because it is created exclusively, the same file is
what stops two patches running at once.

Any command that hits an unreadable header says this, and says which case applies.
Re-importing the model is the external fallback. Operating on a copy remains
possible but is not required, because the write is bounded, backed up and validated:

    cp -r ~/.litert-lm/models/gemma4-e4b ~/.litert-lm/models/gemma4-e4b-gpu

CONSENT
-------
`patch` writes only after explicit consent. On a terminal it prompts; run
non-interactively it refuses unless `--yes` is passed, which asserts that the
caller already obtained consent in the same invocation.
"""

from __future__ import annotations

import argparse
import glob
import io
import os
import stat
import struct
import sys
import tempfile

from litert_lm_paths import candidate_site_packages, explicit_site_packages

# Main-section model types, verbatim from litert_lm_builder.TfLiteModelType. An
# earlier version wrote "artisan_text_decoder" without the "tf_lite_" prefix, which
# matches nothing: the real value is below. That typo made every artisan model look
# like it had no main section at all.
PREFILL_DECODE = "tf_lite_prefill_decode"
ARTISAN_TEXT_DECODER = "tf_lite_artisan_text_decoder"
MAIN_TYPES = (PREFILL_DECODE, ARTISAN_TEXT_DECODER)

# Artisan models are NOT patchable, and do not need to be.
#
# litert_lm_cli.model.model_default_backend() short-circuits on this type:
#
#     if model_type_lower == TfLiteModelType.ARTISAN_TEXT_DECODER.value:
#         return "gpu"
#
# It returns before reading backend_constraint, so the key is never consulted for
# these models — writing one changes nothing. They also cannot fall into the CPU
# trap this tool exists for, because that branch always yields "gpu". A model of
# this type carrying `backend_constraint = gpu_artisan` is therefore inert metadata,
# not a setting: leave it alone.
KEY = "backend_constraint"


def load_litertlm_modules():
    """Import the CLI's bundled model/peek/core modules from wherever they live."""
    override = explicit_site_packages()
    if override:
        # An explicit override that does not work is a mistake worth surfacing.
        # Silently falling back to auto-discovery would hide it and produce results
        # from a different installation than the one the user named.
        if not os.path.isdir(os.path.join(override, "litert_lm_cli")):
            raise SystemExit(
                f"LITERT_LM_SITE_PACKAGES is set to:\n  {override}\n"
                "but no 'litert_lm_cli' package exists there.\n"
                "  Fix the path, or unset the variable to fall back to auto-discovery."
            )
        sys.path.insert(0, override)
    try:
        from litert_lm_cli import model as m  # noqa: PLC0415
    except ImportError:
        for cand in candidate_site_packages():
            sys.path.insert(0, cand)
            try:
                from litert_lm_cli import model as m  # noqa: PLC0415
                break
            except ImportError:
                sys.path.pop(0)
        else:
            raise SystemExit(
                "Could not import litert_lm_cli. Install the CLI (`uv tool install "
                "litert-lm`), or set LITERT_LM_SITE_PACKAGES to its site-packages dir."
            )

    from litert_lm_builder import litertlm_core as core  # noqa: PLC0415
    from litert_lm_builder import litertlm_peek as peek  # noqa: PLC0415

    schema = core.schema
    # Upstream codegen bug: generated _UnPack calls `VDataCreator`, but the module
    # only defines `VdataCreator`. Without this alias the flatbuffers object API —
    # and therefore any header rewrite — is unusable.
    if not hasattr(schema, "VDataCreator"):
        schema.VDataCreator = schema.VdataCreator

    return m, core, peek, schema


M, CORE, PEEK, SCHEMA = load_litertlm_modules()
import flatbuffers  # noqa: E402  (path is only valid after load_litertlm_modules)


def read_header(path):
    with open(path, "rb") as f:
        if f.read(8) != CORE.HEADER_MAGIC_BYTES:
            raise SystemExit(f"{path}: not a .litertlm file (bad magic)")
        f.seek(CORE.HEADER_END_LOCATION_BYTE_OFFSET)
        header_end = struct.unpack("<Q", f.read(8))[0]
        # header_end comes straight from the file, so a corrupt or hostile container
        # can set it to anything. It must be bounded before the read below, on both
        # sides, and the upper bound is BLOCK_SIZE — NOT file_size:
        #   * header_end < HEADER_BEGIN            -> f.read(negative) reads the whole
        #     file into memory.
        #   * header_end large, <= file_size       -> a crafted/sparse multi-GB file
        #     with header_end == file_size still slurps gigabytes (file_size alone is
        #     not a real bound on a sparse file).
        #   * header_end > BLOCK_SIZE              -> the patch scrub would later zero
        #     payload past the single-block backup (unrecoverable corruption).
        # The format keeps the header inside the first block, so a valid header_end is
        # always <= BLOCK_SIZE; capping here makes the read at most one block and
        # closes all three at once.
        file_size = os.fstat(f.fileno()).st_size
        limit = min(file_size, CORE.BLOCK_SIZE)
        if not (CORE.HEADER_BEGIN_BYTE_OFFSET <= header_end <= limit):
            raise SystemExit(
                f"{path}: header_end={header_end} is outside "
                f"[{CORE.HEADER_BEGIN_BYTE_OFFSET}, {limit}]; "
                "refusing to read a corrupt or oversized header."
            )
        f.seek(CORE.HEADER_BEGIN_BYTE_OFFSET)
        data = f.read(header_end - CORE.HEADER_BEGIN_BYTE_OFFSET)
    return header_end, data


def summarize(buf):
    """Reduce a header flatbuffer to a comparable plain-Python structure.

    This is the comparison the round-trip guard rests on, so it must cover
    EVERYTHING the header carries. An earlier version compared only the section
    table; SystemMetadata (author, uuid, creation_timestamp) was outside the
    comparison, which meant a schema change that silently dropped it would still
    have reported "content identical: True" and the tool would have written.
    """
    meta = SCHEMA.LiteRTLMMetaData.GetRootAs(buf, 0)

    sections = []
    sm = meta.SectionMetadata()
    if sm:
        for i in range(sm.ObjectsLength()):
            sec = sm.Objects(i)
            items = []
            for j in range(sec.ItemsLength()):
                it = sec.Items(j)
                if it is None:
                    continue
                d = PEEK.kvp_to_dict(it)
                items.append((d.get("key"), d.get("value"), d.get("value_type")))
            sections.append(
                (sec.BeginOffset(), sec.EndOffset(), sec.DataType(), tuple(items)))

    system = []
    sysmd = meta.SystemMetadata()
    if sysmd:
        for i in range(sysmd.EntriesLength()):
            e = sysmd.Entries(i)
            if e is None:
                continue
            d = PEEK.kvp_to_dict(e)
            system.append((d.get("key"), d.get("value"), d.get("value_type")))

    return (tuple(sections), tuple(system))


def _layout(buf):
    """The part of a header that a patch must never change, and a copy must match.

    `summarize` minus the section key/value items: where each section sits, what type it
    is, and the system metadata. A header block is only meaningful against the payload
    it was written for, so this is what identifies a saved block as belonging to a file.
    """
    sections, system = summarize(buf)
    return (tuple(s[:3] for s in sections), system)


def _main_constraint(buf):
    """backend_constraint of each patchable main section, as written (None if absent)."""
    meta = SCHEMA.LiteRTLMMetaData.GetRootAs(buf, 0)
    out = []
    sm = meta.SectionMetadata()
    for i in range(sm.ObjectsLength() if sm else 0):
        items = {}
        sec = sm.Objects(i)
        for j in range(sec.ItemsLength()):
            it = sec.Items(j)
            if it is not None:
                d = PEEK.kvp_to_dict(it)
                items[d.get("key")] = d.get("value")
        if items.get("model_type") == PREFILL_DECODE:
            out.append(items.get(KEY))
    return out


def _unreadable(path, exc):
    """Turn a header parse failure into an answer instead of a traceback.

    This is what an interrupted patch looks like from the outside: the declared
    header length and the header bytes disagree, so the flatbuffer reads truncated
    and any command touching it explodes. That is precisely the moment to point at
    the backup, not to print a stack.
    """
    backup = _backup_path(path)
    hint = (f"  A backup from an interrupted patch is present. Restore it:\n"
            f"    litertlm_backend.py restore {path}\n"
            if os.path.isfile(backup)
            else "  No backup is present, so re-import the model to replace it.\n")
    # Qualify the type: the usual one is `struct.error`, whose bare __name__ is the
    # unhelpfully generic "error".
    kind = f"{type(exc).__module__}.{type(exc).__name__}".removeprefix("builtins.")
    raise SystemExit(
        f"{path}: could not read the header ({kind}: {exc}).\n"
        f"{hint}"
    )


def _text(v):
    return v.decode() if isinstance(v, bytes) else v


# Outcomes for one main section, as data rather than prose.
#
# Callers branch on these. An earlier version branched on substrings of the
# human-readable message instead ("SKIPPED" in c, "nothing to do" in c), which made
# behaviour depend on wording — rephrasing a sentence for clarity would silently
# change control flow. This file has already been bitten once by a string that did
# not match what it was compared against (MAIN_TYPES, above); prose is for readers.
ADDED = "added"
REPLACED = "replaced"
NOOP = "noop"          # the key is already the requested value
SKIPPED = "skipped"    # the resolver ignores the key for this section type

# Statuses that mean "no write is required", as opposed to "no write is possible".
NO_WRITE_NEEDED = (NOOP, SKIPPED)


def repack(buf, backend=None):
    """Unpack -> optionally set backend_constraint on the main section -> repack.

    Returns (bytes, changes) where each change is a (status, message) pair; status
    is one of ADDED / REPLACED / NOOP / SKIPPED.
    """
    meta = SCHEMA.LiteRTLMMetaData.GetRootAs(buf, 0)
    metaT = SCHEMA.LiteRTLMMetaDataT.InitFromObj(meta)
    changed = []

    if backend is not None:
        for sec in metaT.sectionMetadata.objects:
            model_type = None
            for it in sec.items or []:
                if _text(it.key) == "model_type":
                    model_type = _text(it.value.value)
            if model_type not in MAIN_TYPES:
                continue

            if model_type == ARTISAN_TEXT_DECODER:
                # The resolver hardcodes "gpu" for this type before it ever looks at
                # backend_constraint, so a write here would be a no-op that merely
                # looked like a fix. Say so instead of doing it.
                changed.append((SKIPPED,
                                f"{model_type}: skipped — the resolver returns 'gpu' for "
                                "artisan models without reading backend_constraint, so "
                                "there is nothing here to repair"))
                continue

            existing = next((it for it in sec.items if _text(it.key) == KEY), None)
            if existing is not None:
                if _text(existing.value.value) == backend:
                    changed.append((NOOP, f"{model_type}: already {backend}, nothing to do"))
                    continue
                existing.value.value = backend
                changed.append((REPLACED, f"{model_type}: replaced -> {backend}"))
            else:
                sv = SCHEMA.StringValueT()
                sv.value = backend
                kv = SCHEMA.KeyValuePairT()
                kv.key = KEY
                kv.valueType = SCHEMA.VData.StringValue
                kv.value = sv
                sec.items.append(kv)
                changed.append((ADDED, f"{model_type}: added -> {backend}"))

    builder = flatbuffers.Builder(0)
    builder.Finish(metaT.Pack(builder))
    return bytes(builder.Output()), changed


def cmd_resolve(args):
    root = args.models_dir or os.path.join(os.path.expanduser("~"), ".litert-lm", "models")
    if not os.path.isdir(root):
        raise SystemExit(f"No such directory: {root}")
    for model_id in sorted(os.listdir(root)):
        path = os.path.join(root, model_id, "model.litertlm")
        if not os.path.exists(path):
            continue
        try:
            # Bounds first. The resolver parses the header with upstream's reader, which
            # is not ours to vouch for against a hostile `header_end`.
            read_header(path)
            backend = M.model_default_backend(path)
        except SystemExit as e:
            backend = f"ERROR: {e}"
        except Exception as e:  # noqa: BLE001
            backend = f"ERROR: {type(e).__name__}: {e}"
        flag = "  <-- serves on CPU" if backend == "cpu" else ""
        print(f"{model_id:<24} {backend}{flag}")


def cmd_show(args):
    # Everything that walks the flatbuffer stays inside the guard. A truncated
    # header does not fail at the read — it fails later, on the first offset that
    # points past the buffer, which is inside these loops.
    lines = []
    read_header(args.model)  # the same bound `patch` gets, before upstream's reader runs
    try:
        with io.StringIO() as devnull:
            metadata = PEEK.read_litertlm_header(args.model, devnull)
        sm = metadata.SectionMetadata()
        lines.append(f"{args.model}\nsections: {sm.ObjectsLength()}")
        for i in range(sm.ObjectsLength()):
            sec = sm.Objects(i)
            lines.append(f"\n--- section[{i}] model_type={PEEK.get_model_type(sec)!r} "
                         f"items={sec.ItemsLength()}")
            for j in range(sec.ItemsLength()):
                it = sec.Items(j)
                if it is None:
                    continue
                d = PEEK.kvp_to_dict(it)
                val = str(d.get("value"))
                if len(val) > 90:
                    val = val[:90] + f"...<{len(str(d.get('value')))} chars>"
                lines.append(f"      {d.get('key')} = {val}")
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        _unreadable(args.model, e)
    print("\n".join(lines))


def _validate(path, backend):
    header_end, orig = read_header(path)
    limit = CORE.BLOCK_SIZE - CORE.HEADER_BEGIN_BYTE_OFFSET

    try:
        identical, _ = repack(orig, None)
        lossless = summarize(orig) == summarize(identical)
        new, changed = repack(orig, backend)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        _unreadable(path, e)
    print(f"round-trip (no change): {len(orig)} -> {len(identical)} bytes, "
          f"content identical: {lossless}")
    if not lossless:
        raise SystemExit("ABORT: round-trip is lossy; refusing to touch this file.")

    fits = len(new) <= limit
    print(f"with {KEY}={backend}: {len(new)} bytes (limit {limit}) -> "
          f"{'FITS' if fits else 'TOO BIG'}")
    for _status, message in changed:
        print(f"  {message}")
    return header_end, orig, new, changed, fits


def cmd_check(args):
    _refuse_pending_backup(args.model)
    _, _, _, changed, fits = _validate(args.model, args.backend)

    # A dry run that matched no section used to print "FITS" and exit 0, which reads
    # as "ready to patch" — then the real patch aborts with "no main section found".
    # A check that cannot fail is not a check. Exit non-zero and say which case it is.
    if not changed:
        raise SystemExit(
            "\nNo section in this file can carry a backend_constraint that the resolver "
            "would read.\n"
            "  `patch` would refuse. This is a report, not a failure of the file:\n"
            "  either it is not a main-model container, or its main section is a type\n"
            "  whose backend is decided some other way.")
    if all(status == SKIPPED for status, _ in changed):
        # Not a failure. The model is correctly configured and needs no repair;
        # exiting non-zero here would report a healthy file as a problem.
        print("\nNothing to repair — this model does not use backend_constraint.")
        return
    if not fits:
        raise SystemExit("\nThe patched header would overrun the first block; "
                         "`patch` would refuse.")


def _backup_path(model):
    return model + ".hdrbak"


def _original_path(model):
    return model + ".hdrorig"


def _is_regular(path):
    """A regular file at this exact name. Never follows a link to answer."""
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


# O_NOFOLLOW does not exist on Windows; O_BINARY exists nowhere else. Without O_BINARY a
# Windows descriptor translates line endings, which would corrupt a header silently.
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_BINARY = getattr(os, "O_BINARY", 0)


def _fsync_dir(path):
    """Make a create or remove in this directory durable, where the OS can be asked."""
    if os.name != "posix":
        return
    try:
        fd = os.open(os.path.dirname(os.path.abspath(path)), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _create_exclusive(path, data):
    """Create `path` holding `data`, or fail if ANYTHING already has that name.

    O_CREAT|O_EXCL is the whole defence, on both platforms: it refuses an existing file,
    a directory, and a symbolic link, dangling or not, without following it. Checking
    first and opening after would leave a gap to plant a link in; this has no gap.
    """
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _BINARY, 0o600)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
    except BaseException:
        # Ours, and incomplete: a torn copy must not pass for a recovery point.
        try:
            os.remove(path)
        except OSError:
            pass
        raise
    _fsync_dir(path)


def _require_regular_model(model):
    """Writes go to the file the caller named, not wherever a link there points."""
    if not _is_regular(model):
        raise SystemExit(
            f"ABORT: {model} is not a regular file (a link, or missing).\n"
            "  Refusing to write through it, because the recovery files would then sit\n"
            "  beside the link rather than the file. Name the real path.")


def _refuse_pending_backup(model):
    """Stop while a recovery copy exists, whatever is actually at that name."""
    path = _backup_path(model)
    if not os.path.lexists(path):
        return
    if _is_regular(path):
        raise SystemExit(
            f"ABORT: a header backup is already present:\n  {path}\n"
            "  An earlier patch did not finish, or one is running now. Nothing was written,\n"
            "  and that file was left exactly as it is: it may be the only way back.\n"
            f"    Go back:          litertlm_backend.py restore {model}\n"
            f"    Keep the current: litertlm_backend.py discard-backup {model}")
    raise SystemExit(
        f"ABORT: something other than a regular file is at the backup path:\n  {path}\n"
        "  This tool never creates that. Nothing was written. Inspect it and remove it\n"
        "  yourself; if it is a link, removing the link does not touch what it points at.")


def _copy_first_block(model):
    """Save the first block aside, exclusively. Returns (backup path, the block).

    The rewrite is not atomic and cannot be made so in place: the header bytes live at
    offset 32 and the length that describes them lives at offset 24, so a crash between
    those two writes leaves them disagreeing and the flatbuffer parses truncated. No
    ordering of the two fixes that — only a copy does. The block is 16 KB; the file it
    protects is several GB, and re-downloading one is the alternative. This machine has
    already taken one unplanned BSOD.

    Exclusive creation also makes this the lock: of two concurrent writers, one gets
    the file. Needs no parseable header, because a restore may be fixing one.
    """
    with open(model, "rb") as f:
        block = f.read(CORE.BLOCK_SIZE)
    if len(block) != CORE.BLOCK_SIZE:
        raise SystemExit(f"ABORT: {model} is smaller than one {CORE.BLOCK_SIZE}-byte block.")
    path = _backup_path(model)
    try:
        _create_exclusive(path, block)
    except FileExistsError:
        _refuse_pending_backup(model)
        raise SystemExit(f"ABORT: {path} appeared and vanished; retry.") from None
    except OSError as e:
        raise SystemExit(
            f"ABORT: could not create the header backup, so nothing was written:\n"
            f"  {path}\n  {e}") from None
    return path, block


def _take_write_authority(model, header_end, orig):
    """`_copy_first_block`, then confirm the file is still the one that was validated.

    Everything `patch` computed came from a read taken BEFORE it held authority, and a
    patch that finished in that gap has already moved the file on from what `orig`
    describes. Writing anyway would replace that patch's result with a stale one.
    """
    path, block = _copy_first_block(model)
    if _block_header(block) != (header_end, orig):
        os.remove(path)
        raise SystemExit(
            f"ABORT: {model} changed while it was being checked; another patch ran.\n"
            "  Nothing was written. Run the command again to see the current state.")
    return path, block


def _save_original(model, block):
    """Keep the first block as first seen, once, for `restore --original`.

    Written beside the file under a temporary name and moved into place, so a crash
    cannot leave a torn original that a later patch would then decline to replace.
    Called with write authority held, which is what makes the existence test safe.
    """
    path = _original_path(model)
    if os.path.lexists(path):
        if not _is_regular(path):
            raise SystemExit(
                f"ABORT: something other than a regular file is at:\n  {path}\n"
                "  This tool never creates that. Inspect it and remove it yourself.")
        return
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)),
                               prefix=os.path.basename(path) + ".")
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(block)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    _fsync_dir(path)


def _block_header(block):
    """(header_end, header bytes) of a first block, under the same bound as read_header."""
    header_end = struct.unpack_from("<Q", block, CORE.HEADER_END_LOCATION_BYTE_OFFSET)[0]
    if not CORE.HEADER_BEGIN_BYTE_OFFSET <= header_end <= CORE.BLOCK_SIZE:
        raise ValueError(f"header_end={header_end} is out of bounds")
    return header_end, block[CORE.HEADER_BEGIN_BYTE_OFFSET:header_end]


def _read_saved_block(path):
    """A saved first block, read without following a link and without trusting its size."""
    if not _is_regular(path):
        raise SystemExit(f"ABORT: {path} is not a regular file; refusing to read it.")
    fd = os.open(path, os.O_RDONLY | _NOFOLLOW | _BINARY)
    with os.fdopen(fd, "rb") as b:
        block = b.read(CORE.BLOCK_SIZE + 1)
    if len(block) != CORE.BLOCK_SIZE or block[:8] != CORE.HEADER_MAGIC_BYTES:
        raise SystemExit(f"ABORT: {path} is not a valid header block; refusing to write it.")
    return block


def _check_block_belongs(model, block, path, force):
    """Refuse a saved block that does not describe this file's payload.

    A header is only right for the payload it was written for: its offsets are what the
    runtime follows. Restoring one from a re-imported or different model parses cleanly
    and then reads weights from the wrong place.
    """
    try:
        saved = _layout(_block_header(block)[1])
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"ABORT: {path} does not parse as a header ({e}); "
                         "refusing to write it.") from None

    size = os.path.getsize(model)
    if any(end > size for _, end, _ in saved[0]):
        raise SystemExit(f"ABORT: {path} describes sections past the end of {model}; "
                         "it belongs to a different file.")
    if force:
        return

    # An unreadable header is the expected state after an interrupted patch, so it is
    # not evidence either way. Only a header that parses can contradict the copy.
    try:
        current = _layout(read_header(model)[1])
    except (SystemExit, Exception):  # noqa: BLE001
        return
    if current != saved:
        raise SystemExit(
            f"ABORT: {path}\n  does not match {model}: the section layout differs, so\n"
            "  it was saved from a different file. Nothing was written. If you are sure\n"
            "  it is right, re-run with --force.")


def _pwrite(f, offset, data):
    """One positioned write. The seam the interruption tests cut at."""
    f.seek(offset)
    f.write(data)
    f.flush()


def _write_block(model, block):
    with open(model, "r+b") as f:
        _pwrite(f, 0, block)
        os.fsync(f.fileno())
    with open(model, "rb") as f:
        if f.read(CORE.BLOCK_SIZE) != block:
            raise OSError("the first block does not read back as written")


def cmd_restore(args):
    """Put back a saved first block: an interrupted patch's, or the original."""
    _require_regular_model(args.model)
    backup = _backup_path(args.model)
    original = _original_path(args.model)
    path = original if args.original else backup

    if args.original:
        # Finishing that first is not bureaucracy: this restore needs the same path for
        # its own recovery copy, and must not take it from an unresolved one.
        _refuse_pending_backup(args.model)
    if not os.path.lexists(path):
        raise SystemExit(
            f"No original header is saved at:\n  {path}\n"
            "  The first patch writes it. A model patched before this tool kept one has\n"
            "  none; `patch --backend <previous>` still reverses the behaviour."
            if args.original else
            f"No backup found at:\n  {path}\n"
            "  A backup exists only while a patch is unresolved. If the model is broken\n"
            "  and there is no backup, re-import it.")

    block = _read_saved_block(path)
    _check_block_belongs(args.model, block, path, args.force)

    if not _consent(
        f"\nAbout to restore the header block of:\n  {args.model}\nfrom {path}",
        args.yes,
    ):
        raise SystemExit("Declined; nothing was written.")

    try:
        if args.original:
            _copy_first_block(args.model)   # this write can be interrupted too
        _write_block(args.model, block)
    except OSError as e:
        raise SystemExit(f"ABORT: the restore did not complete ({e}).\n  "
                         f"{backup} was kept; retry once the cause is fixed.") from None

    os.remove(backup)
    # The original has done its job once the file is the original again, whichever route
    # got it there. Leaving it would make the NEXT patch's "first seen" a lie.
    if _is_regular(original) and _read_saved_block(original) == block:
        os.remove(original)
    _fsync_dir(path)
    print(f"header restored from {os.path.basename(path)}")
    print("verify:  litertlm_backend.py resolve")


def cmd_discard_backup(args):
    """Resolve a pending backup by keeping the model as it stands."""
    path = _backup_path(args.model)
    if not os.path.lexists(path):
        raise SystemExit(f"No backup found at:\n  {path}")
    if stat.S_ISDIR(os.lstat(path).st_mode):
        raise SystemExit(f"ABORT: {path} is a directory; inspect it and remove it yourself.")
    try:
        summarize(read_header(args.model)[1])
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        _unreadable(args.model, e)

    if not _consent(
        f"\nThe model header parses. About to delete the recovery copy:\n  {path}\n"
        "After this the file cannot be put back to how it was before that patch.",
        args.yes,
    ):
        raise SystemExit("Declined; nothing was removed.")
    os.remove(path)        # on a link this removes the link, never its target
    _fsync_dir(path)
    print(f"{os.path.basename(path)} removed; the model was left as it is")


def _consent(preamble, assumed):
    """Shared consent gate (FR-019). Returns True only on an explicit yes."""
    if assumed:
        return True
    if not sys.stdin.isatty():
        raise SystemExit(
            "ABORT: refusing to modify a model file without consent.\n"
            "  Re-run with --yes once the user has agreed to this specific change,\n"
            "  or run `check` instead to see what would happen without writing."
        )
    print(preamble)
    try:
        answer = input("Proceed? [y/N] ")
    except (EOFError, KeyboardInterrupt):
        # isatty() can report a terminal that cannot actually be read from — a
        # piped or redirected stdin under some shells. Treat it as a decline
        # rather than letting a traceback reach the user.
        print()
        return False
    return answer.strip().lower() in ("y", "yes")


def _verify_written(model, new, orig, backend):
    """Prove the rewrite from a fresh read, not from the writes having returned.

    A successful fsync says the bytes reached the disk; it does not say they are the
    header that was meant. Returns a list of what is wrong, empty when nothing is.
    """
    try:
        new_end, seen = read_header(model)
        problems = []
        if seen != new:
            problems.append("the header bytes differ from what was written")
        if new_end != CORE.HEADER_BEGIN_BYTE_OFFSET + len(new):
            problems.append("the recorded header length is wrong")
        if _layout(seen) != _layout(orig):
            problems.append("section offsets or system metadata changed")
        declared = _main_constraint(seen)
        if any(v != backend for v in declared):
            problems.append(f"{KEY} reads {declared}, expected {backend}")
        return problems
    except SystemExit as e:
        return [str(e)]
    except Exception as e:  # noqa: BLE001
        return [f"the new header does not parse: {type(e).__name__}: {e}"]


def cmd_patch(args):
    _require_regular_model(args.model)
    _refuse_pending_backup(args.model)

    header_end, orig, new, changed, fits = _validate(args.model, args.backend)
    if not changed:
        raise SystemExit("ABORT: no main section found to patch.")
    if not fits:
        raise SystemExit("ABORT: patched header would overrun the first block.")
    if header_end > CORE.BLOCK_SIZE:
        # Backstop: read_header() already rejects header_end > BLOCK_SIZE, so this is
        # unreachable today. Kept so the WRITE path stays safe on its own if that
        # read-side bound is ever loosened — _write_header_backup saves only the first
        # block, but the scrub below zeroes bytes up to header_end, so a header past
        # one block would corrupt payload the single-block backup cannot restore.
        raise SystemExit(
            f"ABORT: header_end={header_end} exceeds one {CORE.BLOCK_SIZE}-byte block; "
            "patching could zero payload beyond the single-block backup. Refusing."
        )
    if all(status in NO_WRITE_NEEDED for status, _ in changed):
        # Either already correct, or a type whose constraint the resolver ignores.
        # Both mean the same thing to the caller: do not write.
        if any(status == SKIPPED for status, _ in changed):
            print("Nothing to write — see above.")
        else:
            print("Already correct; no write performed.")
        return

    # Consent gate (FR-019). Another command driving this tool must assert that it
    # already obtained consent, in the same invocation, by passing --yes. Without a
    # terminal to prompt at and without --yes, refuse rather than write silently.
    prior = "cpu" if args.backend != "cpu" else "gpu"
    if not _consent(
        f"\nAbout to rewrite the header of:\n  {args.model}\n"
        "Only the first 16 KB is written; the payload is not touched.\n"
        f"Reversible with:  litertlm_backend.py patch <model> --backend {prior} --yes\n"
        "Byte-exact with:  litertlm_backend.py restore <model> --original --yes",
        args.yes,
    ):
        raise SystemExit("Declined; nothing was written.")

    backup, block = _take_write_authority(args.model, header_end, orig)
    try:
        _save_original(args.model, block)
    except BaseException:
        # Nothing has been written yet, so this copy recovers nothing and would only
        # block the next attempt.
        os.remove(backup)
        raise

    restore_hint = f"  Restore it with:  litertlm_backend.py restore {args.model}"
    new_end = CORE.HEADER_BEGIN_BYTE_OFFSET + len(new)
    try:
        with open(args.model, "r+b") as f:
            tail = b"\x00" * max(0, header_end - new_end)     # scrub stale tail bytes
            _pwrite(f, CORE.HEADER_BEGIN_BYTE_OFFSET, new + tail)
            _pwrite(f, CORE.HEADER_END_LOCATION_BYTE_OFFSET, struct.pack("<Q", new_end))
            os.fsync(f.fileno())
    except BaseException:
        # The backup is the only way back, so say where it is before unwinding.
        print(f"\nWrite failed. The original header is saved at:\n  {backup}\n{restore_hint}",
              file=sys.stderr)
        raise

    problems = _verify_written(args.model, new, orig, args.backend)
    if problems:
        details = "\n".join(f"  - {p}" for p in problems)
        raise SystemExit(
            f"ABORT: the rewritten header failed verification:\n{details}\n"
            f"The original header is saved at:\n  {backup}\n{restore_hint}")

    os.remove(backup)
    _fsync_dir(backup)

    print(f"header rewritten: end {header_end} -> {new_end}")
    print("verify:   litertlm_backend.py resolve")
    print(f"reverse:  litertlm_backend.py patch {args.model} --backend {prior} --yes")
    print(f"exact:    litertlm_backend.py restore {args.model} --original --yes")
    print("payload:  unchanged — confirm with payload_checksum.py")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("resolve", help="report the backend each imported model resolves to")
    p.add_argument("models_dir", nargs="?", default=None)
    p.set_defaults(func=cmd_resolve)

    p = sub.add_parser("show", help="dump a model's section metadata")
    p.add_argument("model")
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("check", help="dry-run the patch, write nothing")
    p.add_argument("model")
    p.add_argument("--backend", default="gpu", choices=["cpu", "gpu", "npu"])
    p.set_defaults(func=cmd_check)

    p = sub.add_parser(
        "patch",
        help="rewrite the header in place (reversible: re-run with the previous --backend)",
    )
    p.add_argument("model")
    p.add_argument("--backend", default="gpu", choices=["cpu", "gpu", "npu"],
                   help="backend to declare. Passing the previous value reverses an earlier "
                        "patch; reversal is a first-class operation, not a side effect.")
    p.add_argument("--yes", action="store_true",
                   help="confirm the write. Required when running non-interactively; a caller "
                        "passing this asserts the user consented in the same invocation.")
    p.set_defaults(func=cmd_patch)

    p = sub.add_parser(
        "restore",
        help="put back the header block saved by an interrupted patch (<model>.hdrbak)",
    )
    p.add_argument("model")
    p.add_argument("--original", action="store_true",
                   help="restore the block as first seen (<model>.hdrorig), byte for byte")
    p.add_argument("--force", action="store_true",
                   help="write a saved block even though its section layout differs from "
                        "the model's. For a torn header that happens to parse.")
    p.add_argument("--yes", action="store_true", help="confirm the write, as for patch")
    p.set_defaults(func=cmd_restore)

    p = sub.add_parser(
        "discard-backup",
        help="keep the model as it stands and remove a pending <model>.hdrbak",
    )
    p.add_argument("model")
    p.add_argument("--yes", action="store_true", help="confirm the removal, as for patch")
    p.set_defaults(func=cmd_discard_backup)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
