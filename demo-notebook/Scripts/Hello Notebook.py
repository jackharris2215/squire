{
  "script": "import squire\n\nall_notes = squire.notes()\nprint(f\"This notebook has {len(all_notes)} notes:\")\nfor note in all_notes:\n    print(\" -\", note[\"name\"])\n\nprint()\nprint(\"The first line of the Welcome note is:\")\nprint(squire.text(\"Welcome\").splitlines()[0])\n"
}