const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const isWin = os.platform() === 'win32';
const pythonPath = isWin
  ? path.join(__dirname, '..', '.venv', 'Scripts', 'python')
  : path.join(__dirname, '..', '.venv', 'bin', 'python');

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
  '--reload', '--port', '17177', '--host', '0.0.0.0',
  'src.apps.comic_gen.api:app'
], {
  stdio: 'inherit',
  cwd: dataDir,
  env
});

backend.on('exit', (code) => process.exit(code || 0));
