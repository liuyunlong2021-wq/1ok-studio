"""动参（motion reference）视频生成。

目录里只有韭菜盒子一家，所以这里直接用一个 JiucaiheziVideoModel，不再按
provider 分派。

原来这个类还挂着 `generate_clip(frame)` 和 `generate_video(script)`，以及
`WanxModel` 适配器。`generate_video` 在 `VideoGenerator` 上根本不存在
（`pipeline.generate_video` 调用它会 AttributeError），而且那个端点和它的前端
客户端方法都是零调用，于是一并删除。逐镜头出片走的是
`pipeline.create_video_task` + `process_video_task` 那条任务链。
"""
import os
import uuid
from typing import Dict, Any

from ...models.jiucaihezi import JiucaiheziVideoModel
from ...utils import get_logger
from ...utils.media_refs import to_media_ref

logger = get_logger(__name__)


class VideoGenerator:
    def __init__(self, config: Dict[str, Any] = None):
        self.config = config or {}
        self.model = JiucaiheziVideoModel(self.config.get('model', {}))
        self.output_dir = self.config.get('output_dir', 'output/video')

    def generate_i2v(self, image_url: str, prompt: str, duration: int = 5, audio_url: str = None) -> Dict[str, Any]:
        """
        Generate Image-to-Video for motion reference.

        Args:
            image_url: Source image URL (can be local path or remote URL)
            prompt: Motion description prompt
            duration: Video duration in seconds (default 5)
            audio_url: Optional audio URL to drive lip-sync

        Returns:
            Dict with video_url key containing the generated video URL
        """
        logger.info(f"Generating I2V motion reference: prompt={prompt[:50]}..., duration={duration}")

        # Handle local file paths
        img_path = None
        if image_url and not image_url.startswith("http"):
            potential_path = os.path.join("output", image_url)
            if os.path.exists(potential_path):
                img_path = os.path.abspath(potential_path)
            elif os.path.exists(image_url):
                img_path = image_url

        try:
            output_filename = f"motion_ref_{uuid.uuid4().hex[:8]}.mp4"
            output_path = os.path.join(self.output_dir, output_filename)
            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            video_path, _ = self.model.generate(
                prompt=prompt,
                output_path=output_path,
                img_path=img_path,
                img_url=image_url if not img_path else None,
                duration=duration,
                audio_url=audio_url,
            )

            video_url = to_media_ref(os.path.relpath(output_path, "output"))

            return {"video_url": video_url}

        except Exception as e:
            logger.error(f"Failed to generate I2V motion reference: {e}")
            raise
