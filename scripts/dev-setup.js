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

// 把包装进 venv。
//
// **不能假定 `pip` 存在**：本仓库的 .venv 可以由 uv 创建，而 uv venv 默认不装
// pip。这里原来直接 `python -m pip install`，于是在 uv 环境里只要你动过
// requirements.txt，重跑 `npm run dev` 就炸在 “No module named pip”。校验标记
// 本来是为了「改动 requirements 就自动重装」，结果重装这条路是坏的。
//
// 依次尝试：pip → uv pip → ensurepip 引导出 pip；三个都失败才算真失败。
function installIntoVenv(packages) {
  const works = (command, args) => {
    try {
      execFileSync(command, args, { stdio: 'ignore', cwd: root });
      return true;
    } catch {
      return false;
    }
  };

  const installWithPip = () =>
    execFileSync(venvPython, ['-m', 'pip', 'install', ...packages], {
      stdio: 'inherit',
      cwd: root,
    });
  const installWithUv = () =>
    execFileSync('uv', ['pip', 'install', '--python', venvPython, ...packages], {
      stdio: 'inherit',
      cwd: root,
    });

  // 先探测、再选路，而不是「试了再说」：失败的尝试会把 “No module named pip”
  // 打到控制台，看起来像报错 —— 而后面其实成功了。这种噪声足以让人以为安装挂了。
  if (works(venvPython, ['-m', 'pip', '--version'])) {
    installWithPip();
    return 'pip';
  }
  if (works('uv', ['--version'])) {
    installWithUv();
    return 'uv pip';
  }
  execFileSync(venvPython, ['-m', 'ensurepip', '--upgrade'], { stdio: 'inherit', cwd: root });
  installWithPip();
  return 'ensurepip + pip';
}

if (requirementsHash && installedStamp !== requirementsHash) {
  console.log('[setup] Installing Python dependencies...');
  try {
    const via = installIntoVenv(['-r', requirements]);
    // pytest is not declared in requirements.txt and nothing else installs it.
    installIntoVenv(['pytest']);
    fs.writeFileSync(stampFile, requirementsHash);
    console.log(`[setup] Python dependencies installed (via ${via}).`);
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
