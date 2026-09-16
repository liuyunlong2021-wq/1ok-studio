const { execSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const venv = path.join(root, '.venv');
const isWin = process.platform === 'win32';

const venvPython = isWin
  ? path.join(venv, 'Scripts', 'python.exe')
  : path.join(venv, 'bin', 'python');

const requirements = path.join(root, 'requirements.txt');
// Stamp of the requirements last installed here, so a repeat `npm run dev`
// costs nothing while an edited requirements.txt (or a venv made by hand, like
// the uv one) still heals itself.
const stampFile = path.join(venv, '.requirements-stamp');
const requirementsHash = fs.existsSync(requirements)
  ? crypto.createHash('sha256').update(fs.readFileSync(requirements)).digest('hex')
  : null;

console.log('[setup] Checking environment...');

// 1. Setup Python venv if missing
if (!fs.existsSync(venv)) {
  console.log('[setup] Creating Python virtual environment...');
  // `python3` is a POSIX name — on Windows the launcher is `py`, and a bare
  // `python` there can resolve to the Microsoft Store stub, which exits 9009
  // and creates nothing. Try the platform's real launchers in order rather
  // than leaning on a shell `||`.
  const launchers = isWin
    ? [['py', ['-3']], ['python', []]]
    : [['python3', []], ['python', []]];

  for (const [command, prefix] of launchers) {
    try {
      execFileSync(command, [...prefix, '-m', 'venv', '.venv'], { stdio: 'inherit', cwd: root });
      break;
    } catch {
      // Try the next launcher.
    }
  }

  if (!fs.existsSync(venvPython)) {
    console.error('[setup] Could not create .venv. Install Python 3.11+ and re-run `npm run dev`.');
    process.exit(1);
  }
}

// 2. Install Python dependencies.
//
// This used to run `pip install -e .`, which installs none of what the app
// needs: every dependency lives in requirements.txt, and pyproject.toml has no
// [project] table at all. A freshly created venv therefore came up without
// fastapi and the backend died on import.
const installedStamp = fs.existsSync(stampFile)
  ? fs.readFileSync(stampFile, 'utf8').trim()
  : null;

if (requirementsHash && installedStamp !== requirementsHash) {
  console.log('[setup] Installing Python dependencies...');
  try {
    execFileSync(venvPython, ['-m', 'pip', 'install', '-r', requirements], {
      stdio: 'inherit',
      cwd: root,
    });
    // pytest is not declared in requirements.txt and nothing else installs it.
    execFileSync(venvPython, ['-m', 'pip', 'install', 'pytest'], { stdio: 'inherit', cwd: root });
    fs.writeFileSync(stampFile, requirementsHash);
  } catch (e) {
    console.error('[setup] Failed to install Python dependencies:', e.message);
    process.exit(1);
  }
}

// 2. Setup Frontend dependencies if missing
const frontendModules = path.join(root, 'frontend', 'node_modules');
if (!fs.existsSync(frontendModules)) {
  console.log('[setup] Installing frontend dependencies...');
  execSync('npm install', { stdio: 'inherit', cwd: path.join(root, 'frontend') });
}

// 3. Pre-download Demucs model (required for dub workflow)
//
// Run it through the venv interpreter. The old `python -c ...` string went to
// whatever `python` the PATH happened to offer — not necessarily the venv — so
// it either warmed the wrong environment or failed outright with no useful
// message.
console.log('[setup] Checking Demucs model...');
try {
  execFileSync(
    venvPython,
    [
      '-c',
      "from demucs.pretrained import get_model; get_model('htdemucs'); print('[setup] Demucs htdemucs model ready.')",
    ],
    { stdio: 'inherit', cwd: root, timeout: 180000 }
  );
} catch (e) {
  console.warn('[setup] ⚠️  Demucs model download failed. Dubbing feature will attempt download on first use.');
  console.warn(
    `[setup]    If you are behind a firewall, manually run: ${venvPython} -c "from demucs.pretrained import get_model; get_model('htdemucs')"`
  );
}

console.log('[setup] Done.');
