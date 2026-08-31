import os
import unittest

from mako_ai._config import resolve_config
from mako_ai.errors import MakoConfigError

ENV_VARS = [
    "MAKO_API_URL",
    "MAKO_API_BASE_URL",
    "MAKO_WORKSPACE_ID",
    "MAKO_KERNEL_TOKEN",
    "MAKO_TOKEN",
    "MAKO_API_KEY",
]


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.pop(k, None) for k in ENV_VARS}

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_resolves_from_env(self):
        os.environ["MAKO_API_URL"] = "https://app.mako.ai/"
        os.environ["MAKO_WORKSPACE_ID"] = "ws_1"
        os.environ["MAKO_KERNEL_TOKEN"] = "revops_abc"
        cfg = resolve_config()
        self.assertEqual(cfg.workspace_id, "ws_1")
        self.assertEqual(cfg.token, "revops_abc")
        # base_url strips the trailing slash so path joins never double up.
        self.assertEqual(cfg.base_url(), "https://app.mako.ai")

    def test_token_aliases(self):
        os.environ["MAKO_API_URL"] = "https://x"
        os.environ["MAKO_WORKSPACE_ID"] = "ws"
        os.environ["MAKO_API_KEY"] = "revops_fallback"
        cfg = resolve_config()
        self.assertEqual(cfg.token, "revops_fallback")

    def test_missing_lists_all_gaps(self):
        with self.assertRaises(MakoConfigError) as ctx:
            resolve_config()
        msg = str(ctx.exception)
        self.assertIn("api_url", msg)
        self.assertIn("workspace_id", msg)
        self.assertIn("token", msg)

    def test_overrides_win_over_env(self):
        os.environ["MAKO_API_URL"] = "https://env"
        os.environ["MAKO_WORKSPACE_ID"] = "ws_env"
        os.environ["MAKO_KERNEL_TOKEN"] = "t_env"
        cfg = resolve_config({"workspace_id": "ws_override"})
        self.assertEqual(cfg.workspace_id, "ws_override")
        self.assertEqual(cfg.api_url, "https://env")


if __name__ == "__main__":
    unittest.main()
