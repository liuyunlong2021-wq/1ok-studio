"""Gateway transport regressions; no live model requests."""

import os
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import httpx

from src.apps.comic_gen.llm_adapter import LLMAdapter


class GatewayTransportTests(unittest.TestCase):
    def _stream_client(self, chunks):
        stream = Mock()
        stream.__iter__ = Mock(side_effect=lambda: iter(chunks))
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
            create=Mock(return_value=stream),
        )))
        return client, stream

    def _chunk(self, text="", reason=None):
        return SimpleNamespace(choices=[SimpleNamespace(
            delta=SimpleNamespace(content=text), finish_reason=reason,
        )])

    def test_gateway_collects_complete_stream_and_preserves_json_format(self):
        client, stream = self._stream_client([
            self._chunk('{"text":'), SimpleNamespace(choices=[]),
            self._chunk('"完整正文"}'), self._chunk(reason="stop"),
        ])
        result = LLMAdapter()._chat_once(
            client, "selected-model", [], {"type": "json_object"}, "Jiucaihezi",
        )
        self.assertEqual(result, '{"text":"完整正文"}')
        self.assertTrue(client.chat.completions.create.call_args.kwargs["stream"])
        self.assertEqual(client.chat.completions.create.call_args.kwargs["response_format"], {"type": "json_object"})
        stream.close.assert_called_once()

    def test_eof_or_token_limit_cannot_return_partial_script_as_success(self):
        for reason in (None, "length"):
            with self.subTest(finish_reason=reason):
                client, stream = self._stream_client([self._chunk("半篇剧本", reason)])
                with self.assertRaisesRegex(RuntimeError, "未完整结束"):
                    LLMAdapter()._chat_once(client, "selected-model", [], None, "Jiucaihezi")
                stream.close.assert_called_once()

    def test_interrupted_stream_closes_and_retains_failure(self):
        def interrupted():
            yield self._chunk("半篇剧本")
            raise httpx.RemoteProtocolError("stream disconnected")

        client, stream = self._stream_client([])
        stream.__iter__.side_effect = interrupted
        with self.assertRaisesRegex(RuntimeError, "stream disconnected"):
            LLMAdapter()._chat_once(client, "selected-model", [], None, "Jiucaihezi")
        stream.close.assert_called_once()

    def test_explicit_openai_provider_keeps_normal_completion(self):
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
            create=Mock(return_value=SimpleNamespace(choices=[SimpleNamespace(
                message=SimpleNamespace(content="正文"),
            )])),
        )))
        self.assertEqual(LLMAdapter()._chat_once(client, "selected-model", [], None, "OpenAI"), "正文")
        self.assertNotIn("stream", client.chat.completions.create.call_args.kwargs)

    def test_gateway_does_not_inherit_system_or_environment_proxies(self):
        with patch.dict(os.environ, {
            "JIUCAIHEZI_API_KEY": "test-credential",
            "HTTPS_PROXY": "http://127.0.0.1:9",
        }), patch("httpx._utils.getproxies", return_value={
            "https": "http://127.0.0.1:7897",
        }):
            client = LLMAdapter()._get_jiucaihezi_client()
            try:
                self.assertFalse(client._client.trust_env)
                self.assertEqual(client._client._mounts, {})
                self.assertEqual(client.timeout, 180.0)
            finally:
                client.close()

    def test_remote_disconnect_reason_and_model_are_preserved(self):
        def fail(**_kwargs):
            try:
                raise httpx.RemoteProtocolError("Server disconnected without sending a response.")
            except httpx.RemoteProtocolError as cause:
                raise RuntimeError("Connection error.") from cause

        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
            create=Mock(side_effect=fail),
        )))
        with self.assertLogs("src.apps.comic_gen.llm_adapter", level="ERROR") as logs:
            with self.assertRaises(RuntimeError) as captured:
                LLMAdapter()._chat_once(client, "selected-model", [], None, "Jiucaihezi")
        self.assertIn("RemoteProtocolError", str(captured.exception))
        self.assertIn("selected-model", str(captured.exception))
        self.assertIn("elapsed=", logs.output[0])

    def test_upstream_request_id_is_logged_without_credentials(self):
        error = RuntimeError("400 invalid request test-credential")
        error.status_code = 400
        error.request_id = "upstream-request-123"
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
            create=Mock(side_effect=error),
        )))
        with patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test-credential"}):
            with self.assertLogs("src.apps.comic_gen.llm_adapter", level="ERROR") as logs:
                with self.assertRaises(RuntimeError) as captured:
                    LLMAdapter()._chat_once(client, "selected-model", [], None, "Jiucaihezi")
        self.assertIn("status=400", logs.output[0])
        self.assertIn("upstream-request-123", logs.output[0])
        self.assertNotIn("test-credential", logs.output[0])
        self.assertNotIn("test-credential", str(captured.exception))


if __name__ == "__main__":
    unittest.main()
