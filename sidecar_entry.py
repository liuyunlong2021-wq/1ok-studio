"""Standalone FastAPI entry point for the Tauri sidecar."""

import argparse


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=17177)
    args = parser.parse_args()

    import uvicorn
    from src.utils import ensure_user_data_dir
    from src.apps.comic_gen.api import app

    # Anchors the cwd to the user data dir; api.py imports the same helper, so
    # this is just an explicit statement of where the data lives.
    ensure_user_data_dir()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
