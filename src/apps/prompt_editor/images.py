"""Resolve application media for vision; never send a local filename as image content."""
import base64
import io
import ipaddress
import os
import socket
from urllib.parse import urlparse, unquote

import httpx
from PIL import Image
from fastapi import HTTPException

MAX_IMAGES = 8
MAX_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 30 * 1024 * 1024


def image_data(reference):
    raw = reference.strip().replace('\\', '/')
    parsed = urlparse(raw)
    if parsed.scheme in ('http', 'https') and parsed.hostname in ('localhost', '127.0.0.1'):
        raw = unquote(parsed.path)
        parsed = urlparse(raw)
    if parsed.scheme in ('http', 'https'):
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443)
        if any(not ipaddress.ip_address(address[4][0]).is_global for address in addresses):
            raise ValueError('远程图片地址不可访问，请先本地上传')
        with httpx.stream('GET', raw, timeout=30, follow_redirects=False, trust_env=False) as response:
            response.raise_for_status()
            data = bytearray()
            for chunk in response.iter_bytes():
                data.extend(chunk)
                if len(data) > MAX_BYTES:
                    raise ValueError('单张图片超过 10MB')
        data = bytes(data)
    else:
        for prefix in ('/files/outputs/', '/files/output/', '/files/', 'files/', 'outputs/', 'output/'):
            if raw.startswith(prefix):
                raw = raw[len(prefix):]
                break
        root = os.path.realpath('output')
        path = os.path.realpath(raw if os.path.isabs(raw) else os.path.join(root, raw))
        if not path.startswith(root + os.sep) or not os.path.isfile(path):
            raise ValueError('图片已丢失或不在应用素材目录，请重新上传')
        if os.path.getsize(path) > MAX_BYTES:
            raise ValueError('单张图片超过 10MB')
        with open(path, 'rb') as handle:
            data = handle.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('单张图片超过 10MB')
    with Image.open(io.BytesIO(data)) as image:
        mime = {'PNG': 'image/png', 'JPEG': 'image/jpeg', 'WEBP': 'image/webp'}.get(image.format)
        if not mime or image.width * image.height > 40000000:
            raise ValueError('请使用不超过 4000 万像素的 PNG、JPEG 或 WebP 图片')
        image.verify()
    return 'data:' + mime + ';base64,' + base64.b64encode(data).decode('ascii'), len(data)


def vision_content(images, text):
    content = [{'type': 'text', 'text': text}]
    total = 0
    for index, image in enumerate(images, 1):
        try:
            uri, size = image_data(image.ref)
            total += size
            if total > MAX_TOTAL_BYTES:
                raise ValueError('图片总量超过 30MB')
        except Exception as exc:
            raise HTTPException(400, f'Image {index} 读取失败：{exc}') from exc
        content.extend([{'type': 'text', 'text': f'Image {index}：{image.name}\n{image.description}'},
                        {'type': 'image_url', 'image_url': {'url': uri}}])
    return content
