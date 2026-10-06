"""Prepare required desktop resources on the build machine, never on user startup."""
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
STAGE = ROOT / 'build' / 'release-runtime'
RESOURCES = ROOT / 'src-tauri' / 'runtime'
REQUIRED = {
    'fastapi': 'fastapi', 'uvicorn': 'uvicorn', 'pydantic': 'pydantic',
    'python-multipart': 'multipart', 'requests': 'requests', 'httpx': 'httpx',
    'Pillow': 'PIL', 'openai': 'openai', 'dashscope': 'dashscope',
    'PyYAML': 'yaml', 'PyJWT': 'jwt', 'defusedxml': 'defusedxml',
    'python-dotenv': 'dotenv', 'soundfile': 'soundfile',
    'demucs': 'demucs', 'torch': 'torch', 'torchaudio': 'torchaudio',
    'pyinstaller': 'PyInstaller',
}


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def main():
    versions = {}
    missing = []
    for distribution, module in REQUIRED.items():
        if importlib.util.find_spec(module) is None:
            missing.append(distribution)
            continue
        versions[distribution] = importlib.metadata.version(distribution)
    if missing:
        raise SystemExit('Release environment missing: ' + ', '.join(missing))

    binaries = {}
    for name in ('ffmpeg', 'ffprobe'):
        filename = name + ('.exe' if os.name == 'nt' else '')
        configured = os.environ.get(f'ONEOK_{name.upper()}_PATH')
        source = Path(configured) if configured else ROOT / 'bin' / filename
        if not source.is_file():
            raise SystemExit(f'Missing release {filename}. Provide bin/{filename} or ONEOK_{name.upper()}_PATH. System PATH is deliberately not used.')
        if platform.system() == 'Darwin':
            subprocess.run([sys.executable, str(ROOT / 'scripts/check_macos_compat.py'),
                            '--max', os.environ.get('MACOSX_DEPLOYMENT_TARGET', '11.0'), str(source)], check=True)
        subprocess.run([str(source.resolve()), '-version'], check=True, stdout=subprocess.DEVNULL, timeout=15)
        if name == 'ffmpeg':
            encoders = subprocess.run([str(source.resolve()), '-encoders'], check=True,
                                      capture_output=True, text=True, timeout=15).stdout
            available = {line.split()[1] for line in encoders.splitlines() if len(line.split()) >= 2}
            required_encoders = {'libx264', 'aac'}
            if not required_encoders.issubset(available):
                raise SystemExit('Release FFmpeg missing composition encoders: '
                                 + ', '.join(sorted(required_encoders - available)))
        target = STAGE / 'bin' / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        target.chmod(0o755)
        binaries[filename] = digest(target)

    # Offline model repository: no torch/HuggingFace download at first use.
    import yaml
    demucs_root = Path(importlib.util.find_spec('demucs').origin).parent
    bag_file = demucs_root / 'remote' / 'htdemucs.yaml'
    model_signatures = yaml.safe_load(bag_file.read_text())['models']
    supplied = os.environ.get('ONEOK_DEMUCS_MODEL_REPO')
    source_repo = Path(supplied) if supplied else ROOT / 'bin' / 'demucs-models'
    models = {}
    target_repo = RESOURCES / 'models' / 'demucs'
    model_files = []
    for signature in model_signatures:
        candidates = sorted(source_repo.glob(f'{signature}-*.th'))
        if len(candidates) != 1:
            raise SystemExit(f'Missing/ambiguous Demucs checkpoint {signature} in {source_repo}. Provide ONEOK_DEMUCS_MODEL_REPO on the build machine.')
        source = candidates[0]
        checksum = digest(source)
        expected = source.stem.split('-', 1)[1]
        if not checksum.startswith(expected):
            raise SystemExit(f'Demucs checkpoint checksum mismatch: {source.name}')
        model_files.append(source)
        models[source.name] = checksum
    target_repo.mkdir(parents=True, exist_ok=True)
    for obsolete in target_repo.glob('*.th'):
        if obsolete.name not in models:
            obsolete.unlink()
    for source in model_files:
        shutil.copy2(source, target_repo / source.name)
    shutil.copy2(bag_file, target_repo / 'htdemucs.yaml')

    version = json.loads((ROOT / 'package.json').read_text())['version']
    manifest = {'app_version': version, 'platform': platform.system(), 'architecture': platform.machine(),
                'python': platform.python_version(), 'dependencies': versions,
                'media_binaries': binaries, 'demucs_models': models}
    RESOURCES.mkdir(parents=True, exist_ok=True)
    (RESOURCES / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    # Capture all transitive versions as a build artifact for reproducibility.
    locked = sorted(f'{item.metadata["Name"]}=={item.version}' for item in importlib.metadata.distributions())
    (RESOURCES / 'python-requirements.lock').write_text('\n'.join(locked) + '\n')
    print('Release runtime prepared: media tools, offline Demucs models, dependency manifest.')


if __name__ == '__main__':
    main()
