# README demos

These GIFs are stored in the repository and displayed directly by GitHub Markdown.
No image-hosting account or external tracking endpoint is required.

- `work-flow.gif`: the running web dashboard receiving scripted planning,
  implementation, validation, and completion reports through the local producer API.
  A temporary Python project is watched; `login.py` is actually modified on disk.
  The final frame opens the implementation card to show files and an observed import.
  This is a controlled example, not a recording of an autonomous coding agent.
- `reporting-modes.gif`: the running integration panel switching between Light and
  Detailed, saving the choice in the backend while the MCP configuration stays
  unchanged. Agent instructions are no longer shown in the app.

The work-flow frames were captured on 2026-10-07 from source commit `092e9a5`;
the mode frames were refreshed from the automatic mode-selection update.
Both use headless Chromium and Playwright. GIFs assemble actual UI screenshots with timed holds; they are not
continuous screen recordings. No UI state or feature was drawn into the images.
Frames were padded to a common canvas and palette-quantized with Pillow.
The capture uses a disposable example project and exposes no credentials or pairing links.

Static alternatives: [work flow](../codewatch-work-flow.png),
[compact companion](../codewatch-companion.png), and [phone view](../codewatch-phone.png).

To refresh: start the source backend with the built frontend, attach a temporary
project, submit example reports to `/api/agent/progress` and `/api/agent/complete`,
modify a watched file, and capture `#work-flow` after each update. For mode selection,
capture `#connect` after selecting Light and Detailed. Keep examples labelled and
avoid capturing real source code, command output, tokens, or private paths.
