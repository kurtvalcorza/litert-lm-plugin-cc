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

REVERSING
---------
Repair is applied in place and is reversible: re-run `patch` with the previous
backend. This is a supported operation, not a trick.

    litertlm_backend.py patch <model.litertlm> --backend gpu --yes    # repair
    litertlm_backend.py patch <model.litertlm> --backend cpu --yes    # undo it

Re-importing the model is the external fallback. Operating on a copy remains
possible but is not required, because the write is bounded and validated:

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

MAIN_TYPES = ("tf_lite_prefill_decode", "artisan_text_decoder")
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


def _text(v):
    return v.decode() if isinstance(v, bytes) else v


def repack(buf, backend=None):
    """Unpack -> optionally set backend_constraint on the main section -> repack."""
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

            existing = next((it for it in sec.items if _text(it.key) == KEY), None)
            if existing is not None:
                if _text(existing.value.value) == backend:
                    changed.append(f"{model_type}: already {backend}, nothing to do")
                    continue
                existing.value.value = backend
                changed.append(f"{model_type}: replaced -> {backend}")
            else:
                sv = SCHEMA.StringValueT()
                sv.value = backend
                kv = SCHEMA.KeyValuePairT()
                kv.key = KEY
                kv.valueType = SCHEMA.VData.StringValue
                kv.value = sv
                sec.items.append(kv)
                changed.append(f"{model_type}: added -> {backend}")

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
    with io.StringIO() as devnull:
        metadata = PEEK.read_litertlm_header(args.model, devnull)
    sm = metadata.SectionMetadata()
    print(f"{args.model}\nsections: {sm.ObjectsLength()}")
    for i in range(sm.ObjectsLength()):
        sec = sm.Objects(i)
        print(f"\n--- section[{i}] model_type={PEEK.get_model_type(sec)!r} "
              f"items={sec.ItemsLength()}")
        for j in range(sec.ItemsLength()):
            it = sec.Items(j)
            if it is None:
                continue
            d = PEEK.kvp_to_dict(it)
            val = str(d.get("value"))
            if len(val) > 90:
                val = val[:90] + f"...<{len(str(d.get('value')))} chars>"
            print(f"      {d.get('key')} = {val}")


def _validate(path, backend):
    header_end, orig = read_header(path)
    limit = CORE.BLOCK_SIZE - CORE.HEADER_BEGIN_BYTE_OFFSET

    identical, _ = repack(orig, None)
    lossless = summarize(orig) == summarize(identical)
    print(f"round-trip (no change): {len(orig)} -> {len(identical)} bytes, "
          f"content identical: {lossless}")
    if not lossless:
        raise SystemExit("ABORT: round-trip is lossy; refusing to touch this file.")

    new, changed = repack(orig, backend)
    fits = len(new) <= limit
    print(f"with {KEY}={backend}: {len(new)} bytes (limit {limit}) -> "
          f"{'FITS' if fits else 'TOO BIG'}")
    for c in changed:
        print(f"  {c}")
    return header_end, new, changed, fits


def cmd_check(args):
    _validate(args.model, args.backend)


def cmd_patch(args):
    header_end, new, changed, fits = _validate(args.model, args.backend)
    if not changed:
        raise SystemExit("ABORT: no main section found to patch.")
    if not fits:
        raise SystemExit("ABORT: patched header would overrun the first block.")
    if all("nothing to do" in c for c in changed):
        print("Already correct; no write performed.")
        return

    # Consent gate (FR-019). Another command driving this tool must assert that it
    # already obtained consent, in the same invocation, by passing --yes. Without a
    # terminal to prompt at and without --yes, refuse rather than write silently.
    if not args.yes:
        refusal = (
            "ABORT: refusing to modify a model file without consent.\n"
            "  Re-run with --yes once the user has agreed to this specific change,\n"
            "  or run `check` instead to see what would happen without writing."
        )
        if not sys.stdin.isatty():
            raise SystemExit(refusal)

        prior = "cpu" if args.backend != "cpu" else "gpu"
        print(f"\nAbout to rewrite the header of:\n  {args.model}")
        print("Only the first 16 KB is written; the payload is not touched.")
        print(f"Reversible with:  litertlm_backend.py patch <model> --backend {prior} --yes")
        try:
            answer = input("Proceed? [y/N] ")
        except (EOFError, KeyboardInterrupt):
            # isatty() can report a terminal that cannot actually be read from — a
            # piped or redirected stdin under some shells. Treat it as a decline
            # rather than letting a traceback reach the user.
            print()
            raise SystemExit(refusal)
        if answer.strip().lower() not in ("y", "yes"):
            raise SystemExit("Declined; nothing was written.")

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

    reverse_to = "cpu" if args.backend != "cpu" else "gpu"
    print(f"header rewritten: end {header_end} -> {new_end}")
    print(f"verify:   litertlm_backend.py resolve")
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

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
