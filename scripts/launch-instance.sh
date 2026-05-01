#!/bin/bash
# Launch ADF with a specific instance number
# Usage: ./launch-instance.sh [instance_number]
# Example: ./launch-instance.sh 2

INSTANCE=${1:-1}

if [ "$INSTANCE" = "1" ]; then
  echo "Launching ADF instance 1 (default)"
  npm run dev
else
  echo "Launching ADF instance $INSTANCE"
  ADF_INSTANCE=$INSTANCE npm run dev
fi
