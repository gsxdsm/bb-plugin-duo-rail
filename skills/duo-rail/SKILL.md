---
name: duo-rail
description: Explain or configure the Duo Rail bb plugin, which expands the bb chat into the folded iPhone Duo side rail while keeping UI clear of the camera and status bar.
---

# Duo Rail

Duo Rail changes bb's layout on a folded iPhone Duo. The cover screen keeps a
side rail. The top of the rail holds the camera and the iOS status bar (time,
battery, wifi). iOS reports the rail to the bb WebView as a left or right
safe-area inset, so bb normally stops the whole UI short of it.

When the rail is expanded, the plugin:

- lets the transcript and composer fill the rail below the camera area
  (`sideInset`, default 0, keeps a strip clear if needed);
- keeps the thread header beside the camera area, never under it;
- covers the camera area with an opaque cap in the theme background, so the
  transcript scrolls under it instead of colliding with the status icons.

The plugin cannot move or hide the iOS status bar. iOS draws it in the rail;
only the native bb app could hide it.

## Detection

A rail is a left or right safe-area inset while the window is portrait. A
notched iPhone in landscape is not treated as a rail. Nothing changes on
devices without a rail.

## Toggle

A round toggle button sits in the rail, centred, just below the camera area,
in both states. Tap it to expand or restore. The open thread's menu also has
**Expand into rail** / **Restore side rail**. The choice is stored per device
in localStorage. The button is hidden when no rail is detected, when `mode` is
`off`, and while a bb sheet or dialog is open.

While the rail is not expanded, a second button below it opens bb's sidebar.
It clicks bb's own sidebar trigger, since the plugin SDK has no sidebar API.
It is hidden while expanded, when `mode` is `off`, and while the sidebar or any
other sheet or dialog is open.

## Settings

Change these in Settings → Plugins → Duo Rail, or with `bb plugin config duo-rail set <key> <value>`:

- `mode`: `auto` (default) expands whenever a rail is found; `manual` waits
  for the toggle; `off` never changes the layout.
- `cameraAreaHeight`: height in points of the camera + status bar block at the
  top of the rail, 0–400, default 240. The cap covers it and the toggle sits
  just below it.
- `sideInset`: points kept clear on the rail side while expanded, 0–120,
  default 0.
