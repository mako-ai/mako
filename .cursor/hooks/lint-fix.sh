#!/bin/bash
# afterFileEdit hook: auto-fix lint issues on edited .ts/.tsx files
# Reads JSON input from stdin with the edited file path

input=$(cat)
file_path=$(echo "$input" | jq -r '.path // empty')

if [ -z "$file_path" ]; then
  exit 0
fi

# Only lint TypeScript files
case "$file_path" in
  *.ts|*.tsx)
    npx eslint --fix "$file_path" 2>/dev/null
    ;;
esac

exit 0
