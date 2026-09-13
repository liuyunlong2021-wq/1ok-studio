import logging
import sys
import os
from logging.handlers import RotatingFileHandler

# Per-file size + backup count for the rotating log handler. Defaults
# bound the on-disk footprint to ~20 MB (5 MB × 1 active + 3 backups).
# Generous enough that a single bug-storm session lands in one file but
# tight enough that long-running desktop installs don't accrete GBs of
# logs over months.
_LOG_MAX_BYTES = 5 * 1024 * 1024
_LOG_BACKUP_COUNT = 3

# User data directory for logs, config, and data
def get_user_data_dir() -> str:
    """Returns the user data directory for the application.

    Honors the ONEOKSTUDIO_DATA_DIR environment variable when set;
    otherwise defaults to ~/.1okstudio.
    """
    env_dir = os.environ.get("ONEOKSTUDIO_DATA_DIR", "").strip()
    if env_dir:
        return os.path.expanduser(env_dir)
    return os.path.join(os.path.expanduser("~"), ".1okstudio")


def get_log_dir() -> str:
    """Returns the log directory.

    Honors the ONEOKSTUDIO_LOG_DIR environment variable when set; otherwise
    defaults to <user_data_dir>/logs.
    """
    env_log_dir = os.environ.get("ONEOKSTUDIO_LOG_DIR", "").strip()
    log_dir = os.path.expanduser(env_log_dir) if env_log_dir else os.path.join(get_user_data_dir(), "logs")
    os.makedirs(log_dir, exist_ok=True)
    return log_dir


def ensure_user_data_dir() -> str:
    """Resolve the user data dir, create it, and make it the process cwd.

    Every runtime path in the backend is relative -- ``output/projects.json``,
    ``output/assets/...``, the ``/files`` StaticFiles mounts -- so which physical
    ``output/`` you got depended on which launcher started the process:

      * ``npm run dev`` / ``start_backend.sh`` / ``tauri dev`` inherited the repo
        root as cwd and wrote to ``<repo>/output``.
      * the packaged app went through ``sidecar_entry.py``, which chdir'd to
        ``~/.1okstudio``, and wrote there.

    The two roots silently diverged: projects created under one launcher were
    invisible under the other, and two concurrent backends could overwrite each
    other's full-file saves. Anchoring cwd here (called once at API import)
    removes the drift, so no code below depends on the inherited cwd.
    """
    data_dir = get_user_data_dir()
    os.makedirs(data_dir, exist_ok=True)
    os.chdir(data_dir)
    return data_dir


def setup_logging(level=logging.INFO, log_file=None):
    """Configures the logging system."""
    handlers = []
    
    # If no log file specified, use default in user directory
    if log_file is None:
        try:
            log_file = os.path.join(get_log_dir(), "app.log")
        except OSError as exc:
            print(
                f"WARNING: Log directory unavailable in user home: {exc}. "
                "Falling back to console logging.",
                file=sys.stderr,
            )
            log_file = None
    
    # 如果指定了日志文件，添加文件处理器
    if log_file:
        try:
            # 确保日志目录存在
            log_dir = os.path.dirname(log_file)
            if log_dir:
                os.makedirs(log_dir, exist_ok=True)

            file_handler = logging.FileHandler(log_file, mode='a', encoding='utf-8')
            file_handler.setFormatter(
                logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
            )
            handlers.append(file_handler)
        except OSError as exc:
            # In restricted environments (tests/sandbox), fallback to console-only logging.
            print(
                f"WARNING: File logging unavailable at '{log_file}': {exc}. "
                "Falling back to console logging.",
                file=sys.stderr,
            )
    
    # 添加控制台处理器（会被重定向到日志文件）
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(
        logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    )
    handlers.append(console_handler)
    
    logging.basicConfig(
        level=level,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=handlers
    )


def get_logger(name):
    """Returns a logger with the specified name."""
    return logging.getLogger(name)

