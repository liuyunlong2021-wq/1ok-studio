"""Standalone FastAPI entry point for the Tauri sidecar."""

import argparse


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=17177)
    args = parser.parse_args()

    import uvicorn
    from src.utils import ensure_user_data_dir

    # 必须在 import api 之前。api.py 的模块体里就执行
    # `os.makedirs("output", ...)`，用的是当时的 cwd；而 Finder / `open`
    # 启动的 app，cwd 是只读的 `/`（macOS 封印系统卷），于是整个 sidecar
    # 起不来。api.py 明确约定「启动器负责先 chdir 到这里」，这就是那次 chdir。
    ensure_user_data_dir()

    from src.apps.comic_gen.api import app
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
