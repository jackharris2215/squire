# Squire Notes

Squire for short: a personal note-taking app in the browser. Notes are plain JSON files in a `notebook/` folder, built from
Notion-style blocks. Vue 3 + Vite + TypeScript on the front, one standard-library Python file
on the back.

## Features

- **Blocks:** text, tables (editable grids), checklists, bulleted lists, columns, per-block
  alignment and colors, drag and drop to rearrange.
- **Floating blocks:** unhook a block (right-click it) and drag it
  anywhere on the note, resize it, stack it in front of or behind others. Hook it back to return
  it to the flow.
- **Block browser:** the right panel lists every block in the note, floating ones included, so
  nothing gets lost behind something else.
- **Links and images:** `[[Note]]` links with autocomplete, `![[image.png|400]]` embeds, paste an
  image straight into a block. Renaming a note or image updates its links.
- **Variables and widgets:** notebook-wide and per-note variables (text, number, boolean),
  `{{name}}` / `{{a + b}}` formulas, and widgets (input, checkbox, checkboxes, counter, slider).
- **Panes:** split the view into several notes, with back/forward per pane, a quick switcher
  (Ctrl+P), bookmarks and a daily note.
- Undo/redo per note, autosave, and a trash folder instead of permanent deletes.

## Running it

```sh
npm install
python server/server.py   # the server, port 8765
npm run dev               # the client (Vite)
```

The server serves the `notebook/` folder from the project root; the app's settings are a hidden
file inside it (`.squire-config.json`, copied from an old project-folder `config.json` the
first time), so the notebook folder is everything there is to back up or mount. Where the notebook,
config, port and address are can be changed with flags or environment variables (see
`server/server.py`).

```sh
npm run build             # type-check and build
```

After a build the server also serves the app itself, so `http://localhost:8765` is all you
need; `npm run dev` is only for development.

## Docker

```sh
docker compose up -d --build   # then open http://localhost:8765
```

The image builds the app and runs the server, which serves both. Your notebook is the
`./notebook` folder on the host, mounted at `/data/notebook` (notes, trash and settings all
live there).

## Reaching it from other devices

The server listens on every network interface (and the compose file publishes the port), so any
device on your network can open `http://<this machine's address>:8765`; the server prints that
address when it starts. To keep it to this machine, start it with `--host localhost` (or
`HOST=localhost`), and in `docker-compose.yml` publish `127.0.0.1:8765:8765`. The first time,
Windows may ask whether to let Python through the firewall; allow it on private networks.

### Password

Set `SQUIRE_PASSWORD` (the compose file has it under `environment:`; change it from `changeme`) or
start the server with `--password`, and the app asks for that password before it shows anything.
Without one there is no login at all, so anyone who can reach the port can read and change your
notes. It is a single shared password sent over plain HTTP, which keeps casual visitors out but is
not strong security: only use this on a network you trust, over a VPN, or behind a reverse proxy
with HTTPS, and don't forward the port to the internet. There is no way to change it from the app;
change the setting and restart the server.

### API for scripts and assistants

Set `SQUIRE_API_READ_TOKEN` (read only) and/or `SQUIRE_API_TOKEN` (read and write), or the
`--api-read-token` / `--api-token` flags; with neither, the API is off. Send the token as
`Authorization: Bearer <token>`. It does not use the app password.

```
GET /api/notes?folder=&q=   the folders, notes and other files (both filters optional)
GET /api/search?q=dnd       notes whose name contains the words, best matches first; add
                            &content=true to also search inside notes (results carry a snippet)
GET /api/note?path=a/b.json the note: metadata, blocks (rows of blocks), floating blocks, lastSaved
PUT /api/note?path=a/b.json write a whole note (read-write token); body is {"metadata", "blocks"}
GET /api/block?path=&id=    one block, and where it is (row/column, or floating)
PUT /api/block?path=&id=    change a block: body has any of content, type, align, textColor, background
POST /api/block?path=&after=<id>  add a block in a row of its own after that one (default: the end);
                            body {"content", "type"}; replies with the new block and its id
DELETE /api/block?path=&id= remove a block for good (it does not go to the trash)
POST /api/note?path=x.json  create a note (409 if it exists); body optional note JSON, empty by default
DELETE /api/note?path=      move a note to notebook/.trash (the same as deleting in the app)
POST /api/folder?path=      create a folder (409 if it exists)
DELETE /api/folder?path=    move a folder and everything in it to notebook/.trash
POST /api/move?path=&to=    move a note, image, PDF or folder into folder `to` ("" = top level); replies with its new path
```

An optional `&lastSaved=` on the PUT refuses the write (412) if the notebook changed since you read it.
Open browser windows follow API changes live: the file list updates and a note on screen
changes in place (the server's copy wins over anything not yet saved).

### Letting an AI assistant use the notebook (MCP)

`mcp/squire_mcp.py` is a small MCP server (Python, standard library only) that turns the API
above into tools an assistant such as Claude Code or Claude Desktop can call: search and list
notes, read a note and its blocks, edit or add or delete a block, create, write, move and delete
notes and folders. It runs on the machine where the assistant runs (not in the container) and
talks to the server over HTTP, so it needs `SQUIRE_URL` (default `http://localhost:8765`) and
`SQUIRE_API_TOKEN`: put in whichever token you want it to have. The read-only token makes every
tool that changes something fail, which is a good way to let an assistant look around.

Claude Code:

```bash
claude mcp add squire -e SQUIRE_URL=http://localhost:8765 -e SQUIRE_API_TOKEN=your-token -- python /path/to/mcp/squire_mcp.py
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "squire": {
      "command": "python",
      "args": ["/path/to/mcp/squire_mcp.py"],
      "env": { "SQUIRE_URL": "http://localhost:8765", "SQUIRE_API_TOKEN": "your-token" }
    }
  }
}
```

Deleting a block is permanent, and `write_note` replaces a whole note, so a read-write token is a real
grant of power; the read-only token is the safe default for an assistant you are still getting to know.

## More

`CLAUDE.md` describes the code layout, how the data works, and the rules that are easy to break.
