"""Image transport regression checks without remote generation or billing."""

import base64
import json
import os
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, patch

import requests

from src.apps.playground.models import GenerateRequest
from src.apps.playground.service import PlaygroundService
from src.apps.playground.storage import PlaygroundStorage
from src.models.jiucaihezi import (
    JiucaiheziImageModel, JiucaiheziVideoModel, MAX_TEMP_UPLOAD_BYTES,
    _gateway_request, generate_audio,
)


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
        response._content_consumed = True
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

    def test_fk_edit_uses_images_and_native_size_ratio_fields(self):
        reference = Path(self.directory.name) / "reference.png"
        reference.write_bytes(b"reference")
        model = "ft-image-v1-186289ba9d3263010c69372f8939dd94"
        JiucaiheziImageModel({}).generate(
            "prompt", str(self.output), model_name=model,
            ref_image_paths=[str(reference)], resolution="2K", aspect_ratio="9:16",
        )
        request, _ = self.calls[0]
        self.assertTrue(request.url.endswith("/v1/images/edits"))
        self.assertIn(b'name="images"; filename="reference.png"', request.body)
        self.assertNotIn(b'name="image";', request.body)
        for name, value in (("model", model), ("imageSize", "2K"), ("ratio", "9:16")):
            self.assertIn(f'name="{name}"\r\n\r\n{value}'.encode(), request.body)
        self.assertNotIn(b'name="size"', request.body)
        self.assert_direct()

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

    def test_qwen_reference_edit_uses_documented_json_with_exact_size(self):
        reference = Path(self.directory.name) / "reference.png"
        reference.write_bytes(b"reference")
        JiucaiheziImageModel({}).generate(
            "prompt", str(self.output), model_name="jc-qwen-image-2.1",
            size="1920x1088", ref_image_paths=[str(reference)],
        )
        request, _ = self.calls[0]
        self.assertTrue(request.url.endswith("/v1/images/generations"))
        self.assertEqual(request.headers["Content-Type"], "application/json")
        payload = json.loads(request.body)
        self.assertEqual(payload, {
            "model": "jc-qwen-image-2.1", "prompt": "prompt", "size": "1920x1088",
            "n": 1, "response_format": "b64_json",
            "images": ["data:image/png;base64," + base64.b64encode(b"reference").decode()],
        })
        self.assertEqual(self.output.read_bytes(), b"generated-image")
        self.assert_direct()

    def test_qwen_multi_reference_order_and_data_urls_are_preserved(self):
        reference = Path(self.directory.name) / "first.png"
        reference.write_bytes(b"first")
        second = "data:image/jpeg;base64," + base64.b64encode(b"second").decode()
        JiucaiheziImageModel({}).generate(
            "prompt", str(self.output), model_name="jc-qwen-image-2.1",
            size="1088x1920", ref_image_paths=[str(reference), second],
        )
        payload = json.loads(self.calls[0][0].body)
        self.assertEqual(payload["size"], "1088x1920")
        self.assertEqual(payload["images"], [
            "data:image/png;base64," + base64.b64encode(b"first").decode(), second,
        ])

    def test_qwen_reference_validation_fails_before_billed_submission(self):
        reference = Path(self.directory.name) / "reference.png"
        reference.write_bytes(b"")
        invalid_inputs = [([str(reference)], "为空"), ([str(reference) + ".missing"], "不存在"),
                          ([str(reference)] * 11, "10 张"), (["data:image/png;base64,%%%"], "无效")]
        for refs, message in invalid_inputs:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                JiucaiheziImageModel({}).generate(
                    "prompt", str(self.output), model_name="jc-qwen-image-2.1", ref_image_paths=refs,
                )
        with open(reference, "wb") as file:
            file.truncate(MAX_TEMP_UPLOAD_BYTES + 1)
        with self.assertRaisesRegex(ValueError, "20 MB"):
            JiucaiheziImageModel({}).generate(
                "prompt", str(self.output), model_name="jc-qwen-image-2.1", ref_image_paths=[str(reference)],
            )
        self.assertEqual(self.calls, [])

    def test_qwen_remote_reference_is_inlined_without_upload_or_auth_leak(self):
        def respond(request):
            if request.method == "GET":
                self.assertNotIn("Authorization", request.headers)
                return self.response(b"reference", content_type="image/png")
            return self.respond_inline(request)
        self.handler = respond
        JiucaiheziImageModel({}).generate(
            "prompt", str(self.output), model_name="jc-qwen-image-2.1",
            ref_image_paths=["https://cdn.example/reference.png"],
        )
        self.assertEqual([req.method for req, _ in self.calls], ["GET", "POST"])
        payload = json.loads(self.calls[-1][0].body)
        self.assertEqual(base64.b64decode(payload["images"][0].split(",", 1)[1]), b"reference")
        self.assert_direct()

    def test_qwen_gateway_failure_is_not_retried_and_releases_queue(self):
        reference = Path(self.directory.name) / "reference.png"
        reference.write_bytes(b"reference")
        def failed(request):
            response = self.response(b'{"error":{"code":"do_request_failed"}}', 500)
            response.headers["x-oneapi-request-id"] = "request-id"
            return response
        self.handler = failed
        with self.assertRaisesRegex(requests.HTTPError, "do_request_failed"):
            JiucaiheziImageModel({}).generate(
                "prompt", str(self.output), model_name="jc-qwen-image-2.1", ref_image_paths=[str(reference)],
            )
        self.assertEqual(len(self.calls), 1)
        self.handler = self.respond_inline
        JiucaiheziImageModel({}).generate("prompt", str(self.output), model_name="jc-qwen-image-2.1")
        self.assertEqual(len(self.calls), 2)

    def test_qwen_requests_from_different_instances_are_serialized(self):
        first_started, second_waiting, release_first = threading.Event(), threading.Event(), threading.Event()
        lock = threading.Lock()
        class ObservedLock:
            def __enter__(self):
                if lock.locked():
                    second_waiting.set()
                lock.acquire()
            def __exit__(self, *args):
                lock.release()
        def respond(request):
            if len(self.calls) == 1:
                first_started.set()
                if not release_first.wait(5):
                    raise AssertionError("first request was not released")
            return self.respond_inline(request)
        self.handler = respond
        with patch("src.models.jiucaihezi._QWEN_IMAGE_LOCK", ObservedLock()), ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(JiucaiheziImageModel({}).generate, "first", str(self.output), model_name="jc-qwen-image-2.1")
            try:
                self.assertTrue(first_started.wait(3))
                second = pool.submit(JiucaiheziImageModel({}).generate, "second", str(self.output) + ".second", model_name="jiucaihezi/jc-qwen-image-2.1")
                self.assertTrue(second_waiting.wait(3))
                self.assertEqual(len(self.calls), 1)
            finally:
                release_first.set()
            first.result(timeout=5)
            second.result(timeout=5)
        self.assertEqual(len(self.calls), 2)

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
                _gateway_request("https://api.jiucaihezi.studio/v1/images/generations", method="POST")
        self.assertFalse(sessions[0].trust_env)
        sessions[0].close.assert_called_once()
        self.assertEqual(len(self.calls), 1)

    def test_local_video_upload_create_poll_download_and_task_persistence(self):
        reference = Path(self.directory.name) / "reference.png"
        reference.write_bytes(b"reference")
        storage = PlaygroundStorage.__new__(PlaygroundStorage)
        storage._history = []
        storage._save_history = Mock()
        service = PlaygroundService(storage)
        gen = service.create_generation(GenerateRequest(
            mode="r2v", model_id="jc-minimax-h3-ref2v", prompt="prompt",
            input_media=[str(reference)],
            parameters={"duration": 3, "ratio": "9:16"},
        ))

        def respond(request):
            if request.url.endswith("/api/creations/uploads"):
                return self.response(b'{"url":"https://cdn.example/reference.png"}')
            if request.method == "POST":
                payload = json.loads(request.body)
                self.assertEqual(payload["model"], "jc-minimax-h3-ref2v")
                self.assertEqual(payload["aspect_ratio"], "9:16 (Portrait Widescreen)")
                return self.response(b'{"id":"task-local"}')
            # The task id must be saved before the first poll or download.
            self.assertEqual(gen.provider_task_ids, ["task-local"])
            if request.url.endswith("/content"):
                return self.response(b"video", content_type="video/mp4")
            return self.response(b'{"status":"completed"}')

        self.handler = respond
        with patch("src.apps.playground.service.VIDEO_OUTPUT_DIR", self.directory.name), patch(
            "src.models.jiucaihezi.time.sleep"
        ):
            service.process_generation(gen.id)
        self.assertEqual(gen.status, "completed", gen.error)
        self.assertEqual(len(gen.outputs), 1)
        self.assertEqual(len(self.calls), 4)
        self.assert_direct()

    def test_video_url_fallback_also_bypasses_proxy(self):
        def respond(request):
            if request.method == "POST":
                return self.response(b'{"id":"task-fallback"}')
            if request.url.endswith("/content"):
                return self.response(b'{"error":{"message":"unavailable"}}', 502)
            if request.url == "https://cdn.example/video.mp4":
                self.assertNotIn("Authorization", request.headers)
                return self.response(b"video", content_type="video/mp4")
            return self.response(b'{"status":"completed","url":"https://cdn.example/video.mp4"}')
        self.handler = respond
        with patch("src.models.jiucaihezi.time.sleep"):
            JiucaiheziVideoModel({}).generate("prompt", str(self.output), model_name="海seedance2.5")
        self.assertEqual(self.output.read_bytes(), b"video")
        self.assert_direct()

    def test_video_connection_loss_does_not_resubmit(self):
        def disconnect(request):
            raise requests.ConnectionError("response lost")
        self.handler = disconnect
        with self.assertRaisesRegex(RuntimeError, "可能已经创建并计费"):
            JiucaiheziVideoModel({}).generate("prompt", str(self.output))
        self.assertEqual(len(self.calls), 1)
        self.assert_direct()

    def test_audio_submission_bypasses_proxy(self):
        self.handler = lambda request: self.response(b"audio", content_type="audio/mpeg")
        generate_audio("prompt", str(self.output))
        self.assertEqual(self.output.read_bytes(), b"audio")
        self.assert_direct()

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
