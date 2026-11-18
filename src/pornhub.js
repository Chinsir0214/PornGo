'use strict';

const SITE_HOST = 'pornhub.com';
const PREMIUM_HOST = 'pornhubpremium.com';

function isSiteHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\.+/, '');
  return host === SITE_HOST || host.endsWith(`.${SITE_HOST}`)
    || host === PREMIUM_HOST || host.endsWith(`.${PREMIUM_HOST}`);
}

function normalizeResourceUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) {
    throw new Error('请输入 Pornhub 视频、片单或色情明星视频页链接。');
  }
  const raw = input.trim();
  if (!raw || /[\u0000-\u001f\u007f\\]/.test(raw)) {
    throw new Error('链接格式无效。');
  }
  // URL() removes default ports and resolves dot segments, so check the original
  // authority and path before using its normalized components.
  const parts = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(raw);
  if (!parts || parts[1].includes(':')
      || /%|(?:^|\/)\.{1,2}(?:\/|$)/.test(parts[2])) {
    throw new Error('链接格式无效。');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('链接格式无效。');
  }
  if (!['http:', 'https:'].includes(url.protocol)
      || !(url.hostname === SITE_HOST || url.hostname.endsWith(`.${SITE_HOST}`))
      || url.username || url.password || url.port) {
    throw new Error('仅支持 Pornhub 视频、片单和色情明星视频页链接。');
  }

  const origin = `https://www.${SITE_HOST}`;
  const videoPath = url.pathname === '/view_video.php' || url.pathname === '/video/show';
  const embed = /^\/embed\/([a-zA-Z0-9]{4,64})\/?$/.exec(url.pathname);
  if (videoPath || embed) {
    if (videoPath && url.searchParams.getAll('viewkey').length !== 1) {
      throw new Error('视频链接缺少有效的 viewkey。');
    }
    const id = videoPath ? url.searchParams.get('viewkey') : embed[1];
    if (!/^[a-zA-Z0-9]{4,64}$/.test(id || '')) {
      throw new Error('视频链接缺少有效的 viewkey。');
    }
    return { url: `${origin}/view_video.php?viewkey=${id}`, kind: 'video', id };
  }

  const playlist = /^\/playlist\/([a-zA-Z0-9_-]{1,64})\/?$/.exec(url.pathname);
  if (playlist) {
    return { url: `${origin}/playlist/${playlist[1]}`, kind: 'playlist', id: playlist[1] };
  }

  const profile = /^\/(pornstar|model)\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})(?:\/videos)?\/?$/.exec(url.pathname);
  if (profile) {
    const [, section, id] = profile;
    const params = new URLSearchParams();
    if (url.searchParams.has('o')) {
      const values = url.searchParams.getAll('o');
      if (values.length !== 1 || !/^[a-z]{1,4}$/.test(values[0])) {
        throw new Error('排序参数无效。');
      }
      params.set('o', values[0]);
    }
    if (url.searchParams.has('page')) {
      const values = url.searchParams.getAll('page');
      if (values.length !== 1 || !/^[1-9]\d{0,3}$/.test(values[0])) {
        throw new Error('页码无效。');
      }
      params.set('page', values[0]);
    }
    const query = params.size ? `?${params}` : '';
    return { url: `${origin}/${section}/${id}/videos${query}`, kind: 'pornstar', id };
  }

  throw new Error('仅支持 Pornhub 视频、片单和色情明星视频页链接。');
}

function playlistEntriesFromHtml(html) {
  const entries = [];
  const seen = new Set();
  const pattern = /href="\/?view_video\.php\?[^"\s]*\bviewkey=([a-zA-Z0-9]{4,64})[^"]*"[^>]*\s+title="([^"]+)"/g;
  for (const match of String(html).matchAll(pattern)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ url: `https://www.pornhub.com/view_video.php?viewkey=${id}`,
      title: match[2].slice(0, 180) });
  }
  return entries;
}

function decodeHtmlText(value) {
  return String(value).replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<',
      '&gt;': '>', '&nbsp;': ' ' };
    const lower = entity.toLowerCase();
    if (named[lower]) return named[lower];
    const code = lower.startsWith('&#x')
      ? Number.parseInt(lower.slice(3, -1), 16) : Number.parseInt(lower.slice(2, -1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code) : entity;
  });
}

function pageDisplayTitle(html, kind, fallback) {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html))?.[1];
  if (!raw) return fallback;
  let title = decodeHtmlText(raw).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  title = title.replace(/\s*\|\s*Pornhub(?:\.com)?\s*$/i, '').trim();
  if (kind === 'playlist') title = title.replace(/\s*-\s*来自.+的色情片片单\s*$/, '').trim();
  if (kind === 'pornstar') {
    title = title.replace(/的全新色情片\d{4}\s*$/, '')
      .replace(/\s+(?:Porn\s+)?Videos(?:\s+\d{4})?\s*$/i, '').trim();
  }
  return title.slice(0, 180) || fallback;
}

function chineseTitleLanguage(value) {
  const language = String(value || '').toLowerCase().replaceAll('_', '-');
  if (/^(?:cn|zh|zh-cn|zh-sg|zh-hans(?:-.+)?)$/.test(language)) return 'simplified';
  if (/^(?:tw|zh-tw|zh-hk|zh-mo|zh-hant(?:-.+)?)$/.test(language)) return 'traditional';
  return null;
}

function htmlAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1].toLowerCase()] = decodeHtmlText(match[2] ?? match[3]);
  }
  return attributes;
}

function videoTitlesFromHtml(html, resource) {
  const source = String(html);
  const assignment = /\b(?:var|let|const)\s+VIDEO_SHOW\s*=\s*\{/.exec(source);
  let config;
  if (assignment) {
    const start = assignment.index + assignment[0].length - 1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index++) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        try { config = JSON.parse(source.slice(start, index + 1)); } catch { /* Not valid JSON. */ }
        break;
      }
    }
  }
  // Login/error redirects and unrelated video pages must never rename this video.
  if (!config || config.vkey !== resource.id) return null;
  const clean = (value) => typeof value === 'string'
    ? decodeHtmlText(value).replace(/\s+/g, ' ').trim() : '';
  const original = clean(config.videoTitleOriginal);
  const translated = clean(config.videoTitleTranslated);
  const language = chineseTitleLanguage(htmlAttributes(/<html\b[^>]*>/i.exec(source)?.[0] || '').lang);
  const alternatives = [];
  for (const match of source.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = htmlAttributes(match[0]);
    const alternateLanguage = chineseTitleLanguage(attributes.hreflang);
    if (!alternateLanguage || !String(attributes.rel).toLowerCase().split(/\s+/).includes('alternate')) continue;
    try {
      const url = new URL(attributes.href, resource.url);
      const alternate = normalizeResourceUrl(url.href);
      if (url.protocol !== 'https:' || alternate.kind !== 'video' || alternate.id !== resource.id) continue;
      alternatives.push({ url: url.href, language: alternateLanguage });
    } catch { /* Ignore unsupported or unrelated alternate links. */ }
  }
  return { original, translated: translated !== original ? translated : '', language, alternatives };
}

async function preferredVideoTitle(inputUrl, fetchPage, isCancelled = () => false) {
  const resource = normalizeResourceUrl(inputUrl);
  if (resource.kind !== 'video') return null;
  const chineseUrl = resource.url.replace('://www.', '://cn.');
  const seen = new Set();
  let original = '';
  let traditional = '';
  const pages = [{ url: chineseUrl, language: 'simplified' }];
  while (pages.length && !isCancelled()) {
    const page = pages.shift();
    if (seen.has(page.url)) continue;
    seen.add(page.url);
    let titles;
    try { titles = videoTitlesFromHtml(await fetchPage(page.url), resource); }
    catch { /* Optional title lookup must not prevent the media download. */ }
    if (isCancelled()) return null;
    if (!titles) {
      // The default page can still supply the upload title and advertised locales.
      if (page.url === chineseUrl) pages.push({ url: resource.url });
      continue;
    }
    original ||= titles.original;
    if (titles.language === 'simplified' && titles.translated) return titles.translated;
    if (titles.language === 'traditional') traditional ||= titles.translated;
    pages.push(...titles.alternatives);
    pages.sort((a, b) => (a.language === 'traditional') - (b.language === 'traditional'));
  }
  return isCancelled() ? null : traditional || original || null;
}

function isSiteCookie(cookie) {
  return cookie && isSiteHost(cookie.domain)
    && typeof cookie.name === 'string' && typeof cookie.value === 'string'
    && !/[\t\r\n]/.test(cookie.name + cookie.value)
    && cookie.name.length > 0;
}

function serializeCookies(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Generated temporarily by PornGo; do not share.'];
  for (const cookie of cookies.filter(isSiteCookie)) {
    const domain = cookie.domain.toLowerCase();
    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const host = cookie.httpOnly ? `#HttpOnly_${domain}` : domain;
    const cookiePath = cookie.path && cookie.path.startsWith('/') && !/[\t\r\n]/.test(cookie.path)
      ? cookie.path : '/';
    const expiry = cookie.session || !Number.isFinite(cookie.expirationDate)
      ? '0' : String(Math.floor(cookie.expirationDate));
    lines.push([host, includeSubdomains, cookiePath, cookie.secure ? 'TRUE' : 'FALSE', expiry,
      cookie.name, cookie.value].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

function isSupportedHeight(height) {
  return Number.isInteger(height) && height >= 144 && height <= 4320;
}

function formatOptions(heights) {
  return [{ id: 'best', label: '最佳可用画质' },
    ...[...new Set(heights.filter(isSupportedHeight))].sort((a, b) => b - a)
      .map((height) => ({ id: `h:${height}`, label: `${height}p 及以下`, height }))];
}

function formatsFromInfo(info) {
  const heights = (Array.isArray(info.formats) ? info.formats : [])
    .filter((format) => format && format.vcodec !== 'none')
    .map((format) => Number(format.height));
  return formatOptions(heights);
}

function formatExpression(formatId) {
  if (formatId === 'best') return null;
  const match = /^h:(\d{2,4})$/.exec(String(formatId));
  const height = match ? Number(match[1]) : NaN;
  if (!isSupportedHeight(height)) {
    throw new Error('请选择有效的画质。');
  }
  return `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
}

function parseProgressLine(line) {
  const match = /\[download\]\s+([\d.]+)%/.exec(line);
  if (!match) return null;
  const percent = Math.max(0, Math.min(100, Number(match[1])));
  if (!Number.isFinite(percent)) return null;
  const speed = /\bat\s+(\S+)/.exec(line)?.[1];
  const eta = /\bETA\s+(\S+)/.exec(line)?.[1];
  return { percent, speed, eta, message: line.slice(0, 240) };
}

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

module.exports = {
  isSiteHost,
  normalizeResourceUrl,
  playlistEntriesFromHtml,
  pageDisplayTitle,
  chineseTitleLanguage,
  videoTitlesFromHtml,
  preferredVideoTitle,
  isSiteCookie,
  serializeCookies,
  formatOptions, formatsFromInfo,
  formatExpression,
  parseProgressLine,
  explainYtdlpError,
};
