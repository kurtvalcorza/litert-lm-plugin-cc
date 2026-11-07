"""Effective-backend reporting across runtime versions (RFC #18, PR C).

Runs against upstream's real config module, pointed at a scratch LITERT_LM_DIR, so the
precedence asserted here is the runtime's own. The 0.14.0 cases are the same code with
the version reported as 0.14.0, which is the only thing that selects the legacy path.
Self-skips without the runtime, and the config cases without a 0.15+ one.
"""

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
_TOOLS = os.path.join(os.path.dirname(_HERE), "plugins", "litertlm", "tools")
for _p in (_TOOLS, _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

RUNTIME_OK = True
_IMPORT_ERR = ""
CONFIG_OK = False
try:
    import litertlm_backend as lb  # type: ignore
    from test_header_transaction import _container, _first_block  # type: ignore
    CONFIG_OK = lb.config_module() is not None
except BaseException as exc:  # noqa: BLE001 — SystemExit is not an Exception
    RUNTIME_OK = False
    _IMPORT_ERR = f"{type(exc).__name__}: {exc}"


def _capture(fn, args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        fn(args)
    return out.getvalue()


@unittest.skipUnless(RUNTIME_OK, f"litert-lm runtime not importable here ({_IMPORT_ERR})")
class Base(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)
        self.models = os.path.join(self.base, "models")
        patcher = mock.patch.dict(os.environ, {"LITERT_LM_DIR": self.base})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.cfg = lb.config_module()
        if self.cfg is not None:
            self.cfg._clear_cache()
            self.addCleanup(self.cfg._clear_cache)

    def model(self, model_id, **kw):
        d = os.path.join(self.models, model_id)
        os.makedirs(d)
        path = os.path.join(d, "model.litertlm")
        _container(path, **kw)
        return path

    def write_config(self, data):
        path = os.path.join(self.base, "config.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write(data if isinstance(data, str) else json.dumps(data))
        if self.cfg is not None:
            self.cfg._clear_cache()
        return path

    def resolve(self):
        return _capture(lb.cmd_resolve, SimpleNamespace(models_dir=self.models))

    def row(self, model_id):
        return next(ln for ln in self.resolve().splitlines() if ln.startswith(model_id))


class Legacy(Base):
    """The 0.14.0 behaviour: no override exists, so the file is the answer."""

    def setUp(self):
        version = mock.patch.object(lb, "runtime_version", return_value="0.14.0")
        version.start()
        self.addCleanup(version.stop)
        super().setUp()

    def test_version_alone_selects_the_legacy_path(self):
        self.assertIsNone(lb.config_module())

    def test_metadata_decides_and_a_config_file_is_ignored(self):
        self.model("plain")
        self.write_config({"models": {"plain": {"backend": "gpu"}}})
        output = self.resolve()
        self.assertIn("no config override on this version", output)
        self.assertRegex(output, r"plain\s+cpu\s+embedded=cpu\s+<-- serves on CPU")

    def test_patch_still_works_without_any_flag(self):
        path = self.model("plain")
        _capture(lb.cmd_patch, SimpleNamespace(model=path, backend="gpu", yes=True,
                                               legacy_header_edit=False))
        self.assertEqual(lb._main_constraint(lb.read_header(path)[1]), ["gpu"])

    def test_configure_explains_rather_than_writing(self):
        self.model("plain")
        with self.assertRaises(SystemExit) as caught:
            lb.cmd_configure(SimpleNamespace(model_id="plain", backend="gpu", max_num_tokens=None,
                                             clear=False, yes=True))
        self.assertIn("0.15.0", str(caught.exception))
        self.assertFalse(os.path.exists(os.path.join(self.base, "config.json")))


@unittest.skipUnless(CONFIG_OK, "needs a litert-lm that reads config.json (0.15.0+)")
class Effective(Base):
    def test_no_config_at_all_is_the_metadata(self):
        self.model("plain")
        self.assertRegex(self.row("plain"), r"plain\s+cpu\s+embedded=cpu\s+override=none\s+<--")

    def test_per_model_override_beats_missing_metadata(self):
        """The audit's F-03 case: no GPU declaration, correctly on GPU."""
        self.model("plain")
        self.write_config({"models": {"plain": {"backend": "gpu"}}})
        row = self.row("plain")
        self.assertRegex(row, r"plain\s+gpu\s+embedded=cpu\s+override=gpu \(model\)")
        self.assertNotIn("serves on CPU", row)

    def test_global_default_applies(self):
        self.model("plain")
        self.write_config({"default": {"backend": "gpu"}})
        self.assertIn("override=gpu (default)", self.row("plain"))

    def test_per_model_beats_global_default(self):
        self.model("plain")
        self.write_config({"default": {"backend": "cpu"},
                           "models": {"plain": {"backend": "gpu"}}})
        self.assertRegex(self.row("plain"), r"plain\s+gpu\s.*\(model\)")

    def test_override_outside_the_declared_list_is_reported_as_refused(self):
        # Measured on 0.19.1: "Model requires one of [npu] but Main backend is CPU".
        self.model("declared", constraint="gpu")
        self.write_config({"models": {"declared": {"backend": "cpu"}}})
        row = self.row("declared")
        self.assertRegex(row, r"declared\s+REFUSED\s+embedded=gpu\s+override=cpu \(model\)")
        self.assertIn("allows only gpu", row)
        self.assertNotIn("serves on CPU", row)

    def test_a_default_backend_is_held_to_the_same_list(self):
        self.model("declared", constraint="gpu")
        self.write_config({"default": {"backend": "cpu"}})
        self.assertRegex(self.row("declared"), r"declared\s+REFUSED\s.*\(default\)")

    def test_override_inside_the_declared_list_applies(self):
        # Measured on 0.19.1 with npu,cpu: the first value is a default, not a limit.
        self.model("listed", constraint="gpu,cpu")
        self.write_config({"models": {"listed": {"backend": "cpu"}}})
        row = self.row("listed")
        self.assertRegex(row, r"listed\s+cpu\s+embedded=gpu\s+override=cpu \(model\)")
        self.assertIn("serves on CPU", row)

    def test_the_list_tolerates_spacing_and_case(self):
        self.model("spaced", constraint="GPU, cpu")
        self.write_config({"models": {"spaced": {"backend": "cpu"}}})
        self.assertRegex(self.row("spaced"), r"spaced\s+cpu\s")

    def test_a_key_for_another_model_is_not_an_override(self):
        self.model("plain")
        self.write_config({"models": {"other": {"backend": "gpu"}}})
        self.assertIn("override=none", self.row("plain"))

    def test_spelling_with_a_slash_or_dashes_matches(self):
        self.model("org--plain")
        self.write_config({"models": {"org/plain": {"backend": "gpu"}}})
        self.assertIn("override=gpu (model)", self.row("org--plain"))

    def test_invalid_json_is_reported_not_guessed_through(self):
        self.model("plain")
        self.write_config("{not json")
        output = self.resolve()
        self.assertIn("invalid", output)
        self.assertRegex(output, r"plain\s+unknown\s+embedded=cpu")
        self.assertNotIn("serves on CPU", output)

    def test_schema_violation_is_reported_the_same_way(self):
        self.model("plain")
        self.write_config({"models": {"plain": {"backend": "quantum"}}})
        self.assertIn("unknown", self.row("plain"))

    def test_precedence_matches_the_runtime_itself(self):
        """Not our reading of upstream: upstream, asked the same question."""
        path = self.model("plain")
        for config, expected in (
            ({}, "cpu"),
            ({"default": {"backend": "gpu"}}, "gpu"),
            ({"default": {"backend": "gpu"}, "models": {"plain": {"backend": "cpu"}}}, "cpu"),
        ):
            with self.subTest(config=config):
                self.write_config(config)
                model = lb.M.Model.from_model_path(path)
                model.model_id = "plain"
                with contextlib.redirect_stdout(io.StringIO()):
                    resolved = lb.M.parse_backend(None, model_obj=model)
                self.assertIn(expected, repr(resolved).lower())
                self.assertRegex(self.row("plain"), rf"plain\s+{expected}\s")


@unittest.skipUnless(CONFIG_OK, "needs a litert-lm that reads config.json (0.15.0+)")
class Configure(Base):
    def run_configure(self, model_id="plain", backend=None, tokens=None, clear=False, yes=True):
        return _capture(lb.cmd_configure, SimpleNamespace(
            model_id=model_id, backend=backend, max_num_tokens=tokens, clear=clear, yes=yes))

    def config(self):
        with open(os.path.join(self.base, "config.json"), encoding="utf-8") as f:
            return json.load(f)

    def test_writes_the_override_and_leaves_the_model_alone(self):
        path = self.model("plain")
        before = _first_block(path)
        self.run_configure(backend="gpu")
        self.assertEqual(self.config(), {"models": {"plain": {"backend": "gpu"}}})
        self.assertEqual(_first_block(path), before)
        self.cfg._clear_cache()
        self.assertRegex(self.row("plain"), r"plain\s+gpu\s")

    def test_keeps_everything_it_was_not_asked_to_change(self):
        self.model("plain")
        self.write_config({"default": {"temperature": 0.5},
                           "models": {"plain": {"top_k": 3}, "other": {"backend": "cpu"}}})
        self.run_configure(backend="gpu", tokens=1024)
        self.assertEqual(self.config(), {
            "default": {"temperature": 0.5},
            "models": {"plain": {"top_k": 3, "backend": "gpu", "max_num_tokens": 1024},
                       "other": {"backend": "cpu"}},
        })

    def test_clear_round_trips_to_no_override(self):
        self.model("plain")
        self.run_configure(backend="gpu")
        self.run_configure(clear=True)
        self.assertEqual(self.config(), {})

    def test_refuses_a_backend_the_file_does_not_allow(self):
        path = self.model("declared", constraint="gpu")
        before = _first_block(path)
        with self.assertRaises(SystemExit) as caught:
            self.run_configure("declared", backend="cpu")
        message = str(caught.exception)
        self.assertIn("allows only gpu", message)
        self.assertIn("--legacy-header-edit", message)
        self.assertFalse(os.path.exists(os.path.join(self.base, "config.json")))
        self.assertEqual(_first_block(path), before)

    def test_accepts_any_listed_backend(self):
        self.model("listed", constraint="gpu,cpu")
        self.run_configure("listed", backend="cpu")
        self.assertEqual(self.config()["models"]["listed"]["backend"], "cpu")

    def test_a_model_with_no_constraint_takes_any_backend(self):
        self.model("plain")
        self.run_configure("plain", backend="gpu")
        self.assertEqual(self.config()["models"]["plain"]["backend"], "gpu")

    def test_tokens_alone_are_not_held_to_the_list(self):
        self.model("declared", constraint="gpu")
        self.run_configure("declared", tokens=4096)
        self.assertEqual(self.config()["models"]["declared"]["max_num_tokens"], 4096)

    def test_clear_still_works_on_a_refused_override(self):
        self.model("declared", constraint="gpu")
        self.write_config({"models": {"declared": {"backend": "cpu"}}})
        self.run_configure("declared", clear=True)
        self.assertRegex(self.row("declared"), r"declared\s+gpu\s+embedded=gpu\s+override=none")

    def test_refuses_an_unknown_model(self):
        with self.assertRaises(SystemExit) as caught:
            self.run_configure(model_id="nope", backend="gpu")
        self.assertIn("No imported model", str(caught.exception))

    def test_leaves_an_invalid_config_exactly_as_it_found_it(self):
        self.model("plain")
        path = self.write_config("{not json")
        with self.assertRaises(SystemExit):
            self.run_configure(backend="gpu")
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), "{not json")

    def test_a_result_the_runtime_would_reject_is_never_installed(self):
        self.model("plain")
        path = self.write_config({"models": {"plain": {"top_k": "many"}}})
        with self.assertRaises(SystemExit) as caught:
            self.run_configure(backend="gpu")
        self.assertIn("left alone", str(caught.exception))
        with open(path, encoding="utf-8") as f:
            self.assertIn("many", f.read())
        self.assertEqual(sorted(os.listdir(self.base)), ["config.json", "models"])

    def test_refuses_without_consent(self):
        self.model("plain")
        with mock.patch.object(sys.stdin, "isatty", return_value=False):
            with self.assertRaises(SystemExit):
                self.run_configure(backend="gpu", yes=False)
        self.assertFalse(os.path.exists(os.path.join(self.base, "config.json")))

    def test_needs_something_to_do(self):
        self.model("plain")
        with self.assertRaises(SystemExit):
            self.run_configure()


@unittest.skipUnless(CONFIG_OK, "needs a litert-lm that reads config.json (0.15.0+)")
class HeaderEditGate(Base):
    def test_patch_refuses_and_names_the_config_route(self):
        path = self.model("plain")
        before = _first_block(path)
        with self.assertRaises(SystemExit) as caught:
            lb.cmd_patch(SimpleNamespace(model=path, backend="gpu", yes=True,
                                         legacy_header_edit=False))
        self.assertIn("configure plain --backend gpu", str(caught.exception))
        self.assertEqual(_first_block(path), before)
        self.assertEqual(os.listdir(os.path.dirname(path)), ["model.litertlm"])

    def test_patch_never_names_a_config_route_that_cannot_work(self):
        path = self.model("declared", constraint="cpu")
        before = _first_block(path)
        with self.assertRaises(SystemExit) as caught:
            lb.cmd_patch(SimpleNamespace(model=path, backend="gpu", yes=True,
                                         legacy_header_edit=False))
        message = str(caught.exception)
        self.assertNotIn("configure declared", message)
        self.assertIn("--legacy-header-edit", message)
        self.assertEqual(_first_block(path), before)

    def test_check_says_when_config_cannot_reach_the_backend(self):
        path = self.model("declared", constraint="cpu")
        output = _capture(lb.cmd_check, SimpleNamespace(model=path, backend="gpu"))
        self.assertIn("config cannot select gpu", output)
        self.assertNotIn("`configure` fixes", output)

    def test_the_flag_still_allows_it(self):
        path = self.model("plain")
        _capture(lb.cmd_patch, SimpleNamespace(model=path, backend="gpu", yes=True,
                                               legacy_header_edit=True))
        self.assertEqual(lb._main_constraint(lb.read_header(path)[1]), ["gpu"])

    def test_check_points_at_the_config_route_without_failing(self):
        path = self.model("plain")
        output = _capture(lb.cmd_check, SimpleNamespace(model=path, backend="gpu"))
        self.assertIn("configure", output)


if __name__ == "__main__":
    unittest.main()
