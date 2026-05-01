#!/bin/bash

# Icon Generator Script for ADF
# Generates all required icon formats from a single source PNG

set -e

SOURCE_ICON="$1"
OUTPUT_DIR="./resources"

if [ -z "$SOURCE_ICON" ]; then
  echo "Usage: ./scripts/generate-icons.sh <source-icon.png>"
  echo ""
  echo "The source icon should be a 1024x1024 PNG file"
  exit 1
fi

if [ ! -f "$SOURCE_ICON" ]; then
  echo "Error: Source icon file not found: $SOURCE_ICON"
  exit 1
fi

echo "Generating icons from: $SOURCE_ICON"
echo "Output directory: $OUTPUT_DIR"
echo ""

# Check if running on macOS
if [[ "$OSTYPE" == "darwin"* ]]; then
  echo "✓ macOS detected - will generate .icns file"

  # Create iconset directory
  ICONSET_DIR="./icon.iconset"
  rm -rf "$ICONSET_DIR"
  mkdir -p "$ICONSET_DIR"

  # Generate all required sizes
  sips -z 16 16     "$SOURCE_ICON" --out "$ICONSET_DIR/icon_16x16.png" > /dev/null
  sips -z 32 32     "$SOURCE_ICON" --out "$ICONSET_DIR/icon_16x16@2x.png" > /dev/null
  sips -z 32 32     "$SOURCE_ICON" --out "$ICONSET_DIR/icon_32x32.png" > /dev/null
  sips -z 64 64     "$SOURCE_ICON" --out "$ICONSET_DIR/icon_32x32@2x.png" > /dev/null
  sips -z 128 128   "$SOURCE_ICON" --out "$ICONSET_DIR/icon_128x128.png" > /dev/null
  sips -z 256 256   "$SOURCE_ICON" --out "$ICONSET_DIR/icon_128x128@2x.png" > /dev/null
  sips -z 256 256   "$SOURCE_ICON" --out "$ICONSET_DIR/icon_256x256.png" > /dev/null
  sips -z 512 512   "$SOURCE_ICON" --out "$ICONSET_DIR/icon_256x256@2x.png" > /dev/null
  sips -z 512 512   "$SOURCE_ICON" --out "$ICONSET_DIR/icon_512x512.png" > /dev/null
  sips -z 1024 1024 "$SOURCE_ICON" --out "$ICONSET_DIR/icon_512x512@2x.png" > /dev/null

  # Convert to .icns
  iconutil -c icns "$ICONSET_DIR" -o "$OUTPUT_DIR/icon.icns"
  rm -rf "$ICONSET_DIR"

  echo "✓ Generated: $OUTPUT_DIR/icon.icns"
else
  echo "⚠ Not on macOS - skipping .icns generation"
  echo "  Use an online converter or electron-icon-builder for .icns files"
fi

# Copy source as Linux icon (1024x1024 PNG)
cp "$SOURCE_ICON" "$OUTPUT_DIR/icon.png"
echo "✓ Generated: $OUTPUT_DIR/icon.png"

# For Windows .ico, recommend using a tool
echo ""
echo "Note: For Windows .ico file, use one of these methods:"
echo "  1. Online: https://cloudconvert.com/png-to-ico"
echo "  2. npm: npx electron-icon-builder --input=$SOURCE_ICON --output=./resources --flatten"
echo ""
echo "Done! Icon files generated in $OUTPUT_DIR/"
echo ""
echo "Next steps:"
echo "  1. Generate .ico file for Windows (see note above)"
echo "  2. Run: npm run package"
echo "  3. Check the app icon in the dist/ folder"
