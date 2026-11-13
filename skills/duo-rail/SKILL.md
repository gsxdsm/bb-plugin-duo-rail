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

With a bb iOS app that supports native rail expansion (it advertises the
`rail-expansion` capability; iOS 27.1+), expanding goes further: the plugin
asks the app (`set-rail-expanded`) to turn the folded iPhone's vertical bar
off. iOS then draws the status bar across the top and removes the rail inset,
so bb uses the full width with its header below the status bar. Restore turns
the vertical bar back on. There is no separate app setting: the plugin's
expand/restore choice is the only switch, saved per device. The plugin keeps
track of the rail side while the inset is gone. On the folded screen, the Restore button sits in the top band
right next to the time. The plugin uses the app's top bar guide (`topBar`)
for where the time starts. Without it, it assumes the time and icons run
160pt left of the reported camera cut-out.

On the unfolded screen, Restore sits at the top of the left side rail, over
bb's sidebar toggle. bb's own thread header (title, its menu and controls)
moves up into the status row and stops before the time. If the header doesn't
fit there (for example with the sidebar open on a narrow window), bb's normal
header stays below the status band. "Unfolded" is decided from the screen
size, so opening the keyboard can't switch layouts. When that band is too thin to hold the
button (the unfolded screen), the button goes just below bb's header row at
the right edge. The button stays after a page reload. The plugin restores the
vertical bar when `mode` is `off` or the plugin is disabled or removed, but
not when the page reloads or the plugin is reloaded or updated. Requests are sent one at
a time, and rapid taps collapse to the last choice. If a request fails, the
plugin falls back to the CSS expansion.

Older apps and browsers keep the CSS expansion above; the iOS status bar stays
in the rail there.

## Detection

A bb iOS app that reports its window layout (`window.bb.native.windowLayout`)
names the vertical bar directly: there is a rail while the bar has an edge and
is not turned off, and its width is the side safe-area inset. The reported
occlusions (camera, Live Activities, the status column) give the height of the
block the cap covers.

Older apps and browsers fall back to inset detection: a rail is a left or
right safe-area inset while the window is portrait, or in landscape on an
unfolded Duo (shorter screen or window side of at least 500pt). A notched
single-screen iPhone in landscape is not treated as a rail. Nothing changes on
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

## Focus-zoom stopgap

On iOS WebKit the plugin adds `maximum-scale=1` to the page's viewport (unless
it already sets one) and restores it when unloaded. This applies whatever the
`mode`, on every iOS device. It stops iOS zooming in whenever a field gets
focus on wide screens such as the unfolded Duo. bb only sizes fields to 16px
below 768pt, and while zoomed, bb's layout stops following the keyboard.
Trade-off: inside the bb iOS app it usually also disables pinch-to-zoom on
the page. Remove it once get-bb/bb#7511 ships.

## Settings

Change these in Settings → Plugins → Duo Rail, or with `bb plugin config duo-rail set <key> <value>`:

- `mode`: `auto` (default) expands whenever a rail is found; `manual` waits
  for the toggle; `off` never changes the layout.
- `cameraAreaHeight`: height in points of the camera + status bar block at the
  top of the rail, 0–400, default 240. The cap covers it and the toggle sits
  just below it. Only a fallback: a bb iOS app that reports its window layout
  measures the block itself.
- `sideInset`: points kept clear on the rail side while expanded, 0–120,
  default 0.
