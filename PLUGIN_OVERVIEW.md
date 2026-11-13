On a folded iPhone Duo the cover screen keeps a side rail beside the camera. iOS reports it to the bb app as a safe-area inset, so bb normally leaves the whole rail empty. Duo Rail lets the conversation use that space without putting anything under the camera or the status bar.

## What it does

- **Expands the chat into the rail.** Below the camera area, the transcript and the composer run to the edge of the screen.
- **Keeps the camera area clear.** The thread header stops beside the camera and the iOS status bar. An opaque cap in your theme's background colour covers that block, so text scrolls under it instead of under the clock and battery icons.
- **Rail buttons.** A button in the rail, just below the camera area, switches between expanded and restored. While the rail is restored, a second button opens bb's sidebar. Both hide while a sheet or dialog is open.

The plugin acts when it finds a side inset in portrait, or in landscape on the unfolded Duo. Notched single-screen iPhones in landscape and every other device are left alone.

## Settings

- **Mode**: Auto expands whenever a rail is found, Manual waits for the button, Off disables the plugin.
- **Camera and status bar area height**: the block the cap covers and the buttons sit below. Default 240pt.
- **Rail-side inset**: points to keep clear on the rail side while expanded. Default 0.

iOS draws the status bar in the rail, and a plugin cannot move it. The bb iOS app can: **Status bar at top** in its Settings → This device → Cover screen moves the status bar to the top and gives the app the full width. There is no rail then, so Duo Rail stands down. When the app reports its window layout, the cap covers exactly the camera and status block it measures instead of the configured height.
