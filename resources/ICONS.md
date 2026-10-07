# App icons

Source: `resources/icons/icon.svg`. It is the `.A` mark from `adf-org/brand/logo/adf-mark-light.svg` (geometry and colours unchanged) on a solid white (`#ffffff`, light `--paper`) rounded square, as `adf-org/brand/BRAND.md` §10 specifies for platform icon grids. The square is the mark's bounding box plus one dot diameter of clear space on each side; corner radius 22.5%.

Do not edit the generated files by hand. Edit `icon.svg`, then run:

```bash
node scripts/generate-icons.mjs
```

The script rasterises with `sharp` (librsvg) and writes the `.ico` and `.icns` containers itself, so it runs on any OS. No `sips` or `iconutil` is needed.

## Outputs

| File | Sizes | Layout | Used by |
| --- | --- | --- | --- |
| `resources/icon.png` | 1024 | full-bleed | `BrowserWindow` icon (`src/main/index.ts`) |
| `resources/icons/png/<n>x<n>.png` | 16, 24, 32, 48, 64, 128, 256, 512, 1024 | full-bleed | Linux (`electron-builder.yml` uses `512x512.png`) |
| `resources/icons/win/icon.ico` | 16, 24, 32, 48, 64, 128, 256 (32-bit BMP entries) | full-bleed | Windows app, installer, `.adf` file association |
| `resources/icons/mac/icon.icns` | 16 to 1024 (PNG entries) | Apple grid: 824 px tile in a 1024 px canvas | macOS app, `.adf` file association |
| `resources/tray/trayTemplate.png`, `@2x` | 18x16, 36x32 | bare mark, black + alpha (macOS template image) | macOS menu bar icon (`src/main/tray/`) |

Every size is rendered from the vector, not downscaled from 1024. Check 16 and 32 px after any change: the mark must stay legible there (brand minimum is 16 px).

The `sharp` dependency is currently transitive (via `@whiskeysockets/baileys`). If that changes, add it as a dev dependency.

## In-app logo

The title bar and About tab use the wordmark (`.ADF`), not the app icon. See `src/renderer/assets/brand/` and `src/renderer/components/common/Wordmark.tsx`.
