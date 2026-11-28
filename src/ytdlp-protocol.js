// @ts-check
'use strict';

/** @param {number} height */
function isSupportedHeight(height) {
  return Number.isInteger(height) && height >= 144 && height <= 4320;
}

/** @param {number[]} heights */
function formatOptions(heights) {
  return [{ id: 'best', label: '最佳可用画质' },
    ...[...new Set(heights.filter(isSupportedHeight))].sort((a, b) => b - a)
      .map((height) => ({ id: `h:${height}`, label: `${height}p 及以下`, height }))];
}

/** @param {{formats?: ({vcodec?: string, height?: unknown} | null)[]}} info */
function formatsFromInfo(info) {
  const heights = (Array.isArray(info.formats) ? info.formats : [])
    .filter((format) => format && format.vcodec !== 'none')
    .map((format) => Number(format?.height));
  return formatOptions(heights);
}

/** @param {unknown} formatId */
function formatExpression(formatId) {
  if (formatId === 'best') return null;
  const match = /^h:(\d{2,4})$/.exec(String(formatId));
  const height = match ? Number(match[1]) : NaN;
  if (!isSupportedHeight(height)) {
    throw new Error('请选择有效的画质。');
  }
  return `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
}

/** @param {string} line */
function parseProgressLine(line) {
  const match = /\[download\]\s+([\d.]+)%/.exec(line);
  if (!match) return null;
  const percent = Math.max(0, Math.min(100, Number(match[1])));
  if (!Number.isFinite(percent)) return null;
  const speed = /\bat\s+(\S+)/.exec(line)?.[1];
  const eta = /\bETA\s+(\S+)/.exec(line)?.[1];
  return { percent, speed, eta, message: line.slice(0, 240) };
}

/**
 * @param {unknown} stderr
 * @param {string} [fallback]
 */
function explainYtdlpError(stderr, fallback = '视频处理失败。') {
  const output = String(stderr || '');
  if (/Redirection detected; the video may be deleted or require login/i.test(output)) {
    return '网站将视频页面重定向。请在网页登录窗口确认视频可播放，并完成网站要求的登录后重试。';
  }
  if (/No video formats found/i.test(output)) {
    return '未找到可下载画质。请在网页登录窗口确认视频可播放；若仍失败，可能是网站更新导致 yt-dlp 暂时无法提取。';
  }
  if (/HTTP Error 474/i.test(output)) {
    return '媒体服务器拒绝了此视频的下载地址（HTTP 474）。请尝试其他视频；若持续失败，请更新 yt-dlp 后重试。';
  }
  const errors = output.split(/\r?\n/).filter((line) => /^ERROR:/i.test(line.trim()));
  const detail = errors.at(-1)?.replace(/^\s*ERROR:\s*/i, '').trim();
  return detail ? detail.slice(0, 500) : fallback;
}

module.exports = { parseProgressLine, explainYtdlpError, formatOptions, formatsFromInfo, formatExpression };
