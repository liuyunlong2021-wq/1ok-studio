"""Standalone FastAPI entry point for the Tauri sidecar."""

import argparse
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=17177)
    args = parser.parse_args()

    data_dir = Path(os.environ.get("LUMENX_DATA_DIR", "~/.lumen-x")).expanduser()
    data_dir.mkdir(parents=True, exist_ok=True)
    os.chdir(data_dir)

    import uvicorn
    from src.apps.comic_gen.api import app

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
