"""On-demand Demucs helper for the packaged desktop app."""

import argparse
from pathlib import Path
import sys


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    import demucs.separate

    model_args = []
    if getattr(sys, 'frozen', False):
        model_repo = Path(sys.executable).parent / 'runtime' / 'models' / 'demucs'
        if not (model_repo / 'htdemucs.yaml').is_file():
            raise RuntimeError('Bundled Demucs model repository is missing; reinstall the application.')
        model_args = ['--repo', str(model_repo)]
        # The backend supplies its bundled media-tool path to child processes.
    demucs.separate.main(model_args + [
        "--two-stems", "vocals",
        "-n", "htdemucs",
        "--out", args.out,
        args.input,
    ])


if __name__ == "__main__":
    main()
