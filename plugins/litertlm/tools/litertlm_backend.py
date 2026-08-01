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

REVERSING
---------
Repair is applied in place and is reversible: re-run `patch` with the previous
backend. This is a supported operation, not a trick.

    litertlm_backend.py patch <model.litertlm> --backend gpu --yes    # repair
    litertlm_backend.py patch <model.litertlm> --backend cpu --yes    # undo it

That reverses a patch that COMPLETED. A patch that was interrupted is a different
problem: the header bytes and the length that describes them live at different
offsets, so a crash between the two writes leaves them disagreeing and the file
stops parsing — `patch` cannot reverse what it never finished writing. So `patch`
first copies the 16 KB header block to `<model>.litertlm.hdrbak` and removes it only
on success. If that file is still there, the previous run died; put it back with:

    litertlm_backend.py restore <model.litertlm>

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
import struct
import sys

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


def _candidate_site_packages():
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
        out.extend(sorted(glob.glob(p)) if "*" in p else ([p] if os.path.isdir(p) else []))
    return out


def load_litertlm_modules():
    """Import the CLI's bundled model/peek/core modules from wherever they live."""
    override = os.environ.get("LITERT_LM_SITE_PACKAGES")
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
        for cand in _candidate_site_packages():
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
            backend = M.model_default_backend(path)
        except Exception as e:  # noqa: BLE001
            backend = f"ERROR: {type(e).__name__}: {e}"
        flag = "  <-- serves on CPU" if backend == "cpu" else ""
        print(f"{model_id:<24} {backend}{flag}")


def cmd_show(args):
    # Everything that walks the flatbuffer stays inside the guard. A truncated
    # header does not fail at the read — it fails later, on the first offset that
    # points past the buffer, which is inside these loops.
    lines = []
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
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        _unreadable(path, e)
    print(f"round-trip (no change): {len(orig)} -> {len(identical)} bytes, "
          f"content identical: {lossless}")
    if not lossless:
        raise SystemExit("ABORT: round-trip is lossy; refusing to touch this file.")

    new, changed = repack(orig, backend)
    fits = len(new) <= limit
    print(f"with {KEY}={backend}: {len(new)} bytes (limit {limit}) -> "
          f"{'FITS' if fits else 'TOO BIG'}")
    for _status, message in changed:
        print(f"  {message}")
    return header_end, new, changed, fits


def cmd_check(args):
    _, _, changed, fits = _validate(args.model, args.backend)

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


def _write_header_backup(model):
    """Copy the whole first block aside before touching the file.

    The rewrite is not atomic and cannot be made so in place: the header bytes live
    at offset 32 and the length that describes them lives at offset 24, so a crash
    between those two writes leaves them disagreeing and the flatbuffer parses
    truncated. No ordering of the two fixes that — only a copy does. The block is
    16 KB; the file it protects is several GB, and re-downloading one is the
    alternative. This machine has already taken one unplanned BSOD.
    """
    with open(model, "rb") as f:
        block = f.read(CORE.BLOCK_SIZE)
    if len(block) != CORE.BLOCK_SIZE:
        raise SystemExit(f"ABORT: {model} is smaller than one {CORE.BLOCK_SIZE}-byte block.")
    path = _backup_path(model)
    with open(path, "wb") as b:
        b.write(block)
        b.flush()
        os.fsync(b.fileno())
    return path


def cmd_restore(args):
    """Put back the header block saved by an interrupted `patch`."""
    path = _backup_path(args.model)
    if not os.path.isfile(path):
        raise SystemExit(
            f"No backup found at:\n  {path}\n"
            "  A backup exists only while a patch is in progress; a completed patch\n"
            "  removes it. If the model is broken and there is no backup, re-import it."
        )
    with open(path, "rb") as b:
        block = b.read()
    if len(block) != CORE.BLOCK_SIZE or block[:8] != CORE.HEADER_MAGIC_BYTES:
        raise SystemExit(f"ABORT: {path} is not a valid header block; refusing to write it.")

    if not _consent(
        f"\nAbout to restore the original header block of:\n  {args.model}\nfrom {path}",
        args.yes,
    ):
        raise SystemExit("Declined; nothing was written.")

    with open(args.model, "r+b") as f:
        f.seek(0)
        f.write(block)
        f.flush()
        os.fsync(f.fileno())
    os.remove(path)
    print(f"header restored from backup; {os.path.basename(path)} removed")
    print("verify:  litertlm_backend.py resolve")


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


def cmd_patch(args):
    stale = _backup_path(args.model)
    if os.path.isfile(stale):
        print(f"WARNING: a header backup is already present:\n  {stale}\n"
              "  That means an earlier patch did not finish. If this model no longer\n"
              "  loads, restore it first:  litertlm_backend.py restore <model>\n",
              file=sys.stderr)

    header_end, new, changed, fits = _validate(args.model, args.backend)
    if not changed:
        raise SystemExit("ABORT: no main section found to patch.")
    if not fits:
        raise SystemExit("ABORT: patched header would overrun the first block.")
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
        f"Reversible with:  litertlm_backend.py patch <model> --backend {prior} --yes",
        args.yes,
    ):
        raise SystemExit("Declined; nothing was written.")

    backup = _write_header_backup(args.model)
    try:
        with open(args.model, "r+b") as f:
            f.seek(CORE.HEADER_BEGIN_BYTE_OFFSET)
            f.write(new)
            new_end = CORE.HEADER_BEGIN_BYTE_OFFSET + len(new)
            if new_end < header_end:  # scrub stale tail bytes
                f.write(b"\x00" * (header_end - new_end))
            f.seek(CORE.HEADER_END_LOCATION_BYTE_OFFSET)
            f.write(struct.pack("<Q", new_end))
            f.flush()
            os.fsync(f.fileno())
    except BaseException:
        # The backup is the only way back, so say where it is before unwinding.
        print(f"\nWrite failed. The original header is saved at:\n  {backup}\n"
              f"  Restore it with:  litertlm_backend.py restore {args.model}",
              file=sys.stderr)
        raise
    os.remove(backup)

    reverse_to = "cpu" if args.backend != "cpu" else "gpu"
    print(f"header rewritten: end {header_end} -> {new_end}")
    print("verify:   litertlm_backend.py resolve")
    print(f"reverse:  litertlm_backend.py patch {args.model} --backend {reverse_to} --yes")
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
    p.add_argument("--yes", action="store_true", help="confirm the write, as for patch")
    p.set_defaults(func=cmd_restore)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
