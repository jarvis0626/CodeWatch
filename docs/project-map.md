# Readable project map

The old live canvas tried to fit every indexed file into one diagram. With dozens
of files, that made the labels too small and the lines difficult to follow.

Available in **CodeWatch 0.2.1**. Quit an older desktop instance and open the new
portable executable to load this interface.

The live view now starts with your actual project folders. Each card shows how
many files it contains, how many local import links stay inside it, and how many
files changed during this observation session. Open a folder to see its child
folders and files. These are filesystem groups, not invented software components.

Search by file name or path to find a file anywhere in the project. Selecting a
file shows:

- **Uses code from:** files it directly imports.
- **Used by:** files that directly import it.
- **Agent-reported connections:** separately labelled relationships supplied by
  a cooperating agent, including their explanation.

Use a recent-change chip or click a file name in **File changes** to jump directly
to its connections. A deleted file remains in the change history and is explicitly
described as removed rather than recreated in the map.

**Show connection diagram** provides a small optional drawing of the selected
file and at most three neighbors on each side. The full connection lists remain
available above it. Saves, unrelated files and resizing do not automatically fit
the diagram again. **Recenter** deliberately restores the framing. Selecting
another file frames that new neighborhood once.

**Hide map** collapses the panel while observation continues. Showing it again
preserves the selected file and manual diagram viewport.

An import means a file uses code from another file. It does not establish execution
order, a runtime request path or a successful feature. Indexed files are labelled
as indexed; a saved-file event is labelled **Observed on disk**, not task completion.

## Verification checklist

- [x] Replace the default all-files canvas with folders, file lists and recent changes.
- [x] Add direct import explanations and separate agent-reported relationships.
- [x] Keep an optional bounded diagram and a map hide/show control.
- [x] Add grouping, direction, missing-neighbor and deletion unit checks.
- [x] Verify live file changes, a large project, manual viewport, collapse and mobile rendering in the browser.
- [x] Rebuild and verify the portable Windows executable for this UI update.

Validation on Windows: **19 frontend unit tests** and **7 browser tests** passed
across the demo and live suites. The large-project check covers folder counts,
directed import lists, new/deleted files, manual viewport preservation, hide/show,
clicking a file change and populated phone layouts.

The actual v0.2.1 portable executable passed its isolated desktop smoke test with
PATH restricted to Windows System32. It verified the default readable folder
view, import lists, hide/show, file watching, export, window preferences and clean
quit. The frozen helper separately passed the official MCP SDK handshake and all
seven tool discovery. [Artifact details](windows-packaging.md#project-map-update-v021).
