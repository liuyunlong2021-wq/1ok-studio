"""图片生成适配器的抽象基类。

目录里只有韭菜盒子一家，唯一实现是 `jiucaihezi.JiucaiheziImageModel`。这个文件
原来还挂着 DashScope 的 `WanxImageModel`（占了它 675 行里的绝大部分），已随家族
收敛删除。
"""
from abc import ABC, abstractmethod
from typing import Any, Dict, Tuple


class ImageGenModel(ABC):
    """Abstract base class for image generation models."""

    def __init__(self, config: Dict[str, Any]):
        self.config = config

    @abstractmethod
    def generate(self, prompt: str, output_path: str, **kwargs) -> Tuple[str, float]:
        """
        Generates an image from a prompt.

        Args:
            prompt: The input text prompt.
            output_path: The path to save the generated image.
            **kwargs: Additional arguments.

        Returns:
            A tuple containing:
            - The path to the generated image file.
            - The duration of the API generation process in seconds.
        """
        pass
