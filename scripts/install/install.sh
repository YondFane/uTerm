#!/bin/bash
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || fail 'macOS only. / 仅支持 macOS。'
arch=$(uname -m)
if [[ "$arch" == arm64 ]] || [[ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" == 1 ]]; then
  target=darwin-aarch64
elif [[ "$arch" == x86_64 ]]; then
  target=darwin-x86_64
else
  fail 'Unsupported architecture. / 不支持此芯片架构。'
fi
[[ $EUID != 0 ]] || fail 'Run without sudo. / 请勿使用 sudo。'
destination="$HOME/Applications/uTerm.app"
[[ ! -e "$destination" && ! -L "$destination" && ! -e /Applications/uTerm.app ]] || fail 'uTerm already exists. Update from Settings. / uTerm 已存在，请在设置中更新。'
work=$(mktemp -d)
mounted=false
cleanup() {
  if [[ "$mounted" == true ]]; then hdiutil detach "$work/mount" -quiet || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
base=https://github.com/YondFane/uTerm/releases/download
curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 20 --max-time 120 "$base/uTerm-updates/latest-$target.json" -o "$work/feed.json"
version=$(plutil -extract version raw -o - "$work/feed.json")
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail 'Invalid stable version. / 稳定版本号无效。'
printf 'Downloading uTerm %s / 正在下载 uTerm %s\n' "$version" "$version"
curl --fail --show-error --location --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 20 --max-time 1800 "$base/uTerm-v$version/uTerm-$version-$target.dmg" -o "$work/uTerm.dmg"
hdiutil attach "$work/uTerm.dmg" -readonly -nobrowse -mountpoint "$work/mount" -quiet
mounted=true
[[ -d "$work/mount/uTerm.app" ]] || fail 'Missing uTerm.app. / 安装包缺少 uTerm.app。'
mkdir -p "$HOME/Applications"
staging=$(mktemp -d "$HOME/Applications/.uterm-install.XXXXXX")
trap 'rm -rf "$staging"; cleanup' EXIT
ditto "$work/mount/uTerm.app" "$staging/uTerm.app"
[[ ! -e "$destination" && ! -L "$destination" ]] || fail 'Destination already exists. / 目标已存在。'
mv -n "$staging/uTerm.app" "$destination"
printf '%s\n' 'Installed in ~/Applications/uTerm.app. Open it from Finder. / 已安装到 ~/Applications/uTerm.app，请从访达打开。' 'First launch may require approval in Privacy & Security. / 首次启动可能需要在“隐私与安全”中批准。'
