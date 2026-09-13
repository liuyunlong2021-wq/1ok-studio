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

const backend = spawn(pythonPath, [
  '-m', 'uvicorn', 'src.apps.comic_gen.api:app',
  '--reload', '--port', '17177', '--host', '0.0.0.0'
], {
  stdio: 'inherit',
  cwd: dataDir,
  env
});

backend.on('exit', (code) => process.exit(code || 0));
