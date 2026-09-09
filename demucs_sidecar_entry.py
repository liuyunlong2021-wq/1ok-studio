"""On-demand Demucs helper for the packaged desktop app."""

import argparse


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    import demucs.separate

    demucs.separate.main([
        "--two-stems", "vocals",
        "-n", "htdemucs",
        "--out", args.out,
        args.input,
    ])


if __name__ == "__main__":
    main()
