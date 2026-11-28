# Bundled tools

将发行版二进制文件放在此目录即可随应用一起分发：

- Windows: `yt-dlp.exe`、`ffmpeg.exe`
- macOS / Linux: `yt-dlp`、`ffmpeg`

发行版会直接携带这两个工具，应用启动时优先使用打包资源中的文件。

Windows x64 工具版本、固定下载地址及 SHA-256 记录在 [tool-versions.json](tool-versions.json)。在 Windows PowerShell 中运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-tools.ps1
```

脚本发现本地文件哈希正确时直接复用，否则下载到临时目录，校验下载包及解出的程序后放入 `tools/`。仅校验已有文件（不会联网）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-tools.ps1 -VerifyOnly
```

## Windows 工具版本与来源

- `yt-dlp.exe` 使用 [yt-dlp 2026.10.26 官方发布](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26)，SHA-256 为 `f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d`。官方 Windows 可执行文件要求 Windows 10 或更新版本，所需 Python 已内置。参见[源码归档](https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.tar.gz)、[项目许可证](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/LICENSE)和 [Windows 可执行文件的第三方许可证](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/THIRD_PARTY_LICENSES.txt)。
- `ffmpeg.exe` 使用 BtbN 的 Windows x64 GPL 静态构建 `N-128121-g86444dd368-20261027`，原发布标签为 `autobuild-2026-10-27-18-38`。原归档 `ffmpeg-N-128121-g86444dd368-win64-gpl.zip` 的 SHA-256 为 `1eb70a550388567bc2abbb2d164814f722f36a034fd927dcdfb217bc7e94930c`，解出的程序为 `5db27a218bd47831a0f44f6201fd54eb62ba7c082687e797316ae088d0ecf3d3`。该程序的配置包含 `--enable-gpl --enable-version3`。参见 [FFmpeg 源码提交](https://github.com/FFmpeg/FFmpeg/commit/86444dd36834875f274f57705762c5448379d644)、[该提交的源码归档](https://github.com/FFmpeg/FFmpeg/archive/86444dd36834875f274f57705762c5448379d644.tar.gz)、[GPL v3 许可证](https://github.com/FFmpeg/FFmpeg/blob/86444dd36834875f274f57705762c5448379d644/COPYING.GPLv3)、[BtbN Win64 GPL 构建记录](https://github.com/FFmpeg-Builds/FFmpeg-Builds/actions/runs/40502414924/job/122373576348)和[构建脚本](https://github.com/FFmpeg-Builds/FFmpeg-Builds/tree/b4a2b1d7cc241786eb8e2b588a7ade40cad48bbd)。

本次更新已核对官方 GitHub 发行资产 SHA-256，并通过本地 HTTP 媒体信息提取、独立音视频流合并、中文标题与创建日期嵌入、`PORNGO_FILE` 输出解析及合并文件解码验证。

## 上游下载返回 404 时

`tools/*.exe` 被 Git 忽略。工具清单锁定了具体发布版本和校验值。BtbN 仅保留最近 14 个每日构建和最近两年的月末构建，旧标签过期后下载可能返回 404。[上游保留策略](https://github.com/FFmpeg-Builds/FFmpeg-Builds#release-retention-policy)

下次更新 FFmpeg 时，建议选用 BtbN 的月末构建，以便在较长时间内从原地址下载。

1. 下载并安装 Windows 安装版 `PornGo-0.9.7-setup.exe`。[PornGo v0.9.7](https://github.com/Chinsir0214/PornGo/releases/tag/v0.9.7)
2. 将安装目录 `resources\tools` 中的 `yt-dlp.exe` 和 `ffmpeg.exe` 复制到仓库的 `tools` 目录。
3. 在仓库根目录运行 `npm run verify:tools`。校验通过后即可运行 `npm start` 或继续打包。
