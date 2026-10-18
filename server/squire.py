"""The Squire library: what a script in the notebook imports to read and change its notes.

    import squire
    for note in squire.notes():
        print(note["name"])
    squire.append("Daily log", "Checked in at noon")

It only translates: every function is one call to the server's /api/ routes over HTTP, so the
rules there (the trash, lastSaved, live updates in open browser windows) apply to a script
like to anything else. Standard library only. When the server runs a script it sets
SQUIRE_URL and SQUIRE_API_TOKEN; to use this from elsewhere, set them yourself.

A note is given by its name ("Daily log": names are unique) or by its path ("Folder/Daily log.json").
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE_URL = (os.environ.get("SQUIRE_URL") or "http://localhost:8765").rstrip("/")
TOKEN = os.environ.get("SQUIRE_API_TOKEN") or ""


class SquireError(Exception):
    """The server refused something, or could not be reached."""


def _api(method, route, params=None, body=None):
    query = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None})
    request = urllib.request.Request(
        f"{BASE_URL}/api/{route}" + (f"?{query}" if query else ""),
        method=method,
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as err:
        try:
            message = json.loads(err.read().decode("utf-8")).get("error") or f"HTTP {err.code}"
        except ValueError:
            message = f"HTTP {err.code}"
        raise SquireError(f"{message} (HTTP {err.code})") from None
    except (urllib.error.URLError, OSError) as err:
        raise SquireError(f"Could not reach the Squire server at {BASE_URL}: {err}") from None


def _path(name):
    """The path of an existing note, from its name or its path."""
    name = name.strip().strip("/")
    if name.lower().endswith(".json"):
        return name
    if "/" in name:
        return name + ".json"
    matches = [n["path"] for n in notes() if n["name"].lower() == name.lower()]
    if not matches:
        raise SquireError(f"No note named {name!r}")
    return matches[0]


def _new_path(name):
    """The path a new note will have: top level unless the name has folders in it."""
    name = name.strip().strip("/")
    return name if name.lower().endswith(".json") else name + ".json"


def notes(folder=None, query=None):
    """Every note as {"path", "name", ...}, optionally only inside a folder or with `query` in the name."""
    return _api("GET", "notes", {"folder": folder, "q": query})["notes"]


def files(folder=None, query=None):
    """The other files in the notebook (images, PDFs, scripts) as paths."""
    return _api("GET", "notes", {"folder": folder, "q": query})["files"]


def folders():
    """Every folder's path."""
    return _api("GET", "notes")["folders"]


def exists(name):
    try:
        _path(name)
        return True
    except SquireError:
        return False


def search(query, content=False, limit=50):
    """Notes whose name contains every word of `query`, best first. With content=True, notes
    whose text contains the words are added after them (with a "snippet")."""
    return _api("GET", "search", {"q": query, "content": "true" if content else None, "limit": limit})["results"]


def read(name):
    """A note: {"path", "name", "metadata", "blocks", "lastSaved", ...}. `blocks` is a list of
    rows and each row a list of blocks (more than one in a row means columns); a block has
    "id", "type" and "content"."""
    return _api("GET", "note", {"path": _path(name)})


def blocks(name):
    """A note's blocks as one flat list, hooked ones in order, then any floating ones."""
    note = read(name)
    return [b for row in note.get("blocks") or [] for b in row] + list(note.get("floating") or [])


def text(name):
    """All the text in a note, one block per line."""
    return "\n".join(str(b.get("content", "")) for b in blocks(name))


def create(name, paragraphs=None):
    """Make a new note (an error if it exists); each string in `paragraphs` becomes a text block.
    Returns its path."""
    rows = [[{"id": f"block-{uuid.uuid4()}", "type": "text", "content": p}] for p in paragraphs or []]
    return _api("POST", "note", {"path": _new_path(name)}, {"metadata": {}, "blocks": rows})["path"]


def append(name, content, type="text"):
    """Add a block at the end of a note. Returns the new block."""
    return _api("POST", "block", {"path": _path(name)}, {"content": content, "type": type})


def set_block(name, block_id, **changes):
    """Change a block: any of content, type, align, textColor, background."""
    return _api("PUT", "block", {"path": _path(name), "id": block_id}, changes)


def delete_block(name, block_id):
    """Remove a block for good (it does not go to the trash)."""
    return _api("DELETE", "block", {"path": _path(name), "id": block_id})


def write(name, note):
    """Replace a whole note ({"metadata": ..., "blocks": ...}), creating it if it is missing."""
    path = _path(name) if exists(name) else _new_path(name)
    return _api("PUT", "note", {"path": path}, note)


def delete(name):
    """Move a note to the notebook's trash."""
    return _api("DELETE", "note", {"path": _path(name)})


def move(name, folder):
    """Move a note into `folder` ("" for the top level). Returns its new path."""
    return _api("POST", "move", {"path": _path(name), "to": folder})["path"]


def create_folder(path):
    return _api("POST", "folder", {"path": path})


def get_variable(variable, name=None):
    """A variable as {"name", "type", "value"}: a note's variable (give `name`) or a notebook
    variable (leave `name` out). Raises SquireError if there is no such variable."""
    return _api("GET", "variable", {"name": variable, "path": _path(name) if name else None})


def set_variable(variable, type, value, name=None):
    """Create a variable, or change it if one with that name already exists. `type` is "text",
    "number", "boolean", "date" ("YYYY-MM-DD") or "time" ("HH:MM"); `value` must match it. Give
    `name` for a note's variable, leave it out for a notebook variable."""
    params = {"name": variable, "path": _path(name) if name else None}
    return _api("PUT", "variable", params, {"type": type, "value": value})


def delete_variable(variable, name=None):
    """Remove a variable. Give `name` for a note's variable, leave it out for a notebook
    variable."""
    return _api("DELETE", "variable", {"name": variable, "path": _path(name) if name else None})
