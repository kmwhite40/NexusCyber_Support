#!/usr/bin/env bash
# Fail when infrastructure pins a preview Azure API version.
#
# Azure retires preview API versions on a schedule (e.g. Service Health advisory
# 9G9S-SHG retired every Microsoft.DBforPostgreSQL preview up to 2025-06-01-preview).
# Pinning a GA version avoids those deadlines. When a preview is genuinely the
# right choice (no newer GA exists), opt in on the same line or the line above:
#
#   // api-preview-ok: newest diagnosticSettings API; only GA is 2016-09-01
#   resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
#
# Checks tracked *.bicep (resource pins) and *.sh/*.ps1/*.md (api-version= in
# az rest / REST URLs). Run from the repo root: scripts/check-azure-api-versions.sh
set -euo pipefail

PREVIEW='[0-9]{4}-[0-9]{2}-[0-9]{2}-(preview|privatepreview)'
PATTERN="@${PREVIEW}'|api-version=${PREVIEW}"
OPT_IN='api-preview-ok:'

fail=0
while IFS= read -r -d '' file; do
  prev=''
  lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    if [[ "$line" =~ $PATTERN ]] && [[ "$line" != *"$OPT_IN"* ]] && [[ "$prev" != *"$OPT_IN"* ]]; then
      echo "::error file=${file},line=${lineno}::Preview Azure API version '${BASH_REMATCH[0]//\'/}'. Pin a GA version, or add '${OPT_IN} <reason>' on this or the previous line."
      echo "  ${file}:${lineno}: ${line#"${line%%[![:space:]]*}"}"
      fail=1
    fi
    prev="$line"
  done < "$file"
done < <(git ls-files -z -- '*.bicep' '*.sh' '*.ps1' '*.md' ':!:**/node_modules/**')

if [ "$fail" -ne 0 ]; then
  echo
  echo "Preview Azure API versions found (see above)."
  exit 1
fi
echo "OK: no unapproved preview Azure API versions."
