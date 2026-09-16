"""Playground service layer -- orchestrates AI generation by delegating to model adapters.

目录里只有韭菜盒子一家，所以图片和视频都只用 `JiucaiheziImageModel` /
`JiucaiheziVideoModel`，不再按 model_id 分派。
"""

import os
import shutil
import uuid
import requests
from datetime import datetime, timezone
from typing import Optional

from .models import (
    GenerateRequest,
    PlaygroundGeneration,
    PlaygroundMode,
    PlaygroundOutput,
)
from .storage import PlaygroundStorage
from ...utils import get_logger
from ...utils.media_refs import to_media_ref

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# Output directories
# ---------------------------------------------------------------------------
IMAGE_OUTPUT_DIR = os.path.join("output", "playground", "images")
VIDEO_OUTPUT_DIR = os.path.join("output", "playground", "videos")
AUDIO_OUTPUT_DIR = os.path.join("output", "playground", "audio")


class PlaygroundService:
    """High-level service that creates generation records and delegates to
    the correct model adapter for execution."""

    def __init__(self, storage: PlaygroundStorage):
        self.storage = storage
        # Lazy-initialised model instances (cached for the lifetime of the service)
        self._jiucaihezi_video_model = None
        self._jiucaihezi_image_model = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def create_generation(self, request: GenerateRequest) -> PlaygroundGeneration:
        """Create a :class:`PlaygroundGeneration` record with *status=pending*,
        persist it via storage, and return it."""
        gen = PlaygroundGeneration(
            id=str(uuid.uuid4()),
            mode=request.mode,
            model_id=request.model_id,
            prompt=request.prompt,
            negative_prompt=request.negative_prompt,
            input_media=request.input_media or [],
            parameters=request.parameters or {},
            batch_size=request.batch_size or 1,
            outputs=[],
            status="pending",
            error=None,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        self.storage.add_generation(gen)
        return gen

    def process_generation(self, generation_id: str) -> None:
        """Execute the actual generation.  Intended to run in a background
        thread -- all calls are synchronous (blocking)."""
        gen = self.storage.get_generation(generation_id)
        if gen is None:
            logger.error("Generation %s not found", generation_id)
            return

        # Mark processing
        gen.status = "processing"
        self.storage.update_generation(gen)

        try:
            mode = gen.mode
            if mode in (PlaygroundMode.T2I, PlaygroundMode.I2I):
                self._process_image_generation(gen)
            elif mode in (PlaygroundMode.T2V, PlaygroundMode.I2V, PlaygroundMode.R2V, PlaygroundMode.V2V):
                self._process_video_generation(gen)
            elif mode in (PlaygroundMode.T2A, PlaygroundMode.R2A):
                self._process_audio_generation(gen)
            else:
                raise ValueError(f"Unsupported playground mode: {mode}")

            gen.status = "completed"
        except Exception as exc:
            logger.exception("Generation %s failed", generation_id)
            gen.status = "failed"
            gen.error = str(exc)

        self.storage.update_generation(gen)

    def _process_audio_generation(self, gen: PlaygroundGeneration) -> None:
        os.makedirs(AUDIO_OUTPUT_DIR, exist_ok=True)
        if gen.batch_size != 1:
            gen.batch_size = 1
        ext = (gen.parameters.get("response_format") or "mp3").lower().replace("ogg_opus", "ogg")
        out_path = os.path.join(AUDIO_OUTPUT_DIR, f"{gen.mode.value}_{gen.id}.{ext}")

        # t2a 无参考音频，r2a 带（0–3 段）—— 同一个模型，参考音频可选。
        from ...models.jiucaihezi import generate_audio

        generate_audio(
            prompt=gen.prompt,
            output_path=out_path,
            model_name=gen.model_id or None,
            reference_audio_urls=list(gen.input_media) if gen.mode == PlaygroundMode.R2A else [],
            response_format=gen.parameters.get("response_format", "mp3"),
        )

        # ``out_path`` is a filesystem path (os.path.join, so backslashes on
        # Windows); the stored ref must stay POSIX because it is also a URL-ish
        # identifier — see models.py, "relative to output/". Storing the raw
        # path made the frontend's /^output\// strip miss on Windows and every
        # generated file 404 behind /files/output/output/...
        gen.outputs.append(
            PlaygroundOutput(
                id=str(uuid.uuid4()),
                media_path=to_media_ref(out_path),
                media_type="audio",
            )
        )
        self.storage.update_generation(gen)

    def save_to_library(self, generation_id: str, output_id: str, category: str = "general") -> bool:
        """Copy a generated output to ``output/assets/{category}/`` and flag
        :pyattr:`PlaygroundOutput.saved_to_library` = True."""
        gen = self.storage.get_generation(generation_id)
        if gen is None:
            logger.warning("save_to_library: generation %s not found", generation_id)
            return False

        target_output: Optional[PlaygroundOutput] = None
        for out in gen.outputs:
            if out.id == output_id:
                target_output = out
                break
        if target_output is None:
            logger.warning("save_to_library: output %s not found in generation %s", output_id, generation_id)
            return False

        # media_path is stored as e.g. "output/playground/images/t2i_xxx_0.png"
        # Normalise: try as-is first, then strip leading "output/" and re-join
        src_path = target_output.media_path
        if not os.path.isfile(src_path):
            alt = os.path.join("output", target_output.media_path)
            if os.path.isfile(alt):
                src_path = alt
        if not os.path.isfile(src_path):
            logger.error("save_to_library: source file not found: %s", target_output.media_path)
            return False

        dest_dir = os.path.join("output", "assets", category)
        os.makedirs(dest_dir, exist_ok=True)

        dest_path = os.path.join(dest_dir, os.path.basename(src_path))
        shutil.copy2(src_path, dest_path)
        logger.info("Saved output %s to library: %s", output_id, dest_path)

        # Wave A (shared asset pool): besides copying the file, register a real
        # global library asset record so the output is curatable through the
        # /library/assets CRUD. category -> asset_type mapping; anything
        # unknown (incl. the "general" default) falls back to "prop".
        asset_type = self._category_to_asset_type(category)
        prompt_text = (gen.prompt or "").strip()
        asset_name = prompt_text[:40] or os.path.splitext(os.path.basename(dest_path))[0]
        try:
            # Deferred import: comic_gen.api owns the live ComicGenPipeline
            # singleton -- the same instance that backs the /library/assets
            # CRUD endpoints, so the new asset is immediately visible there.
            # A top-level import would create a cycle (comic_gen.api imports the
            # playground router at module load), so we import lazily at call
            # time when both modules are fully initialised.
            from ..comic_gen.api import pipeline as comic_pipeline

            asset = comic_pipeline.create_library_asset(
                asset_type,
                {
                    "name": asset_name,
                    "description": prompt_text,
                    # Point the library record at the freshly-copied file.
                    "image_url": dest_path,
                },
            )
            logger.info(
                "save_to_library: created global %s asset %s from output %s",
                asset_type,
                getattr(asset, "id", "?"),
                output_id,
            )
        except Exception:
            logger.exception(
                "save_to_library: failed to register global library asset for output %s",
                output_id,
            )
            return False

        target_output.saved_to_library = True
        self.storage.update_generation(gen)
        return True

    # ------------------------------------------------------------------
    # Image generation (t2i / i2i)
    # ------------------------------------------------------------------

    def _process_image_generation(self, gen: PlaygroundGeneration) -> None:
        os.makedirs(IMAGE_OUTPUT_DIR, exist_ok=True)

        failures = []

        for idx in range(gen.batch_size):
            ext = "png"
            out_filename = f"{gen.mode.value}_{gen.id}_{idx}.{ext}"
            out_path = os.path.join(IMAGE_OUTPUT_DIR, out_filename)

            try:
                # 目录里只有韭菜盒子一家，不再按 model_id 分派到已删除的适配器。
                # 已下线的旧 id 不本地猜测，交给网关按模型名报错。
                self._generate_image_jiucaihezi(gen, out_path)

                output_entry = PlaygroundOutput(
                    id=str(uuid.uuid4()),
                    media_path=to_media_ref(out_path),
                    media_type="image",
                )
                gen.outputs.append(output_entry)
                self.storage.update_generation(gen)
            except Exception as exc:
                logger.error("Image generation %s batch %d failed: %s", gen.id, idx, exc)
                failures.append(str(exc))

        if failures and not gen.outputs:
            raise RuntimeError(f"All {len(failures)} batch items failed: {failures[0]}")

    def _generate_image_jiucaihezi(self, gen: PlaygroundGeneration, out_path: str) -> None:
        from ...models.jiucaihezi import JiucaiheziImageModel

        if self._jiucaihezi_image_model is None:
            self._jiucaihezi_image_model = JiucaiheziImageModel({})
        kwargs = {
            "model_name": gen.model_id,
            "size": gen.parameters.get("size", "1024x1024"),
            "n": 1,
        }
        if gen.mode == PlaygroundMode.I2I:
            kwargs["ref_image_paths"] = list(gen.input_media)
        self._jiucaihezi_image_model.generate(gen.prompt, out_path, **kwargs)

    # ------------------------------------------------------------------
    # Video generation (t2v / i2v / r2v / v2v)
    # ------------------------------------------------------------------

    def _process_video_generation(self, gen: PlaygroundGeneration) -> None:
        os.makedirs(VIDEO_OUTPUT_DIR, exist_ok=True)

        failures = []

        for idx in range(gen.batch_size):
            out_filename = f"{gen.mode.value}_{gen.id}_{idx}.mp4"
            out_path = os.path.join(VIDEO_OUTPUT_DIR, out_filename)

            try:
                # 同图片侧：目录里只有韭菜盒子一家。
                self._generate_video_jiucaihezi(gen, out_path)

                output_entry = PlaygroundOutput(
                    id=str(uuid.uuid4()),
                    media_path=to_media_ref(out_path),
                    media_type="video",
                )
                gen.outputs.append(output_entry)
                self.storage.update_generation(gen)
            except Exception as exc:
                logger.error("Video generation %s batch %d failed: %s", gen.id, idx, exc)
                failures.append(str(exc))

        if failures and not gen.outputs:
            raise RuntimeError(f"All {len(failures)} batch items failed: {failures[0]}")

    # -- adapter delegate -------------------------------------------------

    def _generate_video_jiucaihezi(self, gen: PlaygroundGeneration, out_path: str) -> None:
        from ...models.jiucaihezi import JiucaiheziVideoModel

        if self._jiucaihezi_video_model is None:
            self._jiucaihezi_video_model = JiucaiheziVideoModel({})
        img_path, img_url = self._resolve_first_input_media(gen)
        self._jiucaihezi_video_model.generate(
            gen.prompt,
            out_path,
            model_name=gen.model_id,
            duration=gen.parameters.get("duration"),
            resolution=gen.parameters.get("resolution"),
            img_path=img_path,
            img_url=img_url,
            ratio=gen.parameters.get("ratio") or gen.parameters.get("aspect_ratio") or "16:9",
            ref_image_urls=list(gen.input_media) if gen.mode == PlaygroundMode.R2V else [],
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _category_to_asset_type(category: Optional[str]) -> str:
        """Map a Playground save category to a global-library asset_type.

        Known categories (``character`` / ``scene`` / ``prop``) pass through;
        everything else -- including the ``"general"`` default, empty string,
        or ``None`` -- falls back to ``"prop"``."""
        normalized = (category or "").strip().lower()
        if normalized in ("character", "scene", "prop"):
            return normalized
        return "prop"

    @staticmethod
    def _resolve_first_input_media(gen: PlaygroundGeneration):
        """Return ``(img_path, img_url)`` for the first entry in
        :pyattr:`input_media`.  Local files are returned as *img_path*;
        remote URLs as *img_url*."""
        if not gen.input_media:
            return None, None

        first = gen.input_media[0]
        if first.startswith(("http://", "https://")):
            return None, first

        # Try as-is, then relative to output/
        if os.path.exists(first):
            return first, None
        candidate = os.path.join("output", first)
        if os.path.exists(candidate):
            return candidate, None

        # Fall back to treating it as a URL-like reference
        return None, first
