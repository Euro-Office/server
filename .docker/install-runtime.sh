#!/bin/sh
# SPDX-FileCopyrightText: 2026 Euro-Office contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# Copies the services and their installed node_modules into $1 with the layout
# of the installed server directory, plus the node binary from $PATH that the
# service wrappers (DocService/docservice, ...) run them with.
set -eu
dest=$1
cd "$(dirname "$0")/.."
for d in Common DocService FileConverter Metrics AdminPanel/server; do
  mkdir -p "$dest/$d"
  cp -a "$d/package.json" "$d/sources" "$d/node_modules" "$dest/$d/"
done
cp -a DocService/docservice "$dest/DocService/"
cp -a FileConverter/converter "$dest/FileConverter/"
cp -a Metrics/metrics "$dest/Metrics/"
cp -a AdminPanel/server/adminpanel "$dest/AdminPanel/server/"
install -m 755 "$(command -v node)" "$dest/node"
