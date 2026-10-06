"""Billed create-once semantics and Responses output validation, without network calls."""

from uuid import uuid4

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from . import h3_enhancer as h3


def response(payload=None, status=200):
    result = requests.Response()
    result.status_code = status
    import json

    result._content = json.dumps(payload or {}).encode()
    return result


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(h3, "_DIRECTORY", tmp_path)
    monkeypatch.setenv("JIUCAIHEZI_API_KEY", "test-only-key")
    h3._ACTIVE.clear()
    h3._POLLING.clear()
    app = FastAPI()
    app.include_router(h3.router)
    return TestClient(app)


def input_data(**overrides):
    return {
        "request_id": str(uuid4()),
        "text": "女舰长留在舰桥",
        "instruction": "保留动作先后",
        "duration": 5,
        "ratio": "9:16",
        "source_context": '{"documentId":"draft-1"}',
        **overrides,
    }


def test_shared_text_request_uses_response_id_and_nonempty_output(client, monkeypatch):
    seen = []

    def request(method, url, **kwargs):
        seen.append((method, url, kwargs))
        if method == "POST":
            return response(
                {"id": "resp_enhance_1", "status": "queued", "metadata": {"task_id": "task_other"}}
            )
        return response(
            {
                "id": "resp_enhance_1",
                "status": "completed",
                "usage": {"total_tokens": 0},
                "output": [{"content": [{"type": "output_text", "text": "增强后的动作"}]}],
            }
        )

    monkeypatch.setattr(h3, "_request", request)
    data = input_data()
    created = client.post("/prompt-enhancements", json=data)
    assert created.status_code == 200
    assert created.json()["status"] == "queued"
    state = client.get("/prompt-enhancements/" + created.json()["job_id"]).json()
    assert state["status"] == "completed" and state["text"] == "增强后的动作"
    assert (
        state["source_text"] == data["text"] and state["source_context"] == data["source_context"]
    )
    assert seen[1][1].endswith("/v1/responses/resp_enhance_1")
    payload = seen[0][2]["json"]
    assert payload == {
        "model": "MiniMax-H3-Context-IR",
        "background": True,
        "content": [{"type": "text", "text": "女舰长留在舰桥\n\n本次要求：\n保留动作先后"}],
        "duration": 5,
        "ratio": "9:16",
    }
    client.get("/prompt-enhancements/" + state["job_id"])
    assert len(seen) == 2  # Completed results are served from the durable record.


def test_same_request_id_does_not_create_again_and_rejects_changed_input(client, monkeypatch):
    calls = []
    monkeypatch.setattr(
        h3,
        "_request",
        lambda *a, **kw: calls.append(a) or response({"id": "resp_once", "status": "queued"}),
    )
    data = input_data()
    first = client.post("/prompt-enhancements", json=data).json()
    second = client.post("/prompt-enhancements", json=data).json()
    assert first["job_id"] == second["job_id"] and len(calls) == 1
    assert (
        client.post("/prompt-enhancements", json={**data, "text": "different"}).status_code == 409
    )
    assert len(calls) == 1


@pytest.mark.parametrize(
    "change",
    [
        {"duration": 3},
        {"duration": 16},
        {"duration": 5.5},
        {"duration": "5"},
        {"ratio": "adaptive"},
        {"ratio": "2:3"},
    ],
)
def test_invalid_parameters_never_submit(client, monkeypatch, change):
    monkeypatch.setattr(h3, "_request", lambda *a, **kw: pytest.fail("invalid input was submitted"))
    assert client.post("/prompt-enhancements", json=input_data(**change)).status_code == 422


def test_empty_input_and_missing_key_do_not_create_tasks(client, monkeypatch):
    assert (
        client.post("/prompt-enhancements", json=input_data(text=" ", instruction=" ")).status_code
        == 400
    )
    monkeypatch.delenv("JIUCAIHEZI_API_KEY")
    assert client.post("/prompt-enhancements", json=input_data()).status_code == 400
    assert not list(h3._DIRECTORY.glob("*.json"))


@pytest.mark.parametrize("failure", ["timeout", "server_error", "invalid_id"])
def test_uncertain_creation_is_retained_without_retry(client, monkeypatch, failure):
    calls = []

    def request(*args, **kwargs):
        calls.append(args)
        if failure == "timeout":
            raise requests.Timeout()
        return response(
            (
                {"id": "task_wrong"}
                if failure == "invalid_id"
                else {"error": {"message": "unavailable"}}
            ),
            200 if failure == "invalid_id" else 503,
        )

    monkeypatch.setattr(h3, "_request", request)
    data = input_data()
    created = client.post("/prompt-enhancements", json=data).json()
    state = client.get("/prompt-enhancements/" + created["job_id"]).json()
    assert state["status"] == "unknown"
    client.post("/prompt-enhancements", json=data)
    client.get("/prompt-enhancements/" + created["job_id"])
    assert len(calls) == 1


def test_completed_with_empty_output_is_failed(client, monkeypatch):
    monkeypatch.setattr(
        h3,
        "_request",
        lambda *a, **kw: response({"id": "resp_empty", "status": "completed", "output": []}),
    )
    job = client.post("/prompt-enhancements", json=input_data()).json()
    state = client.get("/prompt-enhancements/" + job["job_id"]).json()
    assert state["status"] == "failed" and not state["text"]
    assert state["response_id"] == "resp_empty"


def test_query_rate_limit_then_resume_after_restart_only_queries_original(client, monkeypatch):
    calls = []

    def request(method, *args, **kwargs):
        calls.append(method)
        if method == "POST":
            return response({"id": "resp_resume", "status": "queued"})
        if calls.count("GET") == 1:
            return response({"error": {"message": "slow down"}}, 429)
        return response(
            {
                "status": "completed",
                "output": [{"content": [{"type": "output_text", "text": "resolved"}]}],
            }
        )

    monkeypatch.setattr(h3, "_request", request)
    job = client.post("/prompt-enhancements", json=input_data()).json()
    h3._ACTIVE.clear()  # A fresh process has no active background worker.
    limited = client.get("/prompt-enhancements/" + job["job_id"]).json()
    assert limited["status"] == "in_progress" and limited["error"] == "slow down"
    assert client.get("/prompt-enhancements/" + job["job_id"]).json()["text"] == "resolved"
    assert calls == ["POST", "GET", "GET"]


def test_interrupted_submission_stays_unknown_without_recreating(client):
    data = input_data()
    job_id = data["request_id"].replace("-", "")
    h3._write({"job_id": job_id, "fingerprint": "", "status": "submitting", "response_id": ""})
    assert client.get("/prompt-enhancements/" + job_id).json()["status"] == "unknown"


def test_from_scratch_uses_instruction_as_text(client, monkeypatch):
    seen = []
    monkeypatch.setattr(
        h3,
        "_request",
        lambda *a, **kw: seen.append(kw) or response({"id": "resp_new", "status": "queued"}),
    )
    client.post("/prompt-enhancements", json=input_data(text="", instruction="雨夜的侦探"))
    assert seen[0]["json"]["content"] == [{"type": "text", "text": "雨夜的侦探"}]


def image_uri(width=512, height=512):
    import base64
    import io
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height)).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode(), len(
        buffer.getvalue()
    )


def test_reference_images_upload_and_keep_order_without_local_paths(client, monkeypatch):
    uploaded = []
    seen = []
    monkeypatch.setattr(h3, "image_data", lambda ref: image_uri())

    def upload(path, kind):
        assert kind == "image" and h3.Path(path).exists()
        uploaded.append(path)
        return f"https://media.example/reference-{len(uploaded)}.png"

    monkeypatch.setattr(h3, "upload_to_jiucaihezi", upload)
    monkeypatch.setattr(
        h3,
        "_request",
        lambda *a, **kw: seen.append(kw["json"])
        or response({"id": "resp_refs", "status": "queued"}),
    )
    client.post(
        "/prompt-enhancements",
        json=input_data(
            images=[
                {"ref": "assets/person.png", "name": "舰长"},
                {"ref": "assets/bridge.png", "name": "舰桥"},
            ]
        ),
    )
    content = seen[0]["content"]
    assert "Image 1 / 参考图1：舰长" in content[0]["text"]
    assert content[1:] == [
        {
            "type": "image_url",
            "role": "reference_image",
            "image_url": {"url": "https://media.example/reference-1.png"},
        },
        {
            "type": "image_url",
            "role": "reference_image",
            "image_url": {"url": "https://media.example/reference-2.png"},
        },
    ]
    assert all(not h3.Path(path).exists() for path in uploaded)


@pytest.mark.parametrize("roles", [["first_frame"], ["last_frame"], ["first_frame", "last_frame"]])
def test_frame_roles_force_adaptive_ratio(client, monkeypatch, roles):
    seen = []
    monkeypatch.setattr(h3, "image_data", lambda ref: image_uri())
    monkeypatch.setattr(h3, "upload_to_jiucaihezi", lambda *a: "https://media.example/frame.png")
    monkeypatch.setattr(
        h3,
        "_request",
        lambda *a, **kw: seen.append(kw["json"])
        or response({"id": "resp_frames", "status": "queued"}),
    )
    assert (
        client.post(
            "/prompt-enhancements",
            json=input_data(images=[{"ref": "assets/frame.png", "role": role} for role in roles]),
        ).status_code
        == 200
    )
    assert seen[0]["ratio"] == "adaptive"
    assert [item["role"] for item in seen[0]["content"][1:]] == roles


@pytest.mark.parametrize(
    "roles",
    [
        ["first_frame", "reference_image"],
        ["first_frame", "first_frame"],
        ["last_frame", "last_frame"],
        ["reference_image"] * 10,
    ],
)
def test_invalid_image_mode_never_submits(client, monkeypatch, roles):
    monkeypatch.setattr(h3, "_request", lambda *a, **kw: pytest.fail("invalid media submitted"))
    assert (
        client.post(
            "/prompt-enhancements",
            json=input_data(images=[{"ref": "assets/frame.png", "role": role} for role in roles]),
        ).status_code
        == 422
    )


@pytest.mark.parametrize("failure", ["missing", "dimensions", "upload", "total_size"])
def test_image_failure_never_falls_back_to_text_or_creates_billed_task(
    client, monkeypatch, failure
):
    def read(ref):
        if failure == "missing":
            raise ValueError("图片已丢失")
        return (
            image_uri(128, 128)
            if failure == "dimensions"
            else (image_uri()[0], 16 * 1024 * 1024) if failure == "total_size" else image_uri()
        )

    def upload(*a):
        if failure == "upload":
            raise RuntimeError("临时上传失败")
        return "https://media.example/ready.png"

    monkeypatch.setattr(h3, "image_data", read)
    monkeypatch.setattr(h3, "upload_to_jiucaihezi", upload)
    monkeypatch.setattr(
        h3, "_request", lambda *a, **kw: pytest.fail("image failure must not submit")
    )
    data = input_data(images=[{"ref": "assets/one.png"}, {"ref": "assets/two.png"}])
    job = client.post("/prompt-enhancements", json=data).json()
    state = client.get("/prompt-enhancements/" + job["job_id"]).json()
    assert state["status"] == "failed" and not state["response_id"]
    assert "准备失败" in state["error"]


def test_query_rate_limit_returns_backoff(client, monkeypatch):
    monkeypatch.setattr(
        h3,
        "_request",
        lambda method, *a, **kw: (
            response({"id": "resp_backoff", "status": "queued"})
            if method == "POST"
            else response({"error": {"message": "slow down"}}, 429)
        ),
    )
    job = client.post("/prompt-enhancements", json=input_data()).json()
    assert client.get("/prompt-enhancements/" + job["job_id"]).json()["retry_after"] == 10
