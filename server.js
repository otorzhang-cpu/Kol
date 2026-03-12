const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 统一规范化链接：去首尾空白、解码、转小写便于匹配
function normalizeUrl(url) {
  if (typeof url !== 'string') return '';
  try {
    let u = url.trim().replace(/\s+/g, '');
    // 多次解码以处理双重编码
    for (let i = 0; i < 3; i++) {
      try { u = decodeURIComponent(u); } catch (_) { break; }
    }
    return u;
  } catch (_) { return url.trim(); }
}

function extractYoutubeId(url) {
  const u = normalizeUrl(url);
  // 支持任意子域：www/m/youtube.com 及 youtu.be，且不区分大小写
  const patterns = [
    /(?:youtube\.com|youtu\.be)\/watch\?[^#]*v=([^&\s?#]+)/i,
    /youtu\.be\/([^/?&\s]+)/i,
    /(?:www\.|m\.)?youtube\.com\/embed\/([^/?&\s]+)/i,
    /(?:www\.|m\.)?youtube\.com\/shorts\/([^/?&\s]+)/i,
    /(?:www\.|m\.)?youtube\.com\/v\/([^/?&\s]+)/i,
    /youtube\.com\/watch\?.*v=([^&\s]+)/i,
  ];
  for (const pattern of patterns) {
    const match = u.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

function detectPlatform(url) {
  const u = normalizeUrl(url);
  const lower = u.toLowerCase();
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube';
  if (lower.includes('tiktok.com') || lower.includes('vm.tiktok.com') || lower.includes('vt.tiktok.com')) return 'tiktok';
  if (lower.includes('instagram.com') || lower.includes('instagr.am')) return 'instagram';
  if (lower.includes('facebook.com') || lower.includes('fb.watch') || lower.includes('fb.com') || lower.includes('fb.me')) return 'facebook';
  return null;
}

// 统一返回结构
function videoInfoPayload(data) {
  return {
    success: true,
    platform: data.platform,
    title: data.title || '',
    author: data.author || '',
    author_mid: data.author_mid || '',
    views: parseInt(data.views || 0),
    likes: parseInt(data.likes || 0),
    comments_count: parseInt(data.comments_count || 0),
    published_at: data.published_at || '未知',
    thumbnail: data.thumbnail || '',
    recent_comments: data.recent_comments || [],
    url: data.url || '',
  };
}

// ─── 通用辅助：解析 "1.2K / 3.4M / 1,234" 等数字格式 ───
function parseEngagementNum(str) {
  if (!str) return 0;
  const s = String(str).replace(/,/g, '').trim();
  const m = s.match(/^([\d.]+)\s*([KkMmBb]?)/);
  if (!m) return parseInt(s) || 0;
  const n = parseFloat(m[1]);
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] || 1;
  return Math.round(n * mult);
}

// ─── 通用辅助：从 HTML 提取 Open Graph 元标签 ───
function extractMetaTags(html) {
  const get = (prop) => {
    // 支持 property= 和 name= 两种写法，内容在 content= 里
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*?)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*?)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    return m ? m[1].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c)).replace(/&amp;/g, '&').replace(/&quot;/g, '"') : '';
  };
  return {
    title:       get('og:title')       || get('twitter:title'),
    description: get('og:description') || get('twitter:description'),
    image:       get('og:image')       || get('twitter:image'),
  };
}

// ─── Instagram og:description 解析："2,345 Likes, 123 Comments - ..." ───
function parseInstagramDescription(desc) {
  let views = 0, likes = 0, comments = 0;
  // 匹配格式："数字 Likes"、"数字 views"、"数字 Comments"（含 K/M 缩写）
  const patterns = [
    { re: /([\d,.]+[KkMmBb]?)\s+views?/i,    key: 'views' },
    { re: /([\d,.]+[KkMmBb]?)\s+likes?/i,    key: 'likes' },
    { re: /([\d,.]+[KkMmBb]?)\s+comments?/i, key: 'comments' },
  ];
  for (const { re, key } of patterns) {
    const m = desc.match(re);
    if (m) {
      if (key === 'views')    views    = parseEngagementNum(m[1]);
      if (key === 'likes')    likes    = parseEngagementNum(m[1]);
      if (key === 'comments') comments = parseEngagementNum(m[1]);
    }
  }
  return { views, likes, comments };
}

// TikTok 请求头：模拟浏览器，减少被拒
const TIKTOK_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.tiktok.com/',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

// 从 HTML 中提取可能的 playCount/diggCount/commentCount（备用）
function extractTikTokStatsFromHtml(html) {
  const result = { playCount: 0, diggCount: 0, commentCount: 0 };
  const playMatch = html.match(/"playCount"\s*:\s*(\d+)/);
  const diggMatch = html.match(/"diggCount"\s*:\s*(\d+)/);
  const commentMatch = html.match(/"commentCount"\s*:\s*(\d+)/);
  if (playMatch) result.playCount = parseInt(playMatch[1], 10);
  if (diggMatch) result.diggCount = parseInt(diggMatch[1], 10);
  if (commentMatch) result.commentCount = parseInt(commentMatch[1], 10);
  return result;
}

// 递归从对象中取第一个含 stats 或 playCount 的节点
function findTikTokItemInJson(obj, depth = 0) {
  if (depth > 15 || !obj || typeof obj !== 'object') return null;
  if (obj.stats && (typeof obj.stats.playCount === 'number' || typeof obj.stats.diggCount === 'number'))
    return obj;
  if (obj.statistics && (obj.statistics.playCount !== undefined || obj.statistics.diggCount !== undefined))
    return obj;
  if (Array.isArray(obj)) {
    for (const x of obj) { const r = findTikTokItemInJson(x, depth + 1); if (r) return r; }
    return null;
  }
  for (const k of Object.keys(obj)) {
    const r = findTikTokItemInJson(obj[k], depth + 1);
    if (r) return r;
  }
  return null;
}

// 从 TikTok URL 提取视频 ID
function extractTikTokVideoId(url) {
  const m = url.match(/\/video\/(\d+)/);
  if (m) return m[1];
  // 短链格式 vm.tiktok.com/XXXXX 需先跟随重定向，这里先返回 null
  return null;
}

// TikTok：依次尝试 ① 内部 Web API → ② 页面 JSON 解析 → ③ og:meta 兜底 → ④ oEmbed
async function fetchTikTokInfo(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const videoId = extractTikTokVideoId(url);

  // ─── 方法 0：TikTok 自家网页播放器调用的内部 API ───
  // 与官网同域，通常不需要授权即可返回完整统计数据
  if (videoId) {
    try {
      const apiResp = await axios.get('https://www.tiktok.com/api/item/detail/', {
        params: {
          itemId:           videoId,
          aid:              1988,
          app_name:         'tiktok_web',
          device_platform:  'web_pc',
          cookie_enabled:   1,
          screen_width:     1920,
          screen_height:    1080,
          browser_language: 'en-US',
          browser_platform: 'MacIntel',
          browser_name:     'Mozilla',
          browser_version:  '5.0 (Macintosh)',
          browser_online:   true,
        },
        headers: {
          'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Referer':         'https://www.tiktok.com/',
          'Accept':          'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'sec-ch-ua':       '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-fetch-dest':  'empty',
          'sec-fetch-mode':  'cors',
          'sec-fetch-site':  'same-origin',
        },
        timeout: 12000,
      });
      const item = apiResp.data?.itemInfo?.itemStruct;
      if (item?.stats) {
        const { stats, author, desc, video } = item;
        const views    = Number(stats.playCount    || stats.viewCount  || 0);
        const likes    = Number(stats.diggCount    || stats.likeCount  || 0);
        const comments = Number(stats.commentCount || 0);
        if (views > 0 || likes > 0) {
          return videoInfoPayload({
            platform: 'tiktok',
            title:    (desc || '').trim() || (author?.uniqueId ? `@${author.uniqueId}` : 'TikTok 视频'),
            author:   author?.uniqueId || author?.nickname || '',
            views, likes, comments_count: comments,
            thumbnail: video?.cover || video?.originCover || '',
            url, recent_comments: [],
          });
        }
      }
    } catch (e) {
      console.warn('[TikTok] 内部 API 失败:', e.message);
    }
  }

  // ─── 方法 1~3：抓取页面 HTML 解析（原有逻辑） ───
  let html = '';
  try {
    const htmlRes = await axios.get(url, {
      timeout: 18000,
      maxRedirects: 5,
      headers: TIKTOK_HEADERS,
      responseType: 'text',
      validateStatus: (s) => s === 200 || s === 302,
    });
    html = htmlRes.data || '';
  } catch (e) {
    throw new Error('TikTok 请求失败：' + (e.message || '网络或连接被拒绝'));
  }

  if (!html || html.length < 500) {
    throw new Error('TikTok 返回页面为空，可能被限制访问，请稍后重试或使用 VPN');
  }

  // 1) 解析 __UNIVERSAL_DATA_FOR_REHYDRATION__
  const rehydrationMatch = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (rehydrationMatch) {
    try {
      const json = JSON.parse(rehydrationMatch[1].trim());
      const defaultScope = json?.__DEFAULT_SCOPE__ || {};
      const videoDetail = defaultScope['webapp.video-detail'] || defaultScope;
      let item = videoDetail?.itemInfo?.itemStruct;
      if (!item && videoDetail?.itemModule) {
        const mod = videoDetail.itemModule;
        const firstKey = Object.keys(mod || {})[0];
        item = firstKey ? mod[firstKey] : mod?.video;
      }
      item = item || videoDetail;
      const stats = item?.stats || item?.statistics || {};
      const author = item?.author?.uniqueId || item?.author?.nickname || item?.authorMeta?.name || '';
      const title = (item?.desc || item?.title || '').trim() || (author ? `@${author}` : 'TikTok 视频');
      const cover = item?.video?.cover || item?.video?.dynamicCover || item?.covers?.[0] || '';
      const views = Number(stats.playCount ?? stats.viewCount ?? 0);
      const likes = Number(stats.diggCount ?? stats.likeCount ?? 0);
      const comments = Number(stats.commentCount ?? 0);
      if (views > 0 || likes > 0 || comments > 0) {
        return videoInfoPayload({
          platform: 'tiktok',
          title,
          author: author || item?.authorMeta?.nickName || '',
          views,
          likes,
          comments_count: comments,
          thumbnail: typeof cover === 'string' ? cover : (cover?.url || ''),
          url,
          recent_comments: [],
        });
      }
      // 有 item 但无数据时继续尝试下面方式
    } catch (e) {
      console.warn('TikTok __UNIVERSAL_DATA 解析失败:', e.message);
    }
  }

  // 2) 尝试 SIGI_STATE（部分页面用此结构）
  const sigiMatch = html.match(/<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (sigiMatch) {
    try {
      const json = JSON.parse(sigiMatch[1].trim());
      const item = findTikTokItemInJson(json);
      if (item) {
        const stats = item.stats || item.statistics || {};
        const author = item.author?.uniqueId || item.author?.nickname || '';
        const title = (item.desc || item.title || '').trim() || (author ? `@${author}` : 'TikTok 视频');
        const views = Number(stats.playCount ?? stats.viewCount ?? 0);
        const likes = Number(stats.diggCount ?? stats.likeCount ?? 0);
        const comments = Number(stats.commentCount ?? 0);
        return videoInfoPayload({
          platform: 'tiktok',
          title,
          author,
          views,
          likes,
          comments_count: comments,
          thumbnail: '',
          url,
          recent_comments: [],
        });
      }
    } catch (e) {
      console.warn('TikTok SIGI_STATE 解析失败:', e.message);
    }
  }

  // 3) 兜底：从 HTML 中正则提取播放/点赞/评论数
  const fallback = extractTikTokStatsFromHtml(html);
  if (fallback.playCount > 0 || fallback.diggCount > 0 || fallback.commentCount > 0) {
    return videoInfoPayload({
      platform: 'tiktok',
      title: 'TikTok 视频',
      author: '',
      views: fallback.playCount,
      likes: fallback.diggCount,
      comments_count: fallback.commentCount,
      thumbnail: '',
      url,
      recent_comments: [],
    });
  }

  // 4) og:meta 兜底：从 HTML <meta> 标签里提取播放量（TikTok og:description 里有）
  if (html) {
    const meta = extractMetaTags(html);
    if (meta.description) {
      // TikTok og:description 格式："X❤ Y💬 - Watch @user's video"，或包含数字
      const playMatch = meta.description.match(/([\d,.]+[KkMmBb]?)\s*(?:plays?|views?|播放)/i);
      const likeMatch = meta.description.match(/([\d,.]+[KkMmBb]?)\s*(?:likes?|❤|diggs?)/i);
      const cmtMatch  = meta.description.match(/([\d,.]+[KkMmBb]?)\s*(?:comments?|💬)/i);
      const views    = playMatch ? parseEngagementNum(playMatch[1]) : 0;
      const likes    = likeMatch ? parseEngagementNum(likeMatch[1]) : 0;
      const comments = cmtMatch  ? parseEngagementNum(cmtMatch[1])  : 0;
      if (views > 0 || likes > 0) {
        return videoInfoPayload({
          platform: 'tiktok',
          title:    meta.title || 'TikTok 视频',
          author:   '',
          views, likes, comments_count: comments,
          thumbnail: meta.image || '',
          url, recent_comments: [],
        });
      }
    }
  }

  // 5) oEmbed 仅标题/作者，无数据
  try {
    const oembed = await axios.get('https://www.tiktok.com/oembed', {
      params: { url },
      timeout: 8000,
      headers: TIKTOK_HEADERS,
    });
    const d = oembed.data || {};
    return videoInfoPayload({
      platform: 'tiktok',
      title: d.title || 'TikTok 视频',
      author: d.author_name || '',
      views: 0,
      likes: 0,
      comments_count: 0,
      thumbnail: '',
      url,
      recent_comments: [],
    });
  } catch (oembedErr) {
    const msg = oembedErr.response?.status === 404 ? '视频不存在或链接无效' : '无法获取 TikTok 数据（页面结构可能已变更或被限制）';
    throw new Error(msg);
  }
}

// Instagram: ① HTML og:meta 解析 → ② 无 token oEmbed → ③ Meta Graph API（有 token 时）
async function fetchInstagramInfo(rawUrl, metaToken) {
  const url = normalizeUrl(rawUrl);

  // ─── 方法 1：抓取公开页面 HTML，从 og:description 解析点赞/评论/播放数 ───
  // Instagram 公开帖子的 og:description 格式：
  //   "2,345 Likes, 123 Comments - @user on Instagram: ..."
  //   "3.2M views, 45.6K likes, 1,234 comments..."（Reels）
  try {
    const htmlRes = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        // iPhone UA：返回较完整的 OG 标签
        'User-Agent':              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept':                  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':         'en-US,en;q=0.9',
        'Referer':                 'https://www.instagram.com/',
        'Upgrade-Insecure-Requests': '1',
      },
      responseType: 'text',
    });
    const html = htmlRes.data || '';
    if (html.length > 500) {
      const meta = extractMetaTags(html);
      const title = meta.title || '';
      if (meta.description) {
        const stats = parseInstagramDescription(meta.description);
        if (stats.likes > 0 || stats.views > 0 || stats.comments > 0) {
          console.log('[Instagram] og:meta 解析成功:', stats);
          return videoInfoPayload({
            platform: 'instagram',
            title,
            author:        '',
            views:         stats.views,
            likes:         stats.likes,
            comments_count: stats.comments,
            thumbnail:     meta.image || '',
            url,
            recent_comments: [],
          });
        }
      }
    }
  } catch (e) {
    console.warn('[Instagram] HTML 解析失败:', e.message);
  }

  // ─── 方法 2：无 token 的 Instagram oEmbed（仅返回 title/thumbnail/author，无播放数） ───
  try {
    const oembedRes = await axios.get('https://www.instagram.com/oembed/', {
      params: { url, maxwidth: 320 },
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      },
    });
    // Guard: Instagram now returns HTML for unauthenticated requests
    const d = (oembedRes.headers?.['content-type'] || '').includes('json')
      ? (oembedRes.data || {})
      : (typeof oembedRes.data === 'object' ? oembedRes.data : {});
    if (d.title || d.author_name) {
      console.log('[Instagram] 无 token oEmbed 成功，仅 title/author');
      return videoInfoPayload({
        platform:      'instagram',
        title:         d.title || 'Instagram 帖子',
        author:        d.author_name || '',
        thumbnail:     d.thumbnail_url || '',
        views:         0,
        likes:         0,
        comments_count: 0,
        url,
        recent_comments: [],
      });
    }
  } catch (e) {
    console.warn('[Instagram] 无 token oEmbed 失败:', e.message);
  }

  // ─── 方法 3：Meta Graph API（需 access_token） ───
  if (metaToken) {
    try {
      const oembedRes = await axios.get('https://graph.facebook.com/v18.0/instagram_oembed', {
        params: { url, access_token: metaToken, fields: 'title,thumbnail_url,author_name' },
        timeout: 10000,
      });
      const d = oembedRes.data || {};
      return videoInfoPayload({
        platform:       'instagram',
        title:          d.title || 'Instagram 帖子',
        author:         d.author_name || '',
        thumbnail:      d.thumbnail_url || '',
        views:          0,
        likes:          0,
        comments_count: 0,
        url,
        recent_comments: [],
      });
    } catch (e) {
      if (e.response?.status === 404) throw new Error('帖子不存在或链接无效');
      const msg = e.response?.data?.error?.message || e.message;
      throw new Error('Instagram 获取失败：' + msg + '（请确认 Meta Token 有效且具备 instagram_basic 权限）');
    }
  }

  throw new Error('无法获取 Instagram 公开数据（该帖子可能已私密，或 Instagram 限制了访问）');
}

// Facebook：必须使用 Meta Access Token，并从多种 URL 格式中解析视频 ID
function extractFacebookVideoId(url) {
  const u = url.toLowerCase();
  const patterns = [
    /(?:videos?|watch\/?\?v=)\/(\d+)/i,
    /\/videos?\/(\d+)/i,
    /facebook\.com\/[^/]+\/videos\/(\d+)/i,
    /fb\.watch\/([a-zA-Z0-9_-]+)/i,
    /fb\.com\/watch\/\?v=(\d+)/i,
  ];
  for (const p of patterns) {
    const m = u.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

async function fetchFacebookInfo(rawUrl, metaToken) {
  const url = normalizeUrl(rawUrl);

  // ─── 方法 1：移动端页面 HTML 解析 ───
  // m.facebook.com 对爬虫稍宽松，og:description / JSON-LD 中有时包含播放量
  try {
    const mobileUrl = url.replace(/^https?:\/\/(www\.)?facebook\.com/, 'https://m.facebook.com');
    const htmlRes = await axios.get(mobileUrl, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent':      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      responseType: 'text',
    });
    const html = htmlRes.data || '';
    if (html.length > 500) {
      const meta = extractMetaTags(html);
      const title = meta.title || '';
      const desc  = meta.description || '';

      // 从 og:description 或 HTML 内联数据中尝试提取播放量
      let views = 0;
      const viewMatch =
        desc.match(/([\d,.]+[KkMmBb]?)\s*(?:views?|plays?|次观看|次播放)/i) ||
        html.match(/"playCount"\s*:\s*(\d+)/) ||
        html.match(/"video_view_count"\s*:\s*(\d+)/) ||
        html.match(/(\d[\d,]+)\s+(?:views?|plays?)/i);
      if (viewMatch) views = parseEngagementNum(viewMatch[1]);

      // Facebook 不登录时 title 往往是登录/首页，过滤掉这类无效响应
      const lowerTitle = title.toLowerCase();
      const isLoginPage = lowerTitle.includes('log in') || lowerTitle.includes('sign up') ||
                          lowerTitle.includes('登录') || lowerTitle.includes('discover popular') ||
                          lowerTitle.includes('facebook – ') || lowerTitle.includes('facebook - ') ||
                          lowerTitle === 'facebook';
      if (title && !isLoginPage) {
        console.log('[Facebook] 移动端 HTML 解析成功, views:', views);
        return videoInfoPayload({
          platform:       'facebook',
          title,
          author:         '',
          views,
          likes:          0,
          comments_count: 0,
          thumbnail:      meta.image || '',
          url,
          recent_comments: [],
        });
      }
    }
  } catch (e) {
    console.warn('[Facebook] 移动端 HTML 解析失败:', e.message);
  }

  // ─── 方法 2：Meta Graph API（需 access_token） ───
  if (!metaToken) {
    throw new Error('无法通过公开页面获取 Facebook 视频数据（Facebook 需登录才可查看），建议在「API 配置」中填写 Meta Access Token');
  }

  const videoId = extractFacebookVideoId(url);
  if (!videoId) {
    throw new Error('无法从链接中解析 Facebook 视频 ID，请使用标准视频页链接（如 facebook.com/.../videos/12345）');
  }

  try {
    const res = await axios.get(`https://graph.facebook.com/v18.0/${videoId}`, {
      params: { access_token: metaToken, fields: 'title,description,length,created_time' },
      timeout: 10000,
    });
    const d = res.data || {};
    let views = 0;
    try {
      const insightsRes = await axios.get(`https://graph.facebook.com/v18.0/${videoId}/video_insights`, {
        params: { access_token: metaToken, metric: 'total_video_views' },
        timeout: 8000,
      });
      views = insightsRes?.data?.data?.[0]?.values?.[0]?.value || 0;
    } catch (_) {}
    return videoInfoPayload({
      platform:       'facebook',
      title:          d.title || 'Facebook 视频',
      author:         '',
      views:          Number(views),
      likes:          0,
      comments_count: 0,
      thumbnail:      '',
      published_at:   d.created_time ? new Date(d.created_time).toLocaleDateString('zh-CN') : '未知',
      url,
      recent_comments: [],
    });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    throw new Error('Facebook 获取失败：' + msg + '（请确认 Token 具备 pages_read_engagement 或 read_insights 权限）');
  }
}

// 获取视频信息（多平台）
app.get('/api/video-info', async (req, res) => {
  const { url: queryUrl, youtube_key, meta_token } = req.query;

  if (!queryUrl) {
    return res.status(400).json({ success: false, error: 'URL 不能为空' });
  }

  let decodedUrl;
  try {
    decodedUrl = decodeURIComponent(queryUrl);
  } catch (_) {
    decodedUrl = queryUrl;
  }

  const url = normalizeUrl(decodedUrl);
  const platform = detectPlatform(url);

  if (!platform) {
    return res.status(400).json({
      success: false,
      error: '不支持的链接，请使用 YouTube / TikTok / Instagram / Facebook 视频链接',
    });
  }

  if (platform === 'youtube') {
    if (!youtube_key) {
      return res.status(400).json({ success: false, error: '请先在「API 配置」中填入 YouTube API Key' });
    }
    const videoId = extractYoutubeId(url);
    if (!videoId) {
      return res.status(400).json({ success: false, error: '无法解析 YouTube 视频 ID，请检查链接格式' });
    }
    try {
      const videoRes = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        params: { part: 'snippet,statistics', id: videoId, key: youtube_key },
        timeout: 12000,
      });
      if (!videoRes.data.items?.length) {
        return res.status(404).json({ success: false, error: '视频不存在或已被删除' });
      }
      const item = videoRes.data.items[0];
      const { snippet, statistics } = item;
      let comments = [];
      try {
        const commentRes = await axios.get('https://www.googleapis.com/youtube/v3/commentThreads', {
          params: {
            part: 'snippet',
            videoId,
            key: youtube_key,
            maxResults: 50,
            order: 'relevance',
            textFormat: 'plainText',
          },
          timeout: 10000,
        });
        if (commentRes.data.items) {
          comments = commentRes.data.items
            .map(c => c.snippet.topLevelComment.snippet.textDisplay || '')
            .filter(c => c.length > 0);
        }
      } catch (e) {
        console.warn('获取 YouTube 评论失败:', e.message);
      }
      return res.json(videoInfoPayload({
        platform: 'youtube',
        title: snippet.title,
        author: snippet.channelTitle,
        author_mid: snippet.channelId,
        views: parseInt(statistics.viewCount || 0),
        likes: parseInt(statistics.likeCount || 0),
        comments_count: parseInt(statistics.commentCount || 0),
        published_at: snippet.publishedAt ? new Date(snippet.publishedAt).toLocaleDateString('zh-CN') : '未知',
        thumbnail: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
        recent_comments: comments,
        url,
      }));
    } catch (error) {
      if (error.response) {
        const msg = error.response.data?.error?.message || error.message;
        return res.status(error.response.status).json({ success: false, error: `YouTube API 错误: ${msg}` });
      }
      if (error.code === 'ECONNABORTED') {
        return res.status(408).json({ success: false, error: '请求超时，请稍后重试' });
      }
      return res.status(500).json({ success: false, error: String(error.message) });
    }
  }

  if (platform === 'tiktok') {
    try {
      const payload = await fetchTikTokInfo(url);
      return res.json(payload);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error.message || '获取 TikTok 数据失败',
      });
    }
  }

  if (platform === 'instagram') {
    try {
      const payload = await fetchInstagramInfo(url, meta_token || null);
      return res.json(payload);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error.message || '获取 Instagram 数据失败',
      });
    }
  }

  if (platform === 'facebook') {
    try {
      const payload = await fetchFacebookInfo(url, meta_token || null);
      return res.json(payload);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error.message || '获取 Facebook 数据失败',
      });
    }
  }

  return res.status(400).json({ success: false, error: '不支持的平台' });
});

// ============================================================
// 批量 YouTube 视频信息
// 一次最多查 50 个 ID（YouTube API 上限），节省 ~50x 配额
// POST /api/batch-youtube  body: { urls: string[], youtube_key: string }
// 返回: { success: true, results: { [url]: videoInfoPayload | { success:false, _error } } }
// ============================================================
app.post('/api/batch-youtube', async (req, res) => {
  const { urls, youtube_key } = req.body || {};
  if (!youtube_key)
    return res.status(400).json({ success: false, error: '未提供 YouTube API Key' });
  if (!Array.isArray(urls) || urls.length === 0)
    return res.status(400).json({ success: false, error: '未提供 URL 列表' });

  // 建立 normalizedUrl → videoId 映射（过滤无效链接）
  const pairs = urls.map(url => {
    const norm = normalizeUrl(url);
    return { origUrl: url, url: norm, id: extractYoutubeId(norm) };
  });

  const results = {};

  // 无法解析 ID 的直接标记错误
  for (const p of pairs) {
    if (!p.id) results[p.url] = { success: false, _error: '无法解析 YouTube 视频 ID，请检查链接格式' };
  }

  const validPairs = pairs.filter(p => p.id);

  // 每批最多 50 个 ID（YouTube Data API 限制）
  for (let i = 0; i < validPairs.length; i += 50) {
    const batch = validPairs.slice(i, i + 50);
    const ids   = batch.map(p => p.id).join(',');

    try {
      const resp = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        params:  { part: 'snippet,statistics', id: ids, key: youtube_key },
        timeout: 15000,
      });

      for (const item of (resp.data.items || [])) {
        const pair = batch.find(p => p.id === item.id);
        if (!pair) continue;
        results[pair.url] = videoInfoPayload({
          platform:        'youtube',
          title:           item.snippet.title,
          author:          item.snippet.channelTitle,
          author_mid:      item.snippet.channelId,
          views:           parseInt(item.statistics.viewCount    || 0),
          likes:           parseInt(item.statistics.likeCount    || 0),
          comments_count:  parseInt(item.statistics.commentCount || 0),
          published_at:    item.snippet.publishedAt
                             ? new Date(item.snippet.publishedAt).toLocaleDateString('zh-CN')
                             : '未知',
          thumbnail:       item.snippet.thumbnails?.medium?.url
                           || item.snippet.thumbnails?.default?.url || '',
          recent_comments: [],
          url:             pair.url,
        });
      }

      // 本批次中未返回的视频（已删除 / 私密 / 链接错误）
      for (const pair of batch) {
        if (!results[pair.url])
          results[pair.url] = { success: false, _error: '视频不存在、已删除或设为私密' };
      }
    } catch (err) {
      const apiErr = err.response?.data?.error;
      // 区分"配额耗尽"和其他错误
      const isQuota = apiErr?.errors?.some(e => e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded');
      const msg = isQuota
        ? 'YouTube API 每日配额已用尽，请明天再试，或在 Google Cloud Console 申请更多配额'
        : `YouTube API 错误：${apiErr?.message || err.message}`;
      for (const pair of batch)
        results[pair.url] = { success: false, _error: msg };
    }

    // 批次间稍作等待，避免触发速率限制
    if (i + 50 < validPairs.length) await new Promise(r => setTimeout(r, 300));
  }

  return res.json({ success: true, results });
});

app.listen(PORT, () => {
  console.log(`\n🚀 红人视频统计看板已启动`);
  console.log(`📊 访问地址: http://localhost:${PORT}\n`);
});
