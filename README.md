# Duo Rail

A bb plugin for the folded iPhone Duo. It expands the bb chat into the cover
screen's side rail and keeps the header and other UI clear of the camera and
the iOS status bar at the top of the rail. iOS still draws the status bar
there; a web plugin cannot move it.

See [skills/duo-rail/SKILL.md](skills/duo-rail/SKILL.md) for detection,
the toggle and the settings.

## How it works

bb pads its shell with Tailwind classes such as
`pr-[env(safe-area-inset-right)]`. A content script measures the safe-area
insets with a hidden probe. When it finds a side inset in portrait, or in landscape on an unfolded Duo (the rail), it
sets `data-bb-duo-rail` on `<html>`, and `data-bb-duo-rail-expanded` while
expanded. In expanded mode a stylesheet drops the shell's side inset, gives
the header row a margin equal to the rail, and shows an opaque cap over the
camera area (`cameraAreaHeight`). A toggle button, positioned in the rail
from the measured inset, switches modes per device. Disabling the plugin
removes the style, probe, cap, button and attributes.

## Install

```
bb plugin install git:https://github.com/gsxdsm/bb-plugin-duo-rail.git@^0.1.0
```

## Develop

```
npm install --include=dev
bb plugin install .
bb plugin dev
```

## License

Apache-2.0
