{
  "script": "import squire\n\n# Create a note, add to it, and read it back.\nsquire.create(\"Script Made This\", [\"Created by a script.\"])\nsquire.append(\"Script Made This\", \"A second paragraph, added a moment later.\")\n\nprint(\"Notes now:\", len(squire.notes()))\nprint()\nprint(squire.text(\"Script Made This\"))\n"
}