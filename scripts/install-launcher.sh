#!/bin/bash
# 安装「Tryon 合集」启动器到 ~/Applications，并在桌面放替身
# 记下当前 PATH：从访达启动的 app 只有最小 PATH，找不到 codex
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
node="$(command -v node)"
cli="$repo/dist/cli.mjs"
[ -f "$cli" ] || { echo "先运行 npm run build" >&2; exit 1; }
app="$HOME/Applications/Tryon 合集.app"
source="$(cat "$repo/scripts/macos/launcher.applescript")"
# 去掉 npm run 临时加进来的 node_modules/.bin、node-gyp-bin
path_keep="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v -e 'node_modules/.bin' -e 'node-gyp-bin' | paste -sd: -)"
source="${source//__PATH__/$path_keep}"
source="${source//__NODE__/$node}"
source="${source//__CLI__/$cli}"
mkdir -p "$HOME/Applications"
rm -rf "$app"
tmp="$(mktemp -d)"
printf '%s\n' "$source" > "$tmp/launcher.applescript"
osacompile -o "$app" "$tmp/launcher.applescript"
# 图标：scripts/macos/icon.svg → applet.icns（sharp 出各尺寸 PNG，iconutil 打包）
mkdir -p "$tmp/icon.iconset"
(cd "$repo" && node -e '
const sharp = require("sharp"); const [svg, dir] = process.argv.slice(1)
const sizes = [16, 32, 128, 256, 512]
Promise.all(sizes.flatMap((n) => [
  sharp(svg, { density: 72 * n * 2 / 1024 }).resize(n, n).png().toFile(`${dir}/icon_${n}x${n}.png`),
  sharp(svg, { density: 72 * n * 4 / 1024 }).resize(n * 2, n * 2).png().toFile(`${dir}/icon_${n}x${n}@2x.png`),
])).catch((error) => { console.error(error); process.exit(1) })
' "$repo/scripts/macos/icon.svg" "$tmp/icon.iconset")
iconutil -c icns -o "$app/Contents/Resources/applet.icns" "$tmp/icon.iconset"
# 改了资源后重新做本机签名，否则签名失效
codesign --force --sign - "$app" 2>/dev/null
touch "$app"
rm -rf "$tmp"
rm -f "$HOME/Desktop/Tryon 合集" "$HOME/Desktop/Tryon 合集.app的替身"
osascript -e "tell application \"Finder\" to set name of (make alias file to POSIX file \"${app}\" at desktop) to \"Tryon 合集\"" >/dev/null
echo "已安装：${app}（桌面已放替身）"
