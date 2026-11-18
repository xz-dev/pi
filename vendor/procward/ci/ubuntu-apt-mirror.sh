#!/bin/sh
# SPDX-License-Identifier: BSD-3-Clause
# CI-only signed Ubuntu archive selection; never runs APT or changes trust keys.
set -eu
root=${1-}
# Waterloo is a registered Ubuntu archive mirror and also mirrors ubuntu-ports.
# Keep APT's existing suites, components, Signed-By keyrings and signature checks.
for file in "$root/etc/apt/sources.list" \
    "$root/etc/apt/apt-mirrors.txt" "$root/etc/apt/apt-mirrors-security.txt" \
    "$root/etc/apt/sources.list.d/"*.list "$root/etc/apt/sources.list.d/"*.sources; do
    [ -f "$file" ] || continue
    sed -E -i \
        -e 's@https?://(azure\.archive|archive|security)\.ubuntu\.com/ubuntu/?@https://mirror.csclub.uwaterloo.ca/ubuntu/@g' \
        -e 's@https?://ports\.ubuntu\.com/ubuntu-ports/?@https://mirror.csclub.uwaterloo.ca/ubuntu-ports/@g' \
        "$file"
done
