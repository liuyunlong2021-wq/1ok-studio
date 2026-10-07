const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const isWin = os.platform() === 'win32';

/**
 * 解释器候选：显式环境变量 → 仓库自己的 venv → PATH 上的 python3。
 *
 * 原来只写 `.venv/bin/python`，而本机根本没有这个 venv（只有
 * `.venv-release-macos11`），于是 `npm run tauri:dev` 拉起的后端一启动就
 * ENOENT，看起来像「后端起不来」而不是「解释器路径写死了」。
 */
function resolvePython() {
  if (process.env.ONEOKSTUDIO_PYTHON) return process.env.ONEOKSTUDIO_PYTHON;
  const venvPython = isWin
    ? path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '..', '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) return venvPython;
  return isWin ? 'python' : 'python3';
}

const pythonPath = resolvePython();
console.log(`[backend] python: ${pythonPath}`);

// The backend resolves every runtime path relatively (output/projects.json,
// output/assets/..., the /files mounts), so the launcher has to point cwd at
// the user data dir. Inheriting the repo root here used to create a second,
// invisible projects.json that the packaged app never saw.
const dataDir = process.env.ONEOKSTUDIO_DATA_DIR
  ? path.resolve(process.env.ONEOKSTUDIO_DATA_DIR)
  : path.join(os.homedir(), '.1okstudio');
fs.mkdirSync(dataDir, { recursive: true });

const env = {
  ...process.env,
  NO_PROXY: '*.aliyuncs.com,localhost,127.0.0.1',
  no_proxy: '*.aliyuncs.com,localhost,127.0.0.1'
};

const repoRoot = path.join(__dirname, '..');
const backend = spawn(pythonPath, [
  '-m', 'uvicorn',
  // cwd 是数据目录，src.* 只能靠 --app-dir 暴露给 uvicorn 的 import。
  // start_backend.sh 一直是这么做的；这里当初只加了 cwd 忘了这个 flag，
  // 于是 `npm run dev` 的后端从那时起就起不来（reload 子进程 ImportError）。
  '--app-dir', repoRoot,
  // cwd 是数据目录 ⇒ 不指定的话 --reload 只盯数据目录，改 src/ 永远不重启。
  '--reload-dir', repoRoot,
  '--reload', '--port', process.env.NEXT_PUBLIC_BACKEND_PORT || '17178', '--host', '0.0.0.0',
  'src.apps.comic_gen.api:app'
], {
  stdio: 'inherit',
  cwd: dataDir,
  env
});

backend.on('exit', (code) => process.exit(code || 0));
