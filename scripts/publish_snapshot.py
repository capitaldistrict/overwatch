#!/usr/bin/env python3
from __future__ import annotations

import argparse
import atexit
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def env_path(name: str, default: str) -> Path:
    return Path(os.environ.get(name, default)).expanduser()


def env_text(name: str, default: str) -> str:
    return os.environ.get(name, default)


ROOT = env_path("PROPDATA_ROOT", "/path/to/parent-workspace")
REPO = env_path("OVERWATCH_REPO", str(ROOT / "overwatch"))
SOURCE = env_path("ADSB_SOURCE", str(ROOT / "adsb_receiver_json" / "aircraft.json"))
OUTPUT_DIR = env_path("ADSB_OUTPUT_DIR", str(ROOT / "adsb_data"))
VIEWER_ADSB_DIR = env_path("OVERWATCH_ADSB_DIR", str(REPO / "public" / "adsb"))
LIVE_HISTORY_MINUTES = env_text("LIVE_HISTORY_MINUTES", "120")
BASE_PATH_VALUE = env_text("BASE_PATH", "/overwatch/")
PYTHON_BIN = env_text("PYTHON_BIN", "python3")
NPM_BIN = env_text("NPM_BIN", "npm")
GIT_BIN = env_text("GIT_BIN", "/usr/bin/git")
LOCK_DIR = env_path("OVERWATCH_PUBLISH_LOCK", "/tmp/overwatch-publish.lock")


def log(message: str) -> None:
    print(f"[overwatch-publish] {message}", flush=True)


def run(args: list[str], cwd: Path, env: dict[str, str] | None = None, check: bool = True) -> int:
    log(f"running: {' '.join(args)}")
    result = subprocess.run(args, cwd=str(cwd), env=env)
    if check and result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, args)
    return result.returncode


def acquire_lock() -> None:
    try:
        LOCK_DIR.mkdir()
    except FileExistsError:
        log("another publish is already running; exiting")
        sys.exit(0)
    atexit.register(lambda: shutil.rmtree(LOCK_DIR, ignore_errors=True))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish one Overwatch ADS-B snapshot.")
    parser.add_argument("--dry-run", action="store_true", help="stage snapshot changes without committing or pushing")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    (OUTPUT_DIR / "logs").mkdir(parents=True, exist_ok=True)
    VIEWER_ADSB_DIR.mkdir(parents=True, exist_ok=True)
    acquire_lock()

    if not SOURCE.exists():
        log(f"ADS-B source not found: {SOURCE}")
        return 1
    if not (REPO / ".git").is_dir():
        log(f"not a git repo: {REPO}")
        return 1

    log(f"collecting ADS-B snapshot from {SOURCE}")
    run(
        [
            PYTHON_BIN,
            "adsb_collector.py",
            "--source",
            str(SOURCE),
            "--output-dir",
            str(OUTPUT_DIR),
            "--once",
            "--viewer-public-dir",
            str(VIEWER_ADSB_DIR),
            "--live-history-minutes",
            LIVE_HISTORY_MINUTES,
        ],
        cwd=ROOT,
    )

    log(f"building GitHub Pages docs with BASE_PATH={BASE_PATH_VALUE}")
    build_env = os.environ.copy()
    build_env["BASE_PATH"] = BASE_PATH_VALUE
    run([NPM_BIN, "run", "build"], cwd=REPO, env=build_env)

    run([GIT_BIN, "add", "public/adsb", "docs"], cwd=REPO)
    diff_code = run(
        [GIT_BIN, "diff", "--cached", "--quiet", "--", "public/adsb", "docs"],
        cwd=REPO,
        check=False,
    )
    if diff_code == 0:
        log("no snapshot changes to publish")
        return 0
    if diff_code != 1:
        log("git diff failed")
        return diff_code

    if args.dry_run:
        log("dry run; staged changes are ready but not committed")
        run([GIT_BIN, "status", "--short"], cwd=REPO)
        return 0

    published_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    run([GIT_BIN, "commit", "-m", f"Update ADS-B snapshot {published_at}", "--", "public/adsb", "docs"], cwd=REPO)
    run([GIT_BIN, "push", "origin", "main"], cwd=REPO)
    log("pushed snapshot commit")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
