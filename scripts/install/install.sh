#!/bin/bash
set -euo pipefail

fail() { printf '%s\n' "$*" 'Manual download / 手动下载: https://github.com/YondFane/uTerm/releases/latest' >&2; exit 1; }
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
locked=false
cleanup() {
  if [[ "$mounted" == true ]]; then hdiutil detach "$work/mount" -quiet || true; fi
  if [[ "$locked" == true ]]; then rmdir "$cache/installer.lock" 2>/dev/null || true; fi
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
hash=$(plutil -extract "installers.$target.sha256" raw -o - "$work/feed.json" 2>/dev/null || true)
size=$(plutil -extract "installers.$target.size" raw -o - "$work/feed.json" 2>/dev/null || true)
installer="$work/uTerm.dmg"
verified=false
if [[ -n "$hash$size" ]]; then
  [[ "$hash" =~ ^[a-f0-9]{64}$ && "$size" =~ ^[1-9][0-9]{0,8}$ && "$size" -le 536870912 ]] || fail 'Invalid installer information / 安装包信息无效'
  cache="$HOME/Library/Caches/sh.uterm.desktop/installer-cache-v1"
  mkdir -p "$cache" || fail 'Cache is not writable / 缓存不可写'
  mkdir "$cache/installer.lock" 2>/dev/null || fail 'Another installer is running; remove a stale lock only after it exits / 另一个安装器正在运行；确认已退出后才可移除残留锁目录'
  locked=true
  installer="$cache/$target-$hash.part"
  # Keep bounded, version-specific downloads; the active file is protected by the lock.
  # 保留数量受限且绑定版本的下载；当前文件由锁保护。
  find "$cache" -type f -name '*.part' -mtime +7 ! -name "$target-$hash.part" -delete
  count=0
  for cached in "$cache"/*.part; do
    [[ -f "$cached" && "$cached" != "$installer" ]] || continue
    count=$((count + 1))
    if [[ "$count" -gt 3 ]]; then rm -f "$cached"; fi
  done
fi
check_installer() {
  [[ -f "$installer" && -n "$hash" && "$(stat -f%z "$installer")" == "$size" && "$(shasum -a 256 "$installer" | cut -d ' ' -f 1)" == "$hash" ]]
}
if check_installer; then verified=true; fi
if [[ "$verified" == false && -n "$hash" && -f "$installer" && "$(stat -f%z "$installer")" -ge "$size" ]]; then rm -f "$installer"; fi
if [[ "$verified" == false ]]; then
  for attempt in 0 1 2; do
    download_args=(--fail --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 1800 -D "$work/headers")
    if [[ -n "$hash" && -f "$installer" ]]; then download_args+=(-C -); fi
    if curl "${download_args[@]}" "$base/uTerm-v$version/uTerm-$version-$target.dmg" -o "$installer"; then
      if [[ -z "$hash" ]] || check_installer; then verified=true; break; fi
      rm -f "$installer"
      fail 'Installer verification failed / 安装包校验失败'
    else
      code=$?
    fi
    case "$code" in
      33|36) rm -f "$installer" ;;
      5|6|7|18|28|52|55|56) ;;
      22)
        status=$(awk '/^HTTP\// {code=$2} END {print code}' "$work/headers")
        case "$status" in
          408|429|500|502|503|504) ;;
          416) rm -f "$installer" ;;
          404) fail 'Installer was not found / 找不到安装包' ;;
          *) fail 'Download rejected by server / 服务器拒绝下载' ;;
        esac
        retry_after=$(awk 'tolower($1)=="retry-after:" {gsub("\r", "", $2); value=$2} END {print value}' "$work/headers")
        if [[ -n "$retry_after" ]]; then
          [[ "$retry_after" =~ ^[0-9]{1,2}$ && "$retry_after" -le 30 ]] || fail 'Download source is busy; retry later / 下载源繁忙，请稍后重试'
          sleep "$retry_after"
        fi
        ;;
      23|26) fail 'Cannot read or write download; check space and permissions / 无法读写下载文件，请检查空间和权限' ;;
      60) fail 'Certificate verification failed / 证书验证失败' ;;
      *) fail 'Download failed / 下载失败' ;;
    esac
    [[ "$attempt" -lt 2 ]] && sleep $((1 << attempt))
  done
fi
[[ "$verified" == true ]] || fail 'Download interrupted; retry to continue / 下载中断，请重试继续'
hdiutil attach "$installer" -readonly -nobrowse -mountpoint "$work/mount" -quiet
mounted=true
[[ -d "$work/mount/uTerm.app" ]] || fail 'Missing uTerm.app. / 安装包缺少 uTerm.app。'
mkdir -p "$HOME/Applications"
staging=$(mktemp -d "$HOME/Applications/.uterm-install.XXXXXX")
trap 'rm -rf "$staging"; cleanup' EXIT
ditto "$work/mount/uTerm.app" "$staging/uTerm.app"
[[ ! -e "$destination" && ! -L "$destination" ]] || fail 'Destination already exists. / 目标已存在。'
mv -n "$staging/uTerm.app" "$destination"
printf '%s\n' 'Installed in ~/Applications/uTerm.app. Open it from Finder. / 已安装到 ~/Applications/uTerm.app，请从访达打开。' 'First launch may require approval in Privacy & Security. / 首次启动可能需要在“隐私与安全”中批准。'
