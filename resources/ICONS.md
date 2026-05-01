# App Icon Setup Guide

## Required Icon Files

electron-builder automatically looks for icons in the `resources` directory:

### macOS
- **icon.icns** - Main app icon (should contain multiple sizes: 16x16, 32x32, 128x128, 256x256, 512x512, 1024x1024)

### Windows
- **icon.ico** - Main app icon (should contain multiple sizes: 16x16, 32x32, 48x48, 256x256)

### Linux
- **icon.png** - Main app icon (at least 512x512, preferably 1024x1024)

## How to Generate Icons

### Option 1: Using electron-icon-builder (Recommended)

```bash
npm install --save-dev electron-icon-builder

# Create a 1024x1024 PNG icon first (e.g., icon-source.png)
# Then run:
npx electron-icon-builder --input=./icon-source.png --output=./resources --flatten
```

### Option 2: Using online tools

1. Create a 1024x1024 PNG icon
2. Use https://cloudconvert.com/ to convert:
   - PNG → ICNS (for macOS)
   - PNG → ICO (for Windows)
3. Place files in `resources/` directory

### Option 3: Manual (macOS)

```bash
# Create an iconset directory
mkdir icon.iconset

# Generate all required sizes from a 1024x1024 PNG
sips -z 16 16     icon-source.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon-source.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon-source.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon-source.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon-source.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon-source.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon-source.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon-source.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon-source.png --out icon.iconset/icon_512x512.png
sips -z 1024 1024 icon-source.png --out icon.iconset/icon_512x512@2x.png

# Convert to .icns
iconutil -c icns icon.iconset -o resources/icon.icns
```

## Current Setup

Your `electron-builder.yml` is already configured to use icons from the `resources` directory:

```yaml
directories:
  buildResources: resources
```

No additional configuration is needed - just place the icon files in `resources/`:

```
resources/
├── icon.icns    # macOS
├── icon.ico     # Windows
└── icon.png     # Linux
```

## Using the Icon in the App

To display the app icon within the UI (e.g., in the title bar or welcome screen), you can:

### Option 1: Use the bundled icon

In development, reference it from resources:
```typescript
<img src="resources/icon.png" alt="ADF" />
```

### Option 2: Inline SVG/emoji

Use the document emoji you're already using:
```typescript
<div className="text-6xl">📄</div>
```

### Option 3: Create a dedicated UI icon

Add an SVG logo to `src/renderer/assets/logo.svg` and import it:
```typescript
import Logo from '../../assets/logo.svg'
<img src={Logo} alt="ADF" />
```

## Testing

After adding icons:

1. **Development**: Icons won't show in dev mode (`npm run dev`)
2. **Build**: Run `npm run package` to create the app bundle
3. **Check**: Look at the generated app in `dist/` directory

## Quick Start

1. Create a 1024x1024 PNG icon with your ADF logo
2. Name it `icon-source.png` and place it in the project root
3. Run one of the generation methods above
4. Run `npm run package` to build with the new icon
