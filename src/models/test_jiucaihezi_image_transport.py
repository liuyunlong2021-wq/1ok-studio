"""Image transport regression checks without remote generation or billing."""

import base64
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests

from src.apps.playground.models import GenerateRequest
from src.apps.playground.service import PlaygroundService
from src.apps.playground.storage import PlaygroundStorage
from src.models.jiucaihezi import JiucaiheziImageModel, _image_request


class ImageTransportChecks(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name) / "output.png"
        self.calls = []
        self.proxy_lookup = self.enterContext(patch(
            "requests.utils.getproxies", return_value={"https": "http://127.0.0.1:1"},
        ))
        self.enterContext(patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"}))
        self.handler = self.respond_inline

        def send(adapter, request, **kwargs):
            self.calls.append((request, kwargs))
            if kwargs.get("proxies"):
                raise requests.exceptions.ProxyError("Unable to connect to proxy")
            response = self.handler(request)
            response.request = request
            response.url = request.url
            return response

        self.enterContext(patch("requests.adapters.HTTPAdapter.send", new=send))

    @staticmethod
    def response(content, status=200, content_type="application/json"):
        response = requests.Response()
        response.status_code = status
        response._content = content
        response.headers["Content-Type"] = content_type
        return response

    def respond_inline(self, request):
        return self.response(json.dumps({
            "data": [{"b64_json": base64.b64encode(b"generated-image").decode()}],
        }).encode())

    def assert_direct(self):
        self.proxy_lookup.assert_not_called()
        for _, kwargs in self.calls:
            self.assertFalse(kwargs["proxies"])
            self.assertIs(kwargs["verify"], True)

    def test_default_requests_reproduces_inherited_system_proxy_failure(self):
        with self.assertRaises(requests.exceptions.ProxyError):
            requests.post("https://api.jiucaihezi.studio/v1/images/edits", timeout=1)
        self.proxy_lookup.assert_called()
        self.assertEqual(self.calls[0][1]["proxies"]["https"], "http://127.0.0.1:1")

    def test_text_to_image_bypasses_proxy_and_preserves_size(self):
        JiucaiheziImageModel({}).generate(
            "prompt", str(self.output), model_name="jc-qwen-image-2.1", size="1088x1920",
        )
        request, _ = self.calls[0]
        self.assertEqual(request.method, "POST")
        self.assertTrue(request.url.endswith("/v1/images/generations"))
        self.assertEqual(json.loads(request.body)["size"], "1088x1920")
        self.assertEqual(self.output.read_bytes(), b"generated-image")
        self.assert_direct()

    def test_reference_edit_bypasses_proxy_and_preserves_multipart(self):
        reference = Path(self.directory.name) / "reference.png"
        reference.write_bytes(b"reference")
        JiucaiheziImageModel({}).generate(
            "prompt", str(self.output), model_name="jc-qwen-image-2.1",
            size="1920x1088", ref_image_paths=[str(reference)],
        )
        request, _ = self.calls[0]
        self.assertTrue(request.url.endswith("/v1/images/edits"))
        self.assertIn("multipart/form-data", request.headers["Content-Type"])
        self.assertIn(b'name="size"\r\n\r\n1920x1088', request.body)
        self.assertIn(b'name="image"; filename="reference.png"', request.body)
        self.assertEqual(self.output.read_bytes(), b"generated-image")
        self.assert_direct()

    def test_remote_reference_and_result_download_also_bypass_proxy(self):
        def respond(request):
            if request.method == "POST":
                return self.response(b'{"data":[{"url":"https://cdn.example/output.png"}]}')
            self.assertNotIn("Authorization", request.headers)
            return self.response(b"image", content_type="image/png")
        self.handler = respond
        JiucaiheziImageModel({}).generate(
            "prompt", str(self.output), model_name="grok-imagine-image-2.0",
            ref_image_paths=["https://cdn.example/reference.png"],
        )
        self.assertEqual([request.method for request, _ in self.calls], ["GET", "POST", "GET"])
        self.assertEqual(self.output.read_bytes(), b"image")
        self.assert_direct()

    def test_upstream_http_error_is_preserved_without_submission_retry(self):
        self.handler = lambda request: self.response(b'{"error":{"message":"upstream down"}}', 502)
        with self.assertRaisesRegex(requests.HTTPError, "upstream down"):
            JiucaiheziImageModel({}).generate("prompt", str(self.output))
        self.assertEqual(len(self.calls), 1)
        self.assert_direct()

    def test_direct_session_is_closed_after_connection_failure(self):
        sessions = []
        real_session = requests.Session
        def session_factory():
            session = real_session()
            session.close = Mock(wraps=session.close)
            sessions.append(session)
            return session
        def disconnect(request):
            raise requests.ConnectionError("disconnected")
        self.handler = disconnect
        with patch("src.models.jiucaihezi.requests.Session", side_effect=session_factory):
            with self.assertRaises(requests.ConnectionError):
                _image_request("https://api.jiucaihezi.studio/v1/images/generations", method="POST")
        self.assertFalse(sessions[0].trust_env)
        sessions[0].close.assert_called_once()
        self.assertEqual(len(self.calls), 1)

    def test_playground_resolves_tier_then_generates_without_proxy(self):
        storage = PlaygroundStorage.__new__(PlaygroundStorage)
        storage._history = []
        storage._save_history = lambda: None
        service = PlaygroundService(storage)
        gen = service.create_generation(GenerateRequest(
            mode="t2i", model_id="jc-qwen-image-2.1", prompt="prompt",
            parameters={"resolution": "2K", "aspect_ratio": "9:16", "size": "576x1024"},
        ))
        with patch("src.apps.playground.service.IMAGE_OUTPUT_DIR", self.directory.name):
            service.process_generation(gen.id)
        self.assertEqual(gen.status, "completed", gen.error)
        self.assertEqual(gen.parameters["size"], "1088x1920")
        self.assertEqual(json.loads(self.calls[0][0].body)["size"], "1088x1920")
        self.assertEqual(len(gen.outputs), 1)
        self.assert_direct()


if __name__ == "__main__":
    unittest.main()
