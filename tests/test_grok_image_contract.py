"""Run with python -m unittest discover -s tests -p test_grok_image_contract.py."""
import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from src.models.jiucaihezi import JiucaiheziImageModel


class GrokImageContractTest(unittest.TestCase):
    def test_generation_and_edit_send_exact_model_and_save_result(self):
        response = Mock()
        response.json.return_value = {"data": [{"b64_json": base64.b64encode(b"image").decode()}]}
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "reference.png"
            reference.write_bytes(b"reference")
            for editing in (False, True):
                with self.subTest(editing=editing), patch.dict("os.environ", {"JIUCAIHEZI_API_KEY": "test"}), patch("src.models.jiucaihezi.requests.post", return_value=response) as post:
                    output = Path(directory) / "result.png"
                    JiucaiheziImageModel({}).generate(
                        "blue cup", str(output), model_name="jiucaihezi/grok-imagine-image-2.0",
                        ref_image_paths=[str(reference)] if editing else [],
                    )
                    self.assertTrue(post.call_args.args[0].endswith("/v1/images/edits" if editing else "/v1/images/generations"))
                    payload = post.call_args.kwargs["data" if editing else "json"]
                    self.assertEqual(payload["model"], "grok-imagine-image-2.0")
                    self.assertEqual(output.read_bytes(), b"image")


if __name__ == "__main__":
    unittest.main()
