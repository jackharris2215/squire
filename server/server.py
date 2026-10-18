"""Simple file server for the notes notebook.

Serves files out of NOTEBOOK_DIR. No auth, just plain file serving for local
development. Paths in requests are relative to the notebook and must stay inside it.

Staleness: the config file (a hidden file in the notebook) holds "lastSaved", a timestamp bumped by every change to
the notebook. Each change request carries the client's own lastSaved; if the
server's is newer, the request is refused with 412 {"outOfDate": true,
"lastSaved": ...} and nothing is changed, so the client knows to reload.
Successful changes reply with the new "lastSaved". Errors reply {"error": ...}.

Deleting never destroys anything: deleted files and folders are moved into
notebook/.trash/<date-time>/<original path>. The trash is hidden from every listing
and can't be reached through any request path; recover things by hand.

Reads:
  GET /files               -> list of file paths in the notebook
  GET /folders             -> list of folder paths (including empty ones)
  GET /file?path=          -> raw contents of that file (text, or the raw bytes
                              with a guessed Content-Type for a binary file)
  GET /file-info?path=     -> {"created", "modified", "size"} of that file;
                              times in ms, size in bytes
  GET /config              -> app config (created with defaults if missing)
  GET /server-info         -> {"notebook", "config"}: where the notebook and its
                              settings file are (shown on the settings page)

Changes (all take &lastSaved=):
  PUT /file?path=          -> write a note (creates it if missing). Body is note
                              JSON.
  PUT /image?path=         -> save an image (the raw bytes as the body) as a new file;
                              refuses to overwrite one, and creates folders as needed
  DELETE /file?path=       -> move that file to the trash
  POST /rename?path=       -> body {"name": ...}; renames a note or image file
                              (its name is its filename, there's no separate title
                              field). Also rewrites [[oldName]] links across the notebook.
  POST /folder?path=       -> create a folder
  POST /folder-rename?path=&name= -> rename a folder in place
  DELETE /folder?path=     -> move a folder and everything in it to the trash
  POST /move?path=&to=     -> move a file or folder into folder `to` ("" = root)

Not a notebook change, so it never bumps lastSaved:
  PUT /config              -> overwrite the app config with the request body
  POST /open-notebook      -> show the notebook folder in the machine's file manager
                              (only for a request from the server's own machine)

  GET /events              -> a server-sent events stream. {"type": "hello", "lastSaved"} first, then
                              {"type": "change", "lastSaved", "notes": [paths whose content
                              changed], "tree": whether files or folders came, went or moved}
                              for every change anyone makes, so open windows can follow along.

Any other GET is the built frontend (dist/), so the app and the API share one address.

Outside API (for scripts, an LLM, other software), all under /api/ and separate from the
routes above. It needs a token sent as "Authorization: Bearer <token>": SQUIRE_API_TOKEN
(read and write) and/or SQUIRE_API_READ_TOKEN (read only). With neither set the API is off.
  GET /api/notes?folder=&q=  -> {"folders", "notes": [{"path", "name", "modified", "size"}],
                                "files"} (files = other files, such as images and PDFs);
                                folder limits it to that folder and below, q to names
                                containing that text
  GET /api/search?q=         -> {"query", "total", "results": [{"path", "name", "match"}]}: notes
                                whose name contains every word of q, best first. Optional
                                &content=true also finds notes whose text contains every word
                                (match "content", with a "snippet"); &folder=, &limit= (50, max 200)
  GET /api/note?path=        -> {"path", "name", "lastSaved", "metadata", "blocks", ...}: the note
  GET /api/block?path=&id=   -> {"path", "lastSaved", "block", "row", "column"} (or "floating": true)
  PUT /api/block?path=&id=   -> change a block; body has any of content, type, align, textColor,
                                background (null removes the last three). Read-write token.
  POST /api/block?path=[&after=<id>] -> add a block, in a row of its own after the one holding
                                `after` (default: the end); body {"content", "type"} (type
                                defaults to "text"). Replies with the new block.
  DELETE /api/block?path=&id= -> remove a block for good (not into the trash)
                                All four take the optional &lastSaved= like PUT /api/note.
  POST /api/note?path=       -> create a note (path ends in .json; folders are created as needed);
                                body is optional note JSON, empty by default. 409 if it exists.
  DELETE /api/note?path=     -> move a note to the trash (notebook/.trash, like the app's delete)
  POST /api/folder?path=     -> create a folder (409 if it exists)
  DELETE /api/folder?path=   -> move a folder and everything in it to the trash
  POST /api/move?path=&to=   -> move a note, image, PDF or folder into folder `to` ("" = the top level); replies
                                with its new "path". 404 if it or the folder is missing, 409 if
                                the name is taken there.
                                These too take the optional &lastSaved=.
  PUT /api/note?path=        -> write a whole note (creates it if missing); body is note JSON
                                {"metadata", "blocks"}. Needs the read-write token. An optional
                                &lastSaved= refuses (412) if the notebook changed since then.
  PUT /api/script?path=      -> write a script (path ends in .py), creating it if missing or
                                replacing its text if it exists; body is the script's source as
                                plain text. Needs the read-write token. An optional &lastSaved=
                                refuses (412) if the notebook changed since then.
  GET /api/variable?name=[&path=]    -> {"name", "type", "value"} of one variable: a note's
                                (give &path=) or the notebook's (leave &path= out). 404 if not
                                found.
  PUT /api/variable?name=[&path=]    -> create or change a variable; body {"type", "value"}
                                (type is "text", "number", "boolean", "date" ("YYYY-MM-DD") or
                                "time" ("HH:MM")). Needs the read-write token. A note variable's
                                write takes the optional &lastSaved= like PUT /api/note; a
                                notebook variable lives in the config file, so (like PUT /config)
                                it isn't tracked by lastSaved or live sync — an open window only
                                sees the change on its next reload.
  DELETE /api/variable?name=[&path=] -> remove a variable. Needs the read-write token; the same
                                &lastSaved=/live-sync rules as PUT above apply.

Password: if one is set (SQUIRE_PASSWORD / --password), every API route above needs a
login first: POST /login with {"password": ...} replies with a cookie the browser sends from
then on (it also covers images and PDFs, which can't carry a header). The frontend files
themselves are public so the login page can load. This is a plain shared password over plain
HTTP: it keeps casual visitors out, it is not strong security.

Settings (flag, or environment variable): --notebook / NOTEBOOK_DIR, --config / CONFIG_PATH (default: a hidden
file in the notebook, copied from the old project-folder config.json the first time),
--static / STATIC_DIR, --host / HOST, --port / PORT, --password / SQUIRE_PASSWORD,
--api-token / SQUIRE_API_TOKEN, --api-read-token / SQUIRE_API_READ_TOKEN.
"""

import argparse
import calendar
import hashlib
import hmac
import json
import mimetypes
import os
import queue
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from datetime import datetime, timedelta
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# Paths are resolved relative to this script, so it works from any OS or cwd.
# By default the notebook is notebook/ in the project root, one level above server/, and the
# config is a hidden file inside the notebook (so one folder holds everything and each notebook
# has its own settings). Each can be moved with an environment variable or (taking
# priority) a command-line flag; see parse_settings() at the bottom. In a container the
# notebook is a mounted folder.
PROJECT_DIR = Path(__file__).resolve().parent.parent
NOTEBOOK_DIR = Path(os.environ.get("NOTEBOOK_DIR") or PROJECT_DIR / "notebook").resolve()
TRASH_DIR = NOTEBOOK_DIR / ".trash"
CONFIG_NAME = ".squire-config.json"
CONFIG_PATH = Path(os.environ.get("CONFIG_PATH") or NOTEBOOK_DIR / CONFIG_NAME).resolve()
LEGACY_CONFIG_PATH = PROJECT_DIR / "config.json"  # where the config used to live
LEGACY_NOTEBOOK_DIR = PROJECT_DIR / "vault"  # what the default notebook folder used to be called
STATIC_DIR = Path(os.environ.get("STATIC_DIR") or PROJECT_DIR / "dist").resolve()  # the built frontend
HOST = os.environ.get("HOST", "0.0.0.0")  # every network interface, so other devices on the LAN can reach it
PORT = int(os.environ.get("PORT", 8765))
# A single shared password (env SQUIRE_PASSWORD or --password). Not set: no login at all.
PASSWORD = os.environ.get("SQUIRE_PASSWORD") or None
COOKIE_NAME = "squire_session"
# Tokens for the outside API under /api/ (see the docstring). Not set: that part is off.
API_TOKEN = os.environ.get("SQUIRE_API_TOKEN") or None  # read and write
API_READ_TOKEN = os.environ.get("SQUIRE_API_READ_TOKEN") or None  # read only
# Made fresh at every start and handed only to the scripts the server runs (as SQUIRE_API_TOKEN),
# so they can use /api/ without the owner configuring a token. Read and write, accepted from this
# machine only, and it works even when the API is otherwise off.
INTERNAL_TOKEN = secrets.token_urlsafe(32)
LOOPBACK_ADDRESSES = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}

DEFAULT_CONFIG = {
    "sidebarWidth": 260,
    "sidebarCollapsed": False,
    "lastOpenNote": None,
    "bottomPanelHeightPercent": 30,
    "bottomPanelCollapsed": False,
    "sidebarTab": "files",
    "lastSaved": 0,
}

# Makes "check lastSaved, change the notebook, bump lastSaved" atomic across threads.
WRITE_LOCK = threading.Lock()


# Open /events streams, one queue each; broadcast() hands every one an event.
SUBSCRIBERS = set()
SUBSCRIBERS_LOCK = threading.Lock()


def broadcast(event):
    with SUBSCRIBERS_LOCK:
        for subscriber in SUBSCRIBERS:
            subscriber.put(event)


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def rel(path):
    return path.relative_to(NOTEBOOK_DIR).as_posix()


def notebook_path(rel_path, allow_root=False):
    """Resolve a request path, refusing anything outside the notebook."""
    if not rel_path and not allow_root:
        raise HttpError(400, "Missing path")
    path = (NOTEBOOK_DIR / (rel_path or "")).resolve()
    if not path.is_relative_to(NOTEBOOK_DIR) or (path == NOTEBOOK_DIR and not allow_root):
        raise HttpError(400, "Path must be inside the notebook")
    if is_hidden(path):
        raise HttpError(400, "That can't be accessed")
    return path


def in_trash(path):
    return path == TRASH_DIR or TRASH_DIR in path.parents


def is_hidden(path):
    """The trash and the config file: inside the notebook but not part of it."""
    return in_trash(path) or path == CONFIG_PATH


def notebook_items():
    """Every file and folder in the notebook, except the trash and the config."""
    return [p for p in NOTEBOOK_DIR.rglob("*") if not is_hidden(p)]


def write_config(config):
    CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")


def read_config():
    if not CONFIG_PATH.is_file():
        write_config(DEFAULT_CONFIG)
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def touch_last_saved():
    config = read_config()
    # Milliseconds, but always strictly increasing even within one millisecond.
    config["lastSaved"] = max(int(time.time() * 1000), config.get("lastSaved", 0) + 1)
    write_config(config)
    return config["lastSaved"]


def list_files():
    return [rel(p) for p in notebook_items() if p.is_file()]


def list_folders():
    return [rel(p) for p in notebook_items() if p.is_dir()]


def file_times(file_path):
    """When a file was created and last changed (in milliseconds) and its size in
    bytes. Creation time is the file system's where it keeps one (Windows, macOS);
    elsewhere the earliest time it has."""
    stat = file_path.stat()
    born = getattr(stat, "st_birthtime", None)
    if born is None:
        born = stat.st_ctime if os.name == "nt" else min(stat.st_ctime, stat.st_mtime)
    return {"created": int(born * 1000), "modified": int(stat.st_mtime * 1000), "size": stat.st_size}


def read_json(file_path):
    """Parsed JSON of a file, or None if it can't be read or parsed."""
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}


def rename_links(replacements):
    """Rewrite links across the notebook. `replacements` is a list of (old text, new
    text) pairs, each a link token such as "[[name]]" or "[[name|" (an embed's width)."""
    updated = []

    for path in notebook_items():
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        new_text = text
        for old, new in replacements:
            new_text = new_text.replace(old, new)
        if new_text != text:
            path.write_text(new_text, encoding="utf-8")
            updated.append(rel(path))

    return updated


# Each change below returns a dict to send back, or None if nothing changed
# (which leaves lastSaved alone). Problems raise HttpError.


def put_note(path, note, body):
    if path.exists() and read_json(path) == note:
        return None  # e.g. a client just opened it; don't touch the file
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return {}


def put_image(path, data):
    if path.suffix.lower() not in IMAGE_EXTS:
        raise HttpError(400, "Not an image file name")
    if path.exists():
        raise HttpError(409, "A file with that name already exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"path": rel(path)}


SCRIPT_EXT = ".py"


def _load_script(path):
    """A script's stored data: {"script": <code>, ...other metadata, such as a future
    schedule}. A script still in its old format (plain Python text, from before scripts were
    wrapped in JSON) is treated as {"script": <that text>}, so it reads fine either way and
    upgrades to the JSON form the next time it's saved."""
    raw = path.read_text(encoding="utf-8")
    try:
        data = json.loads(raw)
    except ValueError:
        return {"script": raw}
    return data if isinstance(data, dict) else {"script": raw}


def read_script(path):
    """A script's code, for the editor to show or for run_script() to run."""
    return _load_script(path).get("script", "")


def put_script(path, text):
    """Save a script's code (a .py file in the notebook, stored as JSON so it can carry other
    metadata alongside its code), keeping any metadata it already had."""
    if path.suffix.lower() != SCRIPT_EXT:
        raise HttpError(400, "A script's path ends in .py")
    if path.stem.lower() == "squire":
        raise HttpError(400, '"squire" is the library scripts import; pick another name.')
    if path.is_dir():
        raise HttpError(409, "A folder with that name already exists")
    data = _load_script(path) if path.exists() else {}
    if data.get("script", "") == text:
        return None  # nothing changed; leave the file and lastSaved alone
    data["script"] = text
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return {}


SCRIPT_TIMEOUT_SECONDS = 60
SCRIPT_OUTPUT_LIMIT = 100_000  # characters of output kept


def run_script(path):
    """Run a script as its own process (so a crash or an endless loop can't take the server
    down) and return what it printed. Its code is pulled out of the JSON it's stored in and
    written to a temp file (same name, so a traceback still points somewhere sensible) since
    the file on disk isn't valid Python by itself. It starts in the notebook folder and finds
    the `squire` module next to this file; the internal token lets it use /api/ on this server.
    This is not a notebook change, and it must not hold WRITE_LOCK: the script's own writes
    need it."""
    if path.suffix.lower() != SCRIPT_EXT or not path.is_file():
        raise HttpError(400, "That is not a script")
    code = read_script(path)
    env = {k: v for k, v in os.environ.items() if k not in ("SQUIRE_PASSWORD", "SQUIRE_API_READ_TOKEN")}
    env.update({
        "SQUIRE_URL": f"http://127.0.0.1:{PORT}",
        "SQUIRE_API_TOKEN": INTERNAL_TOKEN,
        "PYTHONPATH": str(Path(__file__).resolve().parent) + os.pathsep + env.get("PYTHONPATH", ""),
        "PYTHONUNBUFFERED": "1",
        "PYTHONIOENCODING": "utf-8",
    })
    timed_out = False
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir) / path.name
        tmp_path.write_text(code, encoding="utf-8")
        try:
            done = subprocess.run(
                [sys.executable, str(tmp_path)], cwd=NOTEBOOK_DIR, env=env, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=SCRIPT_TIMEOUT_SECONDS,
            )
            output, exit_code = done.stdout, done.returncode
        except subprocess.TimeoutExpired as err:  # the process has been killed by now
            output, exit_code, timed_out = err.stdout or b"", None, True
    text = output.decode("utf-8", errors="replace")
    if len(text) > SCRIPT_OUTPUT_LIMIT:
        text = text[:SCRIPT_OUTPUT_LIMIT] + "\n[output cut off]"
    return {"output": text, "exitCode": exit_code, "timedOut": timed_out}


def put_script_schedule(path, schedule):
    """Sets (or, with schedule=None, removes) a script's schedule, keeping its code and any
    other metadata untouched."""
    if path.suffix.lower() != SCRIPT_EXT or not path.is_file():
        raise HttpError(400, "That is not a script")
    data = _load_script(path)
    if schedule is None:
        if "schedule" not in data:
            return None
        del data["schedule"]
    else:
        data["schedule"] = schedule
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return {}


# --- Scheduling ---
# A script's "schedule" (in its own JSON, alongside "script") is {"enabled", "nextRun"
# ("YYYY-MM-DDTHH:MM", local time, like a datetime-local input), "repeatEnabled", "repeat":
# {"kind": "time"|"month"|"year", ...}}. A background thread (run_due_scripts_every_minute)
# checks once a minute for schedules whose nextRun has passed, runs them, and reschedules them
# (or, with no repeat, turns the schedule off — a one-shot run doesn't keep firing). "lastRun"
# is set on the script each time its schedule fires it (not on a manual Run click).

SCHEDULE_TIME_FORMAT = "%Y-%m-%dT%H:%M"


def _parse_schedule_time(value):
    return datetime.strptime(value, SCHEDULE_TIME_FORMAT)


def _format_schedule_time(dt):
    return dt.strftime(SCHEDULE_TIME_FORMAT)


def _last_day_of_month(year, month):
    return calendar.monthrange(year, month)[1]


def _add_months_clamped(dt, months, day):
    """`dt` advanced by `months`, with its day replaced by `day` (clamped to the last day of
    the target month, e.g. the 31st in a 30-day month becomes the 30th)."""
    total = dt.month - 1 + months
    year = dt.year + total // 12
    month = total % 12 + 1
    return dt.replace(year=year, month=month, day=min(day, _last_day_of_month(year, month)))


def _next_year_date(dt, month, day):
    """The next time `month`/`day` occurs strictly after `dt`, keeping dt's time of day."""
    candidate = dt.replace(month=month, day=min(day, _last_day_of_month(dt.year, month)))
    if candidate <= dt:
        candidate = candidate.replace(year=dt.year + 1, day=min(day, _last_day_of_month(dt.year + 1, month)))
    return candidate


def _compute_next_run(fired_at, schedule):
    """The schedule's next run after one that fired at `fired_at`, per its repeat setting
    (None if repeat is off, or the repeat is too degenerate to ever move forward)."""
    if not schedule.get("repeatEnabled"):
        return None
    repeat = schedule.get("repeat") or {}
    kind = repeat.get("kind")
    if kind == "time":
        delta = timedelta(hours=repeat.get("hours") or 0, minutes=repeat.get("minutes") or 0)
        return fired_at + delta if delta > timedelta(0) else None
    if kind == "month":
        return _add_months_clamped(fired_at, 1, repeat.get("monthDay") or fired_at.day)
    if kind == "year":
        return _next_year_date(fired_at, repeat.get("yearMonth") or fired_at.month, repeat.get("yearDay") or fired_at.day)
    return None


def due_scripts(now):
    """Every script path whose schedule is enabled and due to run by `now`."""
    due = []
    for path in notebook_items():
        if not path.is_file() or path.suffix.lower() != SCRIPT_EXT:
            continue
        schedule = _load_script(path).get("schedule")
        if not isinstance(schedule, dict) or not schedule.get("enabled") or not schedule.get("nextRun"):
            continue
        try:
            if _parse_schedule_time(schedule["nextRun"]) <= now:
                due.append(path)
        except ValueError:
            continue
    return due


def fire_schedule(path):
    """Runs one due script and reschedules it, each under its own short WRITE_LOCK so the
    long-running subprocess (run_script) never holds it, matching run_script's own
    requirement."""
    with WRITE_LOCK:
        schedule = _load_script(path).get("schedule")
        if not isinstance(schedule, dict) or not schedule.get("nextRun"):
            return
        try:
            fired_at = _parse_schedule_time(schedule["nextRun"])
        except ValueError:
            return
    run_script(path)
    with WRITE_LOCK:
        data = _load_script(path)
        schedule = data.get("schedule")
        if not isinstance(schedule, dict):
            return  # the schedule was removed while the script was running
        data["lastRun"] = _format_schedule_time(datetime.now())
        next_run = _compute_next_run(fired_at, schedule)
        # Fast-forward through anything still due (e.g. the server was off for a while)
        # without running the script again for each occurrence skipped.
        while next_run is not None and next_run <= datetime.now():
            next_run = _compute_next_run(next_run, schedule)
        if next_run is not None:
            schedule["nextRun"] = _format_schedule_time(next_run)
        else:
            schedule["enabled"] = False
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        current = touch_last_saved()
        broadcast({"type": "change", "lastSaved": current, "notes": [rel(path)], "tree": False})


def run_due_scripts():
    for path in due_scripts(datetime.now()):
        fire_schedule(path)


def run_due_scripts_every_minute():
    while True:
        time.sleep(60)
        try:
            run_due_scripts()
        except Exception as err:
            print(f"Scheduler error: {err}")


def move_to_trash(path):
    """Move a file or folder into the trash, keeping its path so it can be put back."""
    stamp = f"{time.strftime('%Y-%m-%d_%H-%M-%S')}_{time.time_ns() % 1_000_000_000}"
    target = TRASH_DIR / stamp / path.relative_to(NOTEBOOK_DIR)
    target.parent.mkdir(parents=True, exist_ok=True)
    path.rename(target)


# A trash entry is a folder named by move_to_trash: date, time, then a unique number.
TRASH_ENTRY_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})_\d+$")


def purge_trash():
    """Permanently deletes trash entries older than the config's "trashRetentionDays"
    (not set, or 0: nothing is ever deleted). Only folders named like move_to_trash's are
    touched, and their age is the date in the name."""
    with WRITE_LOCK:
        try:
            days = read_config().get("trashRetentionDays")
        except (OSError, ValueError):
            return
        if isinstance(days, bool) or not isinstance(days, (int, float)) or days <= 0 or not TRASH_DIR.is_dir():
            return
        cutoff = time.time() - days * 86400
        for entry in TRASH_DIR.iterdir():
            match = TRASH_ENTRY_RE.match(entry.name)
            if not match or not entry.is_dir():
                continue
            if time.mktime(time.strptime(match.group(1), "%Y-%m-%d_%H-%M-%S")) < cutoff:
                try:
                    shutil.rmtree(entry)
                    print(f"Emptied from the trash: {entry.name}")
                except OSError as err:
                    print(f"Could not remove {entry}: {err}")


def purge_trash_hourly():
    while True:
        time.sleep(3600)
        purge_trash()


def open_notebook_folder(client_ip):
    """Shows the notebook folder in the machine's file manager. Only for a request from the
    server's own machine: anywhere else (another computer, or a container, whose requests
    arrive from outside) it would open a window nobody is looking at."""
    if client_ip not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
        raise HttpError(403, "The folder can only be opened from the machine the server runs on.")
    try:
        if os.name == "nt":
            os.startfile(NOTEBOOK_DIR)  # noqa: the Windows file manager
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(NOTEBOOK_DIR)])
        else:
            subprocess.Popen(["xdg-open", str(NOTEBOOK_DIR)])
    except OSError as err:
        raise HttpError(500, f"Could not open the folder: {err}")
    return {}


def delete_file(path):
    if not path.is_file():
        raise HttpError(404, "File not found")
    move_to_trash(path)
    return {}


def rename_file(path, new_name):
    """A note's (or image's) name is its filename; renaming is a plain filesystem
    rename (the same shape as rename_folder), plus rewriting [[oldName]] links
    elsewhere."""
    if not path.is_file():
        raise HttpError(404, "File not found")
    new_name = new_name.strip()
    if not new_name or new_name in (".", "..") or "/" in new_name or "\\" in new_name:
        raise HttpError(400, "Invalid name")
    target = path.with_name(f"{new_name}{path.suffix}")
    if target.exists() or in_trash(target):
        raise HttpError(409, "A file with that name already exists")
    try:
        path.rename(target)
    except OSError:
        raise HttpError(400, "Invalid name")
    if path.suffix.lower() in IMAGE_EXTS or path.suffix.lower() in (".pdf", SCRIPT_EXT):
        # Links to an image (PDF, script) say its filename with the extension, or its notebook path.
        replacements = []
        for old, new in ((path.name, target.name), (rel(path), rel(target))):
            replacements += [(f"[[{old}]]", f"[[{new}]]"), (f"[[{old}|", f"[[{new}|")]
    else:
        replacements = [(f"[[{path.stem}]]", f"[[{new_name}]]")]
    return {"path": rel(target), "updated": rename_links(replacements)}


def make_folder(path):
    if path.exists():
        raise HttpError(409, "That already exists")
    try:
        path.mkdir(parents=True)
    except OSError:
        raise HttpError(400, "Invalid folder name")
    return {"path": rel(path)}


def rename_folder(path, name):
    name = name.strip()
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise HttpError(400, "Invalid folder name")
    if not path.is_dir():
        raise HttpError(404, "Folder not found")
    target = path.parent / name
    if target.exists() or in_trash(target):
        raise HttpError(409, "That already exists")
    try:
        path.rename(target)
    except OSError:
        raise HttpError(400, "Invalid folder name")
    return {"path": rel(target)}


def delete_folder(path):
    if not path.is_dir():
        raise HttpError(404, "Folder not found")
    move_to_trash(path)
    return {}


def move_item(source, dest_dir):
    if not source.exists():
        raise HttpError(404, "File or folder not found")
    if not dest_dir.is_dir():
        raise HttpError(404, "Destination folder not found")
    if source.is_dir() and (dest_dir == source or dest_dir.is_relative_to(source)):
        raise HttpError(400, "Can't move a folder into itself")
    target = dest_dir / source.name
    if target == source:
        return None
    if target.exists():
        raise HttpError(409, "Something with that name already exists there")
    source.rename(target)  # a folder takes its contents along
    return {"path": rel(target)}


# Types for the frontend's files, spelled out because mimetypes reads the OS's table
# (on Windows, the registry), which can get .js and .css wrong, and a browser won't run
# a module script served as text/plain.
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


# The routes that need the password (everything else is the public frontend).
API_ROUTES = {
    "/files", "/folders", "/file", "/file-info", "/config", "/server-info", "/rename",
    "/folder", "/folder-rename", "/move", "/image", "/script", "/script-schedule", "/run",
    "/open-notebook", "/events",
}


def api_role(header, loopback=False):
    """'write', 'read' or None for an Authorization header's bearer token. The internal token
    (see INTERNAL_TOKEN) counts only when the request came from this machine (`loopback`)."""
    scheme, _, supplied = (header or "").partition(" ")
    if scheme.lower() != "bearer" or not supplied.strip():
        return None
    supplied = supplied.strip().encode("utf-8")
    # Both are compared every time, so how long the answer takes doesn't say which matched.
    is_write = bool(API_TOKEN) and hmac.compare_digest(supplied, API_TOKEN.encode("utf-8"))
    is_read = bool(API_READ_TOKEN) and hmac.compare_digest(supplied, API_READ_TOKEN.encode("utf-8"))
    is_internal = hmac.compare_digest(supplied, INTERNAL_TOKEN.encode("utf-8")) and loopback
    return "write" if is_write or is_internal else "read" if is_read else None


def api_list_notes(folder, query):
    """Notes (the .json files), other files and folders, optionally within one folder and
    with names containing `query`."""
    prefix = f"{folder.strip('/')}/" if folder and folder.strip("/") else ""
    query = (query or "").lower()
    notes, files = [], []
    for path in notebook_items():
        if not path.is_file() or not rel(path).startswith(prefix):
            continue
        if path.suffix.lower() == ".json":
            if query in path.stem.lower():
                notes.append({"path": rel(path), "name": path.stem, **file_times_short(path)})
        elif query in path.name.lower():
            files.append(rel(path))
    folders = [rel(p) for p in notebook_items() if p.is_dir() and rel(p).startswith(prefix)]
    return {"folders": sorted(folders), "notes": sorted(notes, key=lambda n: n["path"]), "files": sorted(files)}


def note_text(note):
    """All the text in a note's blocks, hooked and floating, one block per line."""
    rows = [block for row in note.get("blocks") or [] if isinstance(row, list) for block in row]
    rows += [block for block in note.get("floating") or []]
    return "\n".join(str(b.get("content", "")) for b in rows if isinstance(b, dict))


def api_search(query, folder, content, limit):
    """Notes whose name contains every word of `query` (any case), best matches first:
    the exact name, then names starting with it, then names with a word starting with it,
    then the rest. With `content`, notes whose name doesn't match but whose text contains
    every word are added after those, with a snippet."""
    words = (query or "").lower().split()
    if not words:
        raise HttpError(400, "Missing q")
    whole = " ".join(words)
    prefix = f"{folder.strip('/')}/" if folder and folder.strip("/") else ""
    named, in_text = [], []
    for path in notebook_items():
        if not path.is_file() or path.suffix.lower() != ".json" or not rel(path).startswith(prefix):
            continue
        name = path.stem.lower()
        if all(w in name for w in words):
            if name == whole:
                rank = 0
            elif name.startswith(whole):
                rank = 1
            elif any(part.startswith(words[0]) for part in re.split(r"[\s_\-.]+", name)):
                rank = 2
            else:
                rank = 3
            named.append((rank, name, {"path": rel(path), "name": path.stem, "match": "name"}))
        elif content:
            note = read_json(path)
            text = note_text(note) if isinstance(note, dict) else ""
            lower = text.lower()
            if text and all(w in lower for w in words):
                start = max(0, lower.find(words[0]) - 60)
                snippet = " ".join(text[start:start + 160].split())
                in_text.append((name, {"path": rel(path), "name": path.stem, "match": "content", "snippet": snippet}))
    results = [r for _, _, r in sorted(named, key=lambda x: x[:2])] + [r for _, r in sorted(in_text, key=lambda x: x[0])]
    return {"query": query, "total": len(results), "results": results[:limit]}


def ensure_block_ids(note):
    """Fills in a block's id when the caller left it out (like /api/block's insert already
    does), so a caller building a note's initial content doesn't have to invent ids."""
    for row in note.get("blocks") or []:
        for block in row if isinstance(row, list) else []:
            if isinstance(block, dict) and not block.get("id"):
                block["id"] = f"block-{uuid.uuid4()}"
    for block in note.get("floating") or []:
        if isinstance(block, dict) and not block.get("id"):
            block["id"] = f"block-{uuid.uuid4()}"


def api_create_note(path, spec):
    """A new note (an empty one unless `spec` is note JSON); never overwrites."""
    if path.suffix.lower() != ".json":
        raise HttpError(400, "A note's path ends in .json")
    if spec is None:
        spec = {"metadata": {}, "blocks": []}
    if not isinstance(spec, dict) or not isinstance(spec.get("blocks", []), list):
        raise HttpError(400, 'Body must be note JSON with a "blocks" list, or empty')
    spec.setdefault("metadata", {})
    spec.setdefault("blocks", [])
    ensure_block_ids(spec)
    if path.exists():
        raise HttpError(409, "A note with that name already exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    api_save_note(path, spec)
    return {"path": rel(path)}


def api_delete_note(path):
    """Into the trash, like deleting in the app."""
    if path.suffix.lower() != ".json":
        raise HttpError(400, "Not a note")
    return delete_file(path)


def find_block(note, block_id):
    """(block, row index, column index) of a hooked block, or (block, None, None) for a
    floating one; raises 404 if the note has no such block."""
    for r, row in enumerate(note.get("blocks") or []):
        for c, block in enumerate(row if isinstance(row, list) else []):
            if isinstance(block, dict) and block.get("id") == block_id:
                return block, r, c
    for block in note.get("floating") or []:
        if isinstance(block, dict) and block.get("id") == block_id:
            return block, None, None
    raise HttpError(404, "Block not found")


def api_note_for_edit(path):
    if path.suffix.lower() != ".json":
        raise HttpError(400, "Not a note")
    note = read_json(path) if path.is_file() else None
    if not isinstance(note, dict):
        raise HttpError(404, "Note not found")
    if not isinstance(note.get("blocks"), list):
        note["blocks"] = []
    return note


def api_save_note(path, note):
    path.write_text(json.dumps(note, indent=2, ensure_ascii=False), encoding="utf-8")


def api_get_block(path, block_id):
    note = api_note_for_edit(path)
    block, row, column = find_block(note, block_id)
    where = {"floating": True} if row is None else {"row": row, "column": column}
    return {"path": rel(path), "lastSaved": read_config().get("lastSaved", 0), "block": block, **where}


# The display fields of a block an API call may set besides its content and type.
API_BLOCK_FIELDS = {"align": {"left", "center", "right"}, "textColor": None, "background": None}


def api_update_block(path, block_id, changes):
    """Set a block's content, type or display fields (a field set to null is removed)."""
    if not isinstance(changes, dict) or not changes:
        raise HttpError(400, "Body must be JSON with the fields to change")
    unknown = set(changes) - {"content", "type"} - set(API_BLOCK_FIELDS)
    if unknown:
        raise HttpError(400, f"Can't change: {', '.join(sorted(unknown))}")
    note = api_note_for_edit(path)
    block, _, _ = find_block(note, block_id)
    for key, value in changes.items():
        if key in ("content", "type"):
            if not isinstance(value, str) or (key == "type" and not value):
                raise HttpError(400, f"{key} must be a string")
            block[key] = value
        elif value is None:
            block.pop(key, None)
        elif not isinstance(value, str) or (API_BLOCK_FIELDS[key] and value not in API_BLOCK_FIELDS[key]):
            raise HttpError(400, f"Invalid {key}")
        else:
            block[key] = value
    api_save_note(path, note)
    return {"block": block}


def api_insert_block(path, after_id, spec):
    """Add a new block in a row of its own, after the row holding `after_id`, or at the end."""
    spec = spec if isinstance(spec, dict) else {}
    content, kind = spec.get("content", ""), spec.get("type", "text")
    if not isinstance(content, str) or not isinstance(kind, str) or not kind:
        raise HttpError(400, "content and type must be strings")
    note = api_note_for_edit(path)
    block = {"id": f"block-{uuid.uuid4()}", "type": kind, "content": content}
    at = len(note["blocks"])
    if after_id:
        _, row, _ = find_block(note, after_id)
        if row is None:
            raise HttpError(400, "Can't insert after a floating block")
        at = row + 1
    note["blocks"].insert(at, [block])
    api_save_note(path, note)
    return {"block": block, "row": at}


def api_delete_block(path, block_id):
    """Remove a block for good (it does not go to the trash); a row left empty goes too."""
    note = api_note_for_edit(path)
    block, row, column = find_block(note, block_id)
    if row is None:
        note["floating"] = [b for b in note["floating"] if b is not block]
        if not note["floating"]:
            del note["floating"]
    else:
        del note["blocks"][row][column]
        if not note["blocks"][row]:
            del note["blocks"][row]
    api_save_note(path, note)
    return {}


def file_times_short(path):
    times = file_times(path)
    return {"modified": times["modified"], "size": times["size"]}


def api_get_note(path):
    if path.suffix.lower() != ".json":
        raise HttpError(400, "Not a note")
    if not path.is_file():
        raise HttpError(404, "Note not found")
    note = read_json(path)
    if not isinstance(note, dict):
        raise HttpError(500, "That note can't be read")
    return {"path": rel(path), "name": path.stem, "lastSaved": read_config().get("lastSaved", 0), **note}


# A variable's name is letters and spaces only (matches NAME_RE in variables.ts); within one
# list (a note's or the notebook's) names are compared trimmed and case-insensitively.
VARIABLE_NAME_RE = re.compile(r"^[A-Za-z ]+$")
VARIABLE_TYPES = {"text", "number", "boolean", "date", "time"}


def variable_key(name):
    return name.strip().lower()


def find_variable(variables, name):
    key = variable_key(name)
    for variable in variables:
        if isinstance(variable, dict) and variable_key(str(variable.get("name", ""))) == key:
            return variable
    return None


def validate_variable_name(name):
    if not isinstance(name, str) or not name.strip():
        raise HttpError(400, "Missing name")
    if not VARIABLE_NAME_RE.match(name.strip()):
        raise HttpError(400, "A variable's name can only have letters and spaces")
    return name.strip()


def validate_variable_value(kind, value):
    if kind not in VARIABLE_TYPES:
        raise HttpError(400, f"type must be one of {', '.join(sorted(VARIABLE_TYPES))}")
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise HttpError(400, "A number variable's value must be a number")
    elif kind == "boolean":
        if not isinstance(value, bool):
            raise HttpError(400, "A boolean variable's value must be true or false")
    elif kind == "date":
        if not isinstance(value, str) or not re.match(r"^\d{4}-\d{2}-\d{2}$", value):
            raise HttpError(400, 'A date variable\'s value must look like "YYYY-MM-DD"')
    elif kind == "time":
        if not isinstance(value, str) or not re.match(r"^\d{2}:\d{2}$", value):
            raise HttpError(400, 'A time variable\'s value must look like "HH:MM"')
    elif not isinstance(value, str):
        raise HttpError(400, "A text variable's value must be a string")


def api_get_variable(variables, name):
    variable = find_variable(variables, name)
    if variable is None:
        raise HttpError(404, "Variable not found")
    return {"name": variable.get("name"), "type": variable.get("type"), "value": variable.get("value")}


def api_set_variable(variables, name, kind, value):
    """Create the variable, or change it if a variable with that name (trimmed, any case)
    already exists in the list."""
    name = validate_variable_name(name)
    validate_variable_value(kind, value)
    variable = find_variable(variables, name)
    if variable is None:
        variable = {"name": name}
        variables.append(variable)
    else:
        variable["name"] = name
    variable["type"] = kind
    variable["value"] = value
    return variable


def api_delete_variable(variables, name):
    variable = find_variable(variables, name)
    if variable is None:
        raise HttpError(404, "Variable not found")
    variables.remove(variable)


def session_token():
    """What the session cookie holds: derived from the password, so it stays valid across
    restarts and stops being valid when the password changes."""
    return hmac.new(PASSWORD.encode("utf-8"), b"squire-session", hashlib.sha256).hexdigest()


class Handler(BaseHTTPRequestHandler):
    def handle_one_request(self):
        # Turn errors into real responses; a dropped connection would show up in
        # the browser as a confusing CORS failure.
        try:
            super().handle_one_request()
        except HttpError as err:
            self._send_json({"error": str(err)}, err.status)
        except Exception as err:
            traceback.print_exc()
            try:
                self._send_json({"error": f"Server error: {err}"}, 500)
            except Exception:
                pass

    def _send(self, body, content_type, status, headers=None):
        self._send_bytes(body.encode("utf-8"), content_type, status, headers)

    def _send_bytes(self, data, content_type, status=200, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, data, status=200, headers=None):
        self._send(json.dumps(data), "application/json", status, headers)

    def _logged_in(self):
        morsel = SimpleCookie(self.headers.get("Cookie", "")).get(COOKIE_NAME)
        return morsel is not None and hmac.compare_digest(morsel.value, session_token())

    def _request(self):
        parsed = urlparse(self.path)
        params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        if parsed.path.startswith("/api/"):
            # The outside API has its own tokens; the password and cookie don't apply to it.
            loopback = self.client_address[0] in LOOPBACK_ADDRESSES
            self._api_role = api_role(self.headers.get("Authorization"), loopback)
            if not self._api_role:
                if not (API_TOKEN or API_READ_TOKEN):
                    raise HttpError(403, "The API is off: set SQUIRE_API_TOKEN (or SQUIRE_API_READ_TOKEN) on the server")
                raise HttpError(401, "A valid API token is needed (Authorization: Bearer <token>)")
        elif PASSWORD and parsed.path in API_ROUTES and not self._logged_in():
            raise HttpError(401, "Login required")
        return parsed.path, params

    def _login(self):
        """The password is checked; if it's right the reply sets the session cookie."""
        if not PASSWORD:
            self._send_json({})
            return
        try:
            supplied = str(json.loads(self._body() or "{}").get("password", ""))
        except (ValueError, AttributeError):
            supplied = ""
        if not hmac.compare_digest(supplied.encode("utf-8"), PASSWORD.encode("utf-8")):
            time.sleep(1)  # a wrong guess is slow, which is all the protection against guessing there is
            raise HttpError(401, "Wrong password")
        cookie = f"{COOKIE_NAME}={session_token()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000"
        self._send_json({}, headers={"Set-Cookie": cookie})

    def _raw_body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def _body(self):
        return self._raw_body().decode("utf-8")

    def _need_write_token(self):
        if self._api_role != "write":
            raise HttpError(403, "This token is read-only")

    def _write(self, params, action, check=True, notes=(), tree=False):
        """Run a notebook change, but only if the client has the latest lastSaved (the API
        passes check=False unless its caller gave one). `notes` are the paths of notes whose
        content changed and `tree` is whether files or folders came, went or moved; once the
        change is made, every open /events stream is told."""
        with WRITE_LOCK:
            current = read_config().get("lastSaved", 0)
            if check and current > int(params.get("lastSaved") or 0):
                self._send_json({"outOfDate": True, "lastSaved": current}, 412)
                return
            result = action()
            if result is not None:
                current = touch_last_saved()
                broadcast({
                    "type": "change",
                    "lastSaved": current,
                    "notes": list(notes) + list(result.get("updated", [])),  # a rename also rewrites links in other notes
                    "tree": tree,
                })
            self._send_json({**(result or {}), "lastSaved": current})

    def do_GET(self):
        route, params = self._request()
        if route == "/events":
            self._stream_events()
        elif route == "/api/notes":
            self._send_json(api_list_notes(params.get("folder"), params.get("q")))
        elif route == "/api/search":
            try:
                limit = min(max(int(params.get("limit") or 50), 1), 200)
            except ValueError:
                raise HttpError(400, "limit must be a number")
            content = params.get("content", "").lower() in ("1", "true", "yes")
            self._send_json(api_search(params.get("q"), params.get("folder"), content, limit))
        elif route == "/api/block":
            self._send_json(api_get_block(notebook_path(params.get("path")), params.get("id")))
        elif route == "/api/note":
            self._send_json(api_get_note(notebook_path(params.get("path"))))
        elif route == "/api/variable":
            name = params.get("name")
            if not name:
                raise HttpError(400, "Missing name")
            if params.get("path"):
                note = api_note_for_edit(notebook_path(params.get("path")))
                variables = note.get("metadata", {}).get("variables") or []
            else:
                variables = read_config().get("variables") or []
            self._send_json(api_get_variable(variables, name))
        elif route.startswith("/api/"):
            raise HttpError(404, "Not found")
        elif route == "/files":
            self._send_json(list_files())
        elif route == "/folders":
            self._send_json(list_folders())
        elif route == "/file":
            path = notebook_path(params.get("path"))
            if not path.is_file():
                raise HttpError(404, "File not found")
            try:
                if path.suffix.lower() == ".pdf":
                    # Always raw bytes, even for the odd PDF that happens to decode as text.
                    raise UnicodeDecodeError("utf-8", b"", 0, 1, "pdf")
                self._send(path.read_text(encoding="utf-8"), "text/plain; charset=utf-8", 200)
            except UnicodeDecodeError:
                # Not text (an image, say): serve the raw bytes with a guessed type.
                content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
                self._send_bytes(path.read_bytes(), content_type)
        elif route == "/file-info":
            path = notebook_path(params.get("path"))
            if not path.is_file():
                raise HttpError(404, "File not found")
            self._send_json(file_times(path))
        elif route == "/script":
            path = notebook_path(params.get("path"))
            if not path.is_file():
                raise HttpError(404, "File not found")
            self._send(read_script(path), "text/plain; charset=utf-8", 200)
        elif route == "/script-schedule":
            path = notebook_path(params.get("path"))
            if not path.is_file():
                raise HttpError(404, "File not found")
            data = _load_script(path)
            self._send_json({"schedule": data.get("schedule"), "lastRun": data.get("lastRun")})
        elif route == "/config":
            self._send_json(read_config())
        elif route == "/server-info":
            self._send_json({"notebook": str(NOTEBOOK_DIR), "config": str(CONFIG_PATH)})
        else:
            self._serve_static(route)

    def _stream_events(self):
        """Server-sent events: stays open and writes a line for every change anyone makes
        to the notebook (see _write). It starts with the current lastSaved, so a client that
        just (re)connected can tell whether it missed anything, and sends a comment every
        20 seconds so a connection that has gone away is noticed and dropped."""
        inbox = queue.Queue()
        with SUBSCRIBERS_LOCK:
            SUBSCRIBERS.add(inbox)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")  # for a proxy that would otherwise hold it back
            self.end_headers()
            self.close_connection = True
            hello = {"type": "hello", "lastSaved": read_config().get("lastSaved", 0)}
            self.wfile.write(f"data: {json.dumps(hello)}\n\n".encode("utf-8"))
            while True:
                try:
                    event = inbox.get(timeout=20)
                    self.wfile.write(f"data: {json.dumps(event)}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
        except OSError:
            pass  # the client went away
        finally:
            with SUBSCRIBERS_LOCK:
                SUBSCRIBERS.discard(inbox)

    def _serve_static(self, route):
        """Anything that isn't an API route is the built frontend (STATIC_DIR), so the
        app and the server can be one address."""
        path = (STATIC_DIR / route.lstrip("/")).resolve()
        if path.is_dir():
            path = path / "index.html"
        if not path.is_relative_to(STATIC_DIR) or not path.is_file():
            raise HttpError(404, "Not found")
        content_type = STATIC_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self._send_bytes(path.read_bytes(), content_type)

    def do_PUT(self):
        route, params = self._request()
        if route == "/api/block":
            self._need_write_token()
            path = notebook_path(params.get("path"))
            block_id = params.get("id")
            if not block_id:
                raise HttpError(400, "Missing id")
            try:
                changes = json.loads(self._body())
            except ValueError:
                changes = None
            self._write(params, lambda: api_update_block(path, block_id, changes), check="lastSaved" in params, notes=[rel(path)])
            return
        if route == "/api/note":
            self._need_write_token()
            path = notebook_path(params.get("path"))
            if path.suffix.lower() != ".json":
                raise HttpError(400, "A note's path ends in .json")
            body = self._body()
            try:
                note = json.loads(body)
            except ValueError:
                note = None
            if not isinstance(note, dict) or not isinstance(note.get("blocks"), list):
                raise HttpError(400, 'Body must be note JSON with a "blocks" list')
            ensure_block_ids(note)
            body = json.dumps(note, indent=2, ensure_ascii=False)
            # Without a lastSaved the write just goes ahead; with one it must still be current.
            self._write(params, lambda: put_note(path, note, body), check="lastSaved" in params, notes=[rel(path)], tree=not path.exists())
            return
        if route == "/api/script":
            self._need_write_token()
            path = notebook_path(params.get("path"))
            text = self._body()
            self._write(params, lambda: put_script(path, text), check="lastSaved" in params, notes=[rel(path)], tree=not path.exists())
            return
        if route == "/api/variable":
            self._need_write_token()
            name = params.get("name")
            if not name:
                raise HttpError(400, "Missing name")
            try:
                body = json.loads(self._body() or "{}")
            except ValueError:
                body = None
            if not isinstance(body, dict) or "type" not in body or "value" not in body:
                raise HttpError(400, 'Body must be {"type", "value"}')
            if params.get("path"):
                path = notebook_path(params.get("path"))

                def action():
                    note = api_note_for_edit(path)
                    variables = note.setdefault("metadata", {}).setdefault("variables", [])
                    variable = api_set_variable(variables, name, body["type"], body["value"])
                    api_save_note(path, note)
                    return {"variable": variable}

                self._write(params, action, check="lastSaved" in params, notes=[rel(path)])
            else:
                # A notebook variable lives in the config file, which (like /config) isn't part
                # of lastSaved/live sync: an open window only sees it on its next reload.
                with WRITE_LOCK:
                    config = read_config()
                    variable = api_set_variable(config.setdefault("variables", []), name, body["type"], body["value"])
                    write_config(config)
                self._send_json({"variable": variable})
            return
        if route == "/image":
            path = notebook_path(params.get("path"))
            data = self._raw_body()
            self._write(params, lambda: put_image(path, data), tree=True)
            return
        if route == "/script":
            path = notebook_path(params.get("path"))
            text = self._body()
            self._write(params, lambda: put_script(path, text), notes=[rel(path)], tree=not path.exists())
            return
        if route == "/script-schedule":
            path = notebook_path(params.get("path"))
            try:
                schedule = json.loads(self._body() or "{}").get("schedule")
            except ValueError:
                raise HttpError(400, "Body must be JSON")
            if schedule is not None and not isinstance(schedule, dict):
                raise HttpError(400, '"schedule" must be an object or null')
            self._write(params, lambda: put_script_schedule(path, schedule), notes=[rel(path)])
            return
        body = self._body()
        if route == "/config":
            with WRITE_LOCK:
                config = json.loads(body)
                config["lastSaved"] = read_config().get("lastSaved", 0)  # only notebook changes bump it
                write_config(config)
            purge_trash()  # a changed retention setting takes effect now
            self._send_json({})
        elif route == "/file":
            path = notebook_path(params.get("path"))
            try:
                note = json.loads(body)
            except ValueError:
                note = None
            if not isinstance(note, dict):
                raise HttpError(400, "Body must be note JSON")
            self._write(params, lambda: put_note(path, note, body), notes=[rel(path)], tree=not path.exists())
        else:
            raise HttpError(404, "Not found")

    def do_POST(self):
        route, params = self._request()
        if route == "/api/block":
            self._need_write_token()
            path = notebook_path(params.get("path"))
            try:
                spec = json.loads(self._body() or "{}")
            except ValueError:
                spec = None
            self._write(params, lambda: api_insert_block(path, params.get("after"), spec), check="lastSaved" in params, notes=[rel(path)])
        elif route == "/api/note":
            self._need_write_token()
            path = notebook_path(params.get("path"))
            text = self._body().strip()
            try:
                spec = json.loads(text) if text else None
            except ValueError:
                raise HttpError(400, "Body must be JSON or empty")
            self._write(params, lambda: api_create_note(path, spec), check="lastSaved" in params, tree=True)
        elif route == "/api/folder":
            self._need_write_token()
            path = notebook_path(params.get("path"))
            self._write(params, lambda: make_folder(path), check="lastSaved" in params, tree=True)
        elif route == "/api/move":
            self._need_write_token()
            source = notebook_path(params.get("path"))
            dest_dir = notebook_path(params.get("to"), allow_root=True)
            self._write(params, lambda: move_item(source, dest_dir), check="lastSaved" in params, tree=True)
        elif route == "/rename":
            path = notebook_path(params.get("path"))
            name = (json.loads(self._body() or "{}").get("name") or "").strip()
            if not name:
                raise HttpError(400, "Missing name")
            self._write(params, lambda: rename_file(path, name), tree=True)
        elif route == "/run":
            self._send_json(run_script(notebook_path(params.get("path"))))
        elif route == "/login":
            self._login()
        elif route == "/open-notebook":
            self._send_json(open_notebook_folder(self.client_address[0]))
        elif route == "/folder":
            path = notebook_path(params.get("path"))
            self._write(params, lambda: make_folder(path), tree=True)
        elif route == "/folder-rename":
            path = notebook_path(params.get("path"))
            self._write(params, lambda: rename_folder(path, params.get("name", "")), tree=True)
        elif route == "/move":
            source = notebook_path(params.get("path"))
            dest_dir = notebook_path(params.get("to"), allow_root=True)
            self._write(params, lambda: move_item(source, dest_dir), tree=True)
        else:
            raise HttpError(404, "Not found")

    def do_DELETE(self):
        route, params = self._request()
        if route == "/api/block":
            self._need_write_token()
            path = notebook_path(params.get("path"))
            block_id = params.get("id")
            if not block_id:
                raise HttpError(400, "Missing id")
            self._write(params, lambda: api_delete_block(path, block_id), check="lastSaved" in params, notes=[rel(path)])
        elif route == "/api/note":
            self._need_write_token()
            path = notebook_path(params.get("path"))
            self._write(params, lambda: api_delete_note(path), check="lastSaved" in params, notes=[rel(path)], tree=True)
        elif route == "/api/folder":
            self._need_write_token()
            path = notebook_path(params.get("path"))
            self._write(params, lambda: delete_folder(path), check="lastSaved" in params, tree=True)
        elif route == "/api/variable":
            self._need_write_token()
            name = params.get("name")
            if not name:
                raise HttpError(400, "Missing name")
            if params.get("path"):
                path = notebook_path(params.get("path"))

                def action():
                    note = api_note_for_edit(path)
                    api_delete_variable(note.get("metadata", {}).get("variables") or [], name)
                    api_save_note(path, note)
                    return {}

                self._write(params, action, check="lastSaved" in params, notes=[rel(path)])
            else:
                with WRITE_LOCK:
                    config = read_config()
                    api_delete_variable(config.get("variables") or [], name)
                    write_config(config)
                self._send_json({})
        elif route == "/file":
            path = notebook_path(params.get("path"))
            self._write(params, lambda: delete_file(path), notes=[rel(path)], tree=True)
        elif route == "/folder":
            path = notebook_path(params.get("path"))
            self._write(params, lambda: delete_folder(path), tree=True)
        else:
            raise HttpError(404, "Not found")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()


def migrate_notebook_dir():
    """The default notebook folder used to be called vault/. If that's what the notebook
    is (nothing else was asked for) and it's still named that, rename it in place."""
    default = PROJECT_DIR / "notebook"
    if NOTEBOOK_DIR == default.resolve() and LEGACY_NOTEBOOK_DIR.is_dir() and not default.exists():
        try:
            LEGACY_NOTEBOOK_DIR.rename(default)
        except OSError as err:
            raise SystemExit(f"Couldn't rename {LEGACY_NOTEBOOK_DIR} to {default} ({err}). Close anything using it and try again.")
        print(f"Renamed {LEGACY_NOTEBOOK_DIR} to {default}")


def migrate_config():
    """If the notebook has no config yet, bring one over from an earlier version: the file
    this app's settings used to be called (renamed in place), or failing that the old
    config.json in the project folder (copied, and the old file is left where it is)."""
    if CONFIG_PATH.exists():
        return
    renamed = CONFIG_PATH.parent / ".web-notes-config.json"  # the name before the app was called Squire
    if renamed.is_file():
        renamed.rename(CONFIG_PATH)
        print(f"Renamed {renamed} to {CONFIG_PATH}")
    elif LEGACY_CONFIG_PATH.is_file():
        shutil.copy2(LEGACY_CONFIG_PATH, CONFIG_PATH)
        print(f"Copied {LEGACY_CONFIG_PATH} to {CONFIG_PATH}")


def lan_address():
    """This machine's address on the local network, or None if it can't be worked out.
    (No packet is sent: connecting a UDP socket only picks the interface that would be used.)"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("10.255.255.255", 1))
            return probe.getsockname()[0]
    except OSError:
        return None


def parse_settings():
    """Command-line flags override the environment variables, which override the defaults."""
    global NOTEBOOK_DIR, TRASH_DIR, CONFIG_PATH, STATIC_DIR, HOST, PORT, PASSWORD, API_TOKEN, API_READ_TOKEN
    parser = argparse.ArgumentParser(description="Squire Notes server")
    parser.add_argument("--notebook", help="the notebook folder (env NOTEBOOK_DIR; default: notebook/ in the project)")
    parser.add_argument("--config", help=f"the config file (env CONFIG_PATH; default: {CONFIG_NAME} in the notebook)")
    parser.add_argument("--static", help="the built frontend (env STATIC_DIR; default: dist/ in the project)")
    parser.add_argument("--host", help="address to listen on (env HOST; default: 0.0.0.0, every interface, so the LAN can reach it; use localhost for this machine only)")
    parser.add_argument("--port", type=int, help="port to listen on (env PORT; default: 8765)")
    parser.add_argument("--password", help="require this password to use the app (env SQUIRE_PASSWORD; default: none)")
    parser.add_argument("--api-token", help="token for the read-write /api/ routes (env SQUIRE_API_TOKEN; default: none, API off)")
    parser.add_argument("--api-read-token", help="token for the read-only /api/ routes (env SQUIRE_API_READ_TOKEN)")
    args = parser.parse_args()
    API_TOKEN = args.api_token or API_TOKEN
    API_READ_TOKEN = args.api_read_token or API_READ_TOKEN
    if args.notebook:
        NOTEBOOK_DIR = Path(args.notebook).resolve()
        TRASH_DIR = NOTEBOOK_DIR / ".trash"
    if args.config:
        CONFIG_PATH = Path(args.config).resolve()
    elif not os.environ.get("CONFIG_PATH"):
        CONFIG_PATH = NOTEBOOK_DIR / CONFIG_NAME
    if args.static:
        STATIC_DIR = Path(args.static).resolve()
    HOST = args.host or HOST
    PASSWORD = args.password or PASSWORD
    PORT = args.port or PORT


if __name__ == "__main__":
    parse_settings()
    migrate_notebook_dir()
    NOTEBOOK_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    migrate_config()
    purge_trash()
    threading.Thread(target=purge_trash_hourly, daemon=True).start()
    threading.Thread(target=run_due_scripts_every_minute, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Serving notebook {NOTEBOOK_DIR}")
    print(f"  On this machine: http://localhost:{PORT}")
    # Inside a container the address is the container's own, which is no use to anyone.
    if HOST in ("0.0.0.0", "::") and not os.path.exists("/.dockerenv"):
        address = lan_address()
        if address:
            note = "password required" if PASSWORD else "there is no login: anyone on the network can read and change your notes"
            print(f"  On the network:  http://{address}:{PORT}   ({note})")
    elif HOST not in ("0.0.0.0", "::"):
        print(f"  Listening on {HOST} only")
    if API_TOKEN or API_READ_TOKEN:
        print("  API on at /api/ (" + " and ".join(n for n, t in (("read-write", API_TOKEN), ("read-only", API_READ_TOKEN)) if t) + " token)")
    if not STATIC_DIR.is_dir():
        print(f"No built frontend at {STATIC_DIR} (run `npm run build`); only the API is available.")
    server.serve_forever()
