Drop-in Excalidraw libraries
============================

Any `*.excalidrawlib` file placed in THIS folder is automatically bundled
into every workspace canvas's library panel at build time. No code changes
needed.

How to add a library
---------------------
1. Get a `.excalidrawlib` file:
   - Browse https://libraries.excalidraw.com, open a library, and use
     "Download" to save the `.excalidrawlib` file, OR
   - In any Excalidraw board, build a library and export it
     (library panel -> ... -> Export).
2. Copy the file into this folder
   (frontend/src/components/workspaces/canvas/libraries/packs/).
3. Rebuild the frontend. The library's items appear in the canvas library
   panel for everyone.

Notes
-----
- Both file formats are supported (v1 "library" and v2 "libraryItems") -
  they're normalised via Excalidraw's restoreLibraryItems on load.
- A malformed file is skipped (logged to the console), not fatal.
- These bundled items are read-only defaults seeded on every board. Letting
  end-users add/persist their OWN libraries is a separate feature (not yet
  built).
- Check each library's license before bundling it into a shipped product.

This README is named .txt (not .md) on purpose: the repo .gitignore ignores
all *.md files, so a .md here would not be committed and the folder could
vanish from git.
