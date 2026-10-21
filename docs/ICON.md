# Stillnote icon

The active icon is **Conversation Fold**, selected by the user: two overlapping warm-ivory conversation cards on a forest-green macOS tile. The front card folds into a speech tail, connecting conversation with written notes.

The mark is original to this project and does not reuse Granola's logo or artwork. It was created with Codex's built-in image generation, then resampled into platform assets. No API key or image-generation SDK is required to rebuild the icon assets.

## Files

| File | Purpose |
| --- | --- |
| `assets/icon-master.png` | Unmodified generated master, 1254 × 1254, with transparency. |
| `assets/icon.png` | 1024 × 1024 application artwork. |
| `assets/icon-small.png` | 64 × 64 source for the in-app workspace mark. |
| `assets/icon.icns` | macOS icon family, from 16 px through 1024 px. |
| `scripts/make-icon.mjs` | Deterministic resizing and ICNS packaging from the checked-in master. |

Run `npm run icon` on macOS to regenerate the derived files. Run `npm run package` to include them in the local app. The earlier procedural notebook drawing has been replaced; running the icon script now preserves the selected design.

The master has transparent padding around the tile. The exported icon was inspected at 16, 32, 64, and 128 px on light and dark backgrounds, and the ICNS bundle was decoded to verify its contents. macOS may retain the previous Dock icon while the app is running; reopen Stillnote to load the update.

## Generation prompt

Method: Codex built-in `image_gen`, with `transparent_background: true`. This is a new generated asset, not an edit of Granola artwork or the previous icon.

```text
Use case: logo-brand
Asset type: polished macOS app icon for Stillnote, a calm meeting recorder and personal notes app.
Primary request: an original "Conversation Fold" icon. Two broad ivory paper conversation cards overlap, forming one compact sculptural conversational emblem. The front card has a single generous folded lower corner that also reads as a short speech tail; the rear card peeks out at upper left. No marks or text on either card. Strong readable silhouette at 32 pixels.
Scene/backdrop: one forest-green rounded-square macOS icon tile, inset about 10% from all canvas edges. True transparent alpha outside the tile, including the corners. Front facing square composition.
Style/medium: elegant tactile paper sculpture, crisp but softly rounded ivory card edges, single broad fold, subtle top-left lighting and convincing soft contact shadows. Deep matte forest-green tile with restrained bevel.
Color palette: warm ivory paper against deep forest green, no accent colors.
Constraints: one icon only, no collage, no text, no letters, no microphone, no headphones, no lines suggesting writing, no watermark, no external cast shadow. Avoid the existing folded S ribbon; the silhouette is two overlapping conversational notes.
```

The generator returned a 1254 × 1254 PNG. The checked-in 1024 px export is a proportional resample; the artwork is not stretched or cropped.
