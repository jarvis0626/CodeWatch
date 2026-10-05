# Work flow and pinned companion

CodeWatch's main live view shows the sequence of steps your coding agent reports.
Each card connects to the next with an arrow. Select a card to inspect its report,
reported files, saves during that step, test results and command outcomes. The
details also show known import or agent-reported links involving those files from
the current project map, rather than a historical dependency snapshot.

Selecting the same card again closes its details. Selecting it once more reopens
them; selecting a different card shows that step instead.

![CodeWatch pinned companion](codewatch-companion.png)

## Pin the work flow

Click **Always on top** in the Windows app. CodeWatch becomes a compact companion
window showing the work flow, latest agent report and reported working file. The
latest observed save appears separately, so a background file change does not
replace the agent's reported target.

When there is no active reported file path, the file panel shows the latest saved
file instead.

The compact window defaults to 540 by 720 pixels and can be resized. The step
flow scrolls inside it. Clicking a step opens its details in the same companion.
Clicking a file opens the full app's project map at that file.

**Open full app** restores the larger dashboard while retaining the pin.
**Show companion** returns to the compact view. **Unpin** returns to the full app
and disables Always on top. Full and compact window positions are remembered
separately, including full-window maximization.

Each new app launch opens the full dashboard. To follow the same steps remotely,
enable **Phone view** there and scan the QR code. See the [phone guide](phone-view.md).

## Read the steps

- **Current:** the agent's latest unfinished report.
- **Earlier report:** the agent moved to another step; completion was not reported.
- **Done (reported):** the agent explicitly reported this step or its task complete.
- **Failed:** a failed report. Failed tests and commands remain visible even if the agent subsequently reports the task complete.
- **Observed only:** file or result activity outside a reported step.

The arrows show report order. The file connections inside a selected step show
static imports or explicit agent reports. Neither is a recording of runtime calls.
Saved files are associated by event order with the active step; this does not prove
who edited them. Tests and commands retain their own source and actual reported
status. The command wrapper remains available for independently captured outcomes.

Selecting a step pauses **Follow current**. Incoming reports and saves preserve
that selection. Re-enable **Follow current** to track the latest step automatically.

The work flow needs a cooperating agent using the existing MCP reporting tools.
Without reports, saved files appear as observed activity. The companion has no
predicted steps or invented completion states.

## Session history

The backend and renderer retain up to 2,000 activity events separately from the
500-event general feed. Reconnecting to the same running backend restores this
activity evidence, including reported paths and file saves, despite later scan
updates. History remains in memory: quitting CodeWatch or switching to another
project starts a new observation session. Evidence beyond the retained limit is
not reconstructed.

## Verification

- [x] Unit checks for report order, completion, failures, retries and observed activity.
- [x] Backend and reducer checks for history retention, reconnect and project isolation.
- [x] Native checks for compact pinning, separate bounds, maximization, display clamping and IPC.
- [x] Browser checks for connected cards, changes per step, stable selection, current file priority and compact/full transitions.
- [x] Portable executable check for the rendered work flow and actual native resizing.
