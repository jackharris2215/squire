# Squire Notes

Squire for short: a personal note-taking app in the browser. Notes are plain JSON files in a
`notebook/` folder, built from Notion-style blocks. Vue 3 + Vite + TypeScript on the front, one
standard-library Python file on the back.

## Features

- **Blocks:** text, tables (editable grids), checklists, bulleted lists, columns, per-block
  alignment and colors, drag and drop to rearrange.
- **Floating blocks:** unhook a block (right-click it) and drag it anywhere on the note, resize
  it, stack it in front of or behind others. Hook it back to return it to the flow.
- **Block browser:** the right panel lists every block in the note, floating ones included.
- **Links and images:** `[[Note]]` links with autocomplete, `![[image.png|400]]` embeds, paste an
  image straight into a block. Renaming a note or image updates its links.
- **Variables and widgets:** notebook-wide and per-note variables (text, number, boolean, date,
  time), `{{name}}` / `{{a + b}}` formulas, and widgets (input, checkbox, checkboxes, counter,
  slider).
- **Scripts:** `.py` files in the notebook, run from the app with a `squire` library already
  available to read and edit the notebook, plus optional one-time or repeating schedules.
- **Daily and weekly notes**, each with an optional template to start from.
- **Panes:** split the view into several notes, with a quick switcher (Ctrl+P), bookmarks, and a
  block browser / links / note-info side panel.
- Undo/redo per note, autosave, and a trash folder instead of permanent deletes.
- An outside API (`/api/...`) for scripts and other tools to read and edit the notebook.

## Running it

```sh
npm install
python server/server.py   # the server, port 8765
npm run dev               # the client (Vite)
```

The server serves the `notebook/` folder from the project root; its settings are a hidden file
inside it (`.squire-config.json`), so the notebook folder is everything there is to back up or
mount. The notebook, config, port and address can all be changed with flags or environment
variables (see `server/server.py`).

```sh
npm run build             # type-check and build
```

After a build the server also serves the app itself, so `http://localhost:8765` is all you need;
`npm run dev` is only for development.

## Docker

A ready-made image is published for amd64 and arm64 (PCs, Raspberry Pis, Apple Silicon), so
there is nothing to build:

```sh
docker run -d --name squire -p 8765:8765 \
  -e SQUIRE_PASSWORD=changeme \
  -v "$(pwd)/notebook:/data/notebook" \
  ghcr.io/jackharris2215/squire:latest
```

then open http://localhost:8765. Set a password: without `SQUIRE_PASSWORD` anyone who can reach
the port can read and change every note, so don't expose it to the internet either way. Use a
version tag such as `:1.0.0` instead of `:latest` to stay on one release.

Or with Docker Compose, in a `docker-compose.yml`:

```yaml
services:
  squire:
    image: ghcr.io/jackharris2215/squire:latest   # or "build: ." to build from this folder
    restart: unless-stopped
    ports:
      - "8765:8765"            # use "127.0.0.1:8765:8765" to keep it to this machine
    environment:
      - SQUIRE_PASSWORD=changeme   # the password the app asks for; change it
      # Optional: tokens for the outside API (/api/). Leave both out and the API is off.
      # - SQUIRE_API_READ_TOKEN=a-long-random-string
      # - SQUIRE_API_TOKEN=another-long-random-string
    volumes:
      - ./notebook:/data/notebook  # notes, trash and settings
```

Then:

```sh
docker compose up -d           # then open http://localhost:8765 (add --build if you use "build: .")
docker compose pull && docker compose up -d   # later, to update to the newest image
```

The image contains the app and the server, which serves both. Updating never touches your notes,
which live in the mounted folder. Your notebook is the
`./notebook` folder on the host, mounted at `/data/notebook` (notes, trash and settings all live
there).

## Demo mode

For a public try-it-out copy, start the server with `SQUIRE_DEMO=1` (or `--demo`). Visitors get the
real app, but nothing is ever saved (reloading puts everything back), there is no login and the
outside API is off. Scripts can be run but not edited; a script's changes (a new note, say) show up
in the app like any other, and a reload undoes them. A small banner says it is a demo.

`docker-compose.demo.yml` runs it against the sample notebook in `demo-notebook/`, on port 8766 and
apart from the normal container:

```sh
docker compose -f docker-compose.demo.yml up -d --build
```

## Reaching it from other devices

The server listens on every interface by default and prints its LAN address on startup, so any
device on your network can open `http://<that address>:8765`. To keep it to this machine, run
with `--host localhost` (`HOST=localhost`), and in `docker-compose.yml` publish
`127.0.0.1:8765:8765` instead.

Set `SQUIRE_PASSWORD` (or `--password`) to require a password before the app shows anything.
Without one, anyone who can reach the port can read and change your notes. It's a single shared
password over plain HTTP — fine to keep casual visitors out on a trusted network, but not strong
security: don't forward the port to the internet.

### API for scripts and assistants

Set `SQUIRE_API_READ_TOKEN` (read only) and/or `SQUIRE_API_TOKEN` (read and write) — with neither,
the API is off. Send the token as `Authorization: Bearer <token>`; it doesn't use the app
password.

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
POST /api/move?path=&to=    move a note, image, PDF or folder into folder `to` ("" = top level)
GET /api/variable?name=&path=    read a variable (notebook-wide if path is omitted)
PUT /api/variable?name=&path=    create or update a variable; body {"type", "value"}
DELETE /api/variable?name=&path= delete a variable
GET /api/script?path=       a script's source as plain text
PUT /api/script?path=       create or overwrite a script's source (read-write token); body
                            is plain text
```

An optional `&lastSaved=` on a write refuses it (412) if the notebook changed since you read it.
Open browser windows follow API changes live.

### Scripts

A `.py` file in the notebook is a script: it shows in the sidebar, opens in a plain editor, and
the Run button runs it on the server (60 second limit), showing what it printed. Scripts use the
`squire` library, which is already importable; it talks to the notebook through the same `/api/`
routes as everything else:

```python
import squire

for note in squire.notes():
    print(note["name"])
squire.append("Daily log", "Checked in")   # a note is given by its name or its path
```

See `server/squire.py` for everything it can do. A script can also carry a one-time or repeating
schedule, set from its editor. A script can change or delete anything in the notebook (deleted
notes go to the trash), and anyone who can log in can run code on the server this way, so only use
this on a network you trust.
