#!/usr/bin/env bash
# Concatenates all guide files into ADF_STUDIO_DOCS.md
# Usage: ./docs/build-docs.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GUIDES_DIR="$SCRIPT_DIR/guides"
OUTPUT="$SCRIPT_DIR/ADF_STUDIO_DOCS.md"

# Ordered list of guide files
GUIDES=(
  getting-started.md
  core-concepts.md
  creating-agents.md
  agent-states.md
  documents-and-files.md
  tools.md
  code-execution.md
  adf-object.md
  mcp-integration.md
  triggers.md
  messaging.md
  lan-discovery.md
  timers.md
  security-and-identity.md
  memory-management.md
  tasks.md
  logging.md
  serving.md
  settings.md
)

# Header
cat > "$OUTPUT" << 'HEADER'
# ADF Studio Documentation

Welcome to the ADF Studio documentation. ADF Studio is a desktop application for creating, configuring, and managing autonomous AI agents packaged as portable `.adf` files.

## What is ADF?

The **Agent Document File** (`.adf`) is a self-contained SQLite database that bundles an AI agent's memory, logic, configuration, and communication history into a single portable file. Each `.adf` file represents one agent paired with one primary document — the atomic unit of the ADF ecosystem.

ADF Studio is the visual IDE for working with these files. You can create agents, configure their behavior, give them tools, set up triggers, and watch them collaborate through a built-in messaging mesh.

HEADER

# Append each guide
for guide in "${GUIDES[@]}"; do
  file="$GUIDES_DIR/$guide"
  if [ ! -f "$file" ]; then
    echo "Warning: $guide not found, skipping" >&2
    continue
  fi
  echo "---" >> "$OUTPUT"
  echo "" >> "$OUTPUT"
  cat "$file" >> "$OUTPUT"
  echo "" >> "$OUTPUT"
done

echo "Built $OUTPUT ($(wc -l < "$OUTPUT") lines)"
