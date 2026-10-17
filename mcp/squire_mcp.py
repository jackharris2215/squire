"""MCP server for Squire Notes: lets an AI assistant (Claude Code, Claude Desktop, any MCP
client) read and change the notebook through the server's /api/ routes.

It only translates: each tool is one API call, made with the token you give it, so all the
rules (the token's read-only or read-write level, the trash, lastSaved) stay in the server.
Standard library only; it speaks MCP over stdin/stdout (one JSON message per line).

Settings (environment variables):
  SQUIRE_URL        where the Squire server is (default http://localhost:8765)
  SQUIRE_API_TOKEN  the token to send: the read-write one (SQUIRE_API_TOKEN on the server) or
                    the read-only one (SQUIRE_API_READ_TOKEN on the server). A read-only
                    token makes every tool that changes something come back with an error.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE_URL = (os.environ.get("SQUIRE_URL") or "http://localhost:8765").rstrip("/")
TOKEN = os.environ.get("SQUIRE_API_TOKEN") or os.environ.get("SQUIRE_TOKEN") or ""
SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]


def api(method, route, params=None, body=None):
    """One API call. Returns the parsed JSON reply; raises ToolError with the server's message."""
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
        if err.code == 412:
            message = "The notebook changed since last_saved; read the note again first."
        raise ToolError(f"{message} (HTTP {err.code})")
    except (urllib.error.URLError, OSError) as err:
        raise ToolError(f"Could not reach the Squire server at {BASE_URL}: {err}")


class ToolError(Exception):
    pass


# --- Tools ---

PATH = {"type": "string", "description": "The note's path in the notebook, with / between folders, ending in .json, e.g. 'Campaigns/Eberron.json'."}
BLOCK_ID = {"type": "string", "description": "A block's id, from read_note."}
LAST_SAVED = {"type": "integer", "description": "Optional. The lastSaved from when you read the note; the change is refused if the notebook has changed since."}
BLOCK_FIELDS = {
    "content": {"type": "string", "description": "The block's text (markdown; [[Note Name]] links to a note)."},
    "type": {"type": "string", "description": "The block type; 'text' for ordinary text."},
    "align": {"type": ["string", "null"], "enum": ["left", "center", "right", None], "description": "Alignment; null removes it."},
    "textColor": {"type": ["string", "null"], "description": "A color key; null removes it."},
    "background": {"type": ["string", "null"], "description": "A color key; null removes it."},
}


def obj(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required)}


def t_list_notes(a):
    return api("GET", "notes", {"folder": a.get("folder"), "q": a.get("query")})


def t_search_notes(a):
    return api("GET", "search", {
        "q": a["query"], "content": "true" if a.get("search_text") else None,
        "folder": a.get("folder"), "limit": a.get("limit"),
    })


def t_read_note(a):
    return api("GET", "note", {"path": a["path"]})


def t_get_block(a):
    return api("GET", "block", {"path": a["path"], "id": a["id"]})


def t_update_block(a):
    changes = {k: a[k] for k in BLOCK_FIELDS if k in a}
    return api("PUT", "block", {"path": a["path"], "id": a["id"], "lastSaved": a.get("last_saved")}, changes)


def t_add_block(a):
    body = {"content": a.get("content", ""), "type": a.get("type", "text")}
    return api("POST", "block", {"path": a["path"], "after": a.get("after"), "lastSaved": a.get("last_saved")}, body)


def t_delete_block(a):
    return api("DELETE", "block", {"path": a["path"], "id": a["id"], "lastSaved": a.get("last_saved")})


def t_create_note(a):
    blocks = [[{"id": f"block-{uuid.uuid4()}", "type": "text", "content": text}] for text in a.get("paragraphs") or []]
    return api("POST", "note", {"path": a["path"]}, {"metadata": {}, "blocks": blocks})


def t_write_note(a):
    return api("PUT", "note", {"path": a["path"], "lastSaved": a.get("last_saved")}, a["note"])


def t_delete_note(a):
    return api("DELETE", "note", {"path": a["path"]})


def t_create_folder(a):
    return api("POST", "folder", {"path": a["path"]})


def t_delete_folder(a):
    return api("DELETE", "folder", {"path": a["path"]})


def t_move(a):
    return api("POST", "move", {"path": a["path"], "to": a["to"]})


READ = {"readOnlyHint": True}
EDIT = {"readOnlyHint": False, "destructiveHint": False}
DESTROY = {"readOnlyHint": False, "destructiveHint": True}

TOOLS = [
    ("list_notes", "List the notebook's folders, notes and other files (images, PDFs). Optionally only inside a folder, or only names containing some text.",
     obj({"folder": {"type": "string", "description": "Only this folder and below."}, "query": {"type": "string", "description": "Only names containing this text."}}), READ, t_list_notes),
    ("search_notes", "Find notes by name: every word of the query must be in the name (any case, any order), best matches first. With search_text, also finds notes whose text contains every word, with a snippet. Use this to find a note when you don't know its exact path.",
     obj({"query": {"type": "string"}, "search_text": {"type": "boolean", "description": "Also search inside notes (slower)."},
          "folder": {"type": "string"}, "limit": {"type": "integer", "description": "At most this many results (default 50, max 200)."}}, ["query"]), READ, t_search_notes),
    ("read_note", "Read a note: its metadata and its blocks. 'blocks' is a list of rows and each row a list of blocks (more than one block in a row means columns); each block has an id, a type and its text in 'content'. 'floating' lists blocks placed freely on the page. Also returns lastSaved.",
     obj({"path": PATH}, ["path"]), READ, t_read_note),
    ("get_block", "Read one block by id, and where it is in the note.",
     obj({"path": PATH, "id": BLOCK_ID}, ["path", "id"]), READ, t_get_block),
    ("update_block", "Change a block's text (content) and/or type, alignment or colors. Only the fields you give are changed.",
     obj({"path": PATH, "id": BLOCK_ID, **BLOCK_FIELDS, "last_saved": LAST_SAVED}, ["path", "id"]), EDIT, t_update_block),
    ("add_block", "Add a new block in a row of its own, after the block with id 'after' (or at the end of the note if 'after' is left out). Returns the new block with its id.",
     obj({"path": PATH, "content": BLOCK_FIELDS["content"], "type": BLOCK_FIELDS["type"],
          "after": {"type": "string", "description": "Id of the block to insert after."}, "last_saved": LAST_SAVED}, ["path"]), EDIT, t_add_block),
    ("delete_block", "Delete a block. This is permanent: the block does not go to the trash.",
     obj({"path": PATH, "id": BLOCK_ID, "last_saved": LAST_SAVED}, ["path", "id"]), DESTROY, t_delete_block),
    ("create_note", "Create a new note (fails if one with that path exists). Missing folders are created. 'paragraphs' becomes one text block each.",
     obj({"path": PATH, "paragraphs": {"type": "array", "items": {"type": "string"}, "description": "Optional starting text, one block per item."}}, ["path"]), EDIT, t_create_note),
    ("write_note", "Replace a whole note with the given note JSON ({metadata, blocks, floating?}), creating it if missing. Prefer update_block/add_block for small changes: this overwrites everything in the note.",
     obj({"path": PATH, "note": {"type": "object", "description": "The whole note: {\"metadata\": {}, \"blocks\": [[{\"id\", \"type\", \"content\"}]]}"}, "last_saved": LAST_SAVED}, ["path", "note"]), DESTROY, t_write_note),
    ("delete_note", "Move a note to the notebook's trash folder (recoverable by hand).",
     obj({"path": PATH}, ["path"]), DESTROY, t_delete_note),
    ("create_folder", "Create a folder.",
     obj({"path": {"type": "string", "description": "The folder's path, e.g. 'Campaigns/Eberron'."}}, ["path"]), EDIT, t_create_folder),
    ("delete_folder", "Move a folder and everything in it to the notebook's trash folder (recoverable by hand).",
     obj({"path": {"type": "string", "description": "The folder's path."}}, ["path"]), DESTROY, t_delete_folder),
    ("move", "Move a note, image, PDF or folder into another folder ('' is the top level). Links to notes are by name, so they keep working; links to images by path do not.",
     obj({"path": {"type": "string", "description": "What to move."}, "to": {"type": "string", "description": "The destination folder, which must exist; '' for the top level."}}, ["path", "to"]), EDIT, t_move),
]
HANDLERS = {name: fn for name, _, _, _, fn in TOOLS}


# --- MCP over stdio ---

def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def reply(request_id, result):
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


def fail(request_id, code, message):
    send({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def handle(message):
    method, request_id, params = message.get("method"), message.get("id"), message.get("params") or {}
    if request_id is None:
        return  # a notification (such as notifications/initialized): nothing to answer
    if method == "initialize":
        asked = params.get("protocolVersion")
        reply(request_id, {
            "protocolVersion": asked if asked in SUPPORTED_VERSIONS else SUPPORTED_VERSIONS[0],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "squire-notes", "version": "1.0.0"},
            "instructions": "Tools for the user's Squire Notes notebook. Find a note with search_notes, read it with read_note to get its block ids, then change it with update_block / add_block.",
        })
    elif method == "ping":
        reply(request_id, {})
    elif method == "tools/list":
        reply(request_id, {"tools": [
            {"name": name, "description": description, "inputSchema": schema, "annotations": hints}
            for name, description, schema, hints, _ in TOOLS
        ]})
    elif method == "tools/call":
        handler = HANDLERS.get(params.get("name"))
        if not handler:
            return fail(request_id, -32602, f"Unknown tool: {params.get('name')}")
        try:
            result = handler(params.get("arguments") or {})
            reply(request_id, {"content": [{"type": "text", "text": json.dumps(result, indent=2, ensure_ascii=False)}]})
        except ToolError as err:
            reply(request_id, {"content": [{"type": "text", "text": str(err)}], "isError": True})
        except KeyError as err:
            reply(request_id, {"content": [{"type": "text", "text": f"Missing argument: {err}"}], "isError": True})
    else:
        fail(request_id, -32601, f"Method not found: {method}")


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    if not TOKEN:
        print("squire-mcp: SQUIRE_API_TOKEN is not set; every call will be refused.", file=sys.stderr)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            handle(json.loads(line))
        except Exception as err:  # keep serving; one bad message must not end the session
            print(f"squire-mcp: {err!r}", file=sys.stderr)


if __name__ == "__main__":
    main()
