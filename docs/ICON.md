# Stillnote icon

The icon uses a folded-paper **S** for Stillnote. Two broad curves suggest the turns of a conversation, while the paper material connects the mark to notes. Warm ivory against a deep forest-green tile keeps the silhouette readable at Dock and small UI sizes. A pale pistachio underside ties it to the app's restrained green accents.

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
Design one finished macOS application icon for Stillnote, a calm, local meeting-notes app. Create an original, exceptionally polished, simple brand mark: a broad ivory folded-paper ribbon forming a clear flowing S, with two generous curves subtly suggesting two conversational turns. The shape must have a strong, instantly recognizable silhouette, not a typed letter, not a notebook illustration. A tiny visible pale pistachio underside on one fold adds a considered accent; the principal S remains warm ivory. Center it on a deep forest-green macOS squircle tile, very subtly shaded from mossy forest at the upper left to dark pine at the bottom. Native macOS icon craft: restrained dimensionality, softly beveled edges, delicate ambient shadow under the paper folds, smooth large forms, precise geometry, satin paper material, no plastic toy aesthetic, no busy texture. The S occupies about 62% of the tile width. Canvas 1024x1024, straight-on orthographic front view. Tile approximately 840x840, centered with even transparent padding, standard macOS rounded-square corners. Outside the tile and its very subtle drop shadow must be genuinely transparent. No letters other than the abstract S shape, no app name, no captions, no border, no sparkles, no microphone, no small lines, no surrounding objects, no presentation mockup. This is the production icon asset, not a design board. Prioritize legibility at 16, 32, and 64 pixels.
```

The generator returned a 1254 × 1254 PNG. The checked-in 1024 px export is a proportional resample; the artwork is not stretched or cropped.
