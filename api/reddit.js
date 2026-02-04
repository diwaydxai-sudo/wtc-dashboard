// Vercel Serverless Function - Reddit Proxy
// Multiple fallback strategies for Reddit data

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { subreddit, limit = '10', sort = 'hot' } = req.query;
  if (!subreddit) return res.status(400).json({ error: 'Missing subreddit parameter' });

  const cleanSubreddit = subreddit.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 50);
  const cleanLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 25);

  // Strategy 1: Try JSON API via different domains
  const jsonResult = await tryJsonApi(cleanSubreddit, cleanLimit);
  if (jsonResult.success) {
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(jsonResult);
  }

  // Strategy 2: RSS Feed fallback
  const rssResult = await tryRssFeed(cleanSubreddit, cleanLimit);
  if (rssResult.success) {
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(rssResult);
  }

  // All strategies failed
  return res.status(503).json({
    success: false,
    error: 'Reddit unavailable',
    subreddit: cleanSubreddit,
    jsonError: jsonResult.error,
    rssError: rssResult.error,
    fallback: true,
    posts: getSamplePosts(cleanSubreddit),
    message: 'Using sample data. Reddit is blocking cloud IPs.'
  });
}

async function tryJsonApi(subreddit, limit) {
  const urls = [
    `https://old.reddit.com/r/${subreddit}/hot.json?limit=${limit}&raw_json=1`,
    `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}&raw_json=1`,
  ];

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });
      clearTimeout(timeout);

      if (!response.ok) continue;

      const ct = response.headers.get('content-type') || '';
      if (!ct.includes('json')) continue;

      const data = await response.json();
      if (!data?.data?.children) continue;

      const posts = data.data.children
        .filter(c => c.kind === 't3' && !c.data.stickied)
        .slice(0, limit)
        .map(c => formatPost(c.data));

      return { success: true, source: 'json', subreddit, posts, count: posts.length, fetchedAt: new Date().toISOString() };
    } catch (e) {
      continue;
    }
  }
  return { success: false, error: 'JSON API blocked' };
}

async function tryRssFeed(subreddit, limit) {
  const rssUrl = `https://www.reddit.com/r/${subreddit}/hot.rss`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(rssUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RSS Reader)',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
    });
    clearTimeout(timeout);

    if (!response.ok) return { success: false, error: `RSS ${response.status}` };

    const xml = await response.text();
    if (xml.includes('<html') || !xml.includes('<entry>')) {
      return { success: false, error: 'RSS returned HTML' };
    }

    // Parse RSS XML manually (Atom format)
    const posts = parseAtomFeed(xml, subreddit).slice(0, limit);
    
    if (posts.length === 0) return { success: false, error: 'No posts in RSS' };

    return { success: true, source: 'rss', subreddit, posts, count: posts.length, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function parseAtomFeed(xml, subreddit) {
  const posts = [];
  const entries = xml.split('<entry>').slice(1);

  for (const entry of entries) {
    const title = extractTag(entry, 'title') || 'Untitled';
    const link = extractAttr(entry, 'link', 'href') || '';
    const id = link.split('/comments/')[1]?.split('/')[0] || Math.random().toString(36).slice(2);
    const author = extractTag(entry, 'name') || 'unknown';
    const published = extractTag(entry, 'published') || '';
    const content = extractTag(entry, 'content') || '';

    // Extract score from content if available
    const scoreMatch = content.match(/(\d+)\s*points?/i);
    const commentsMatch = content.match(/(\d+)\s*comments?/i);

    posts.push({
      id,
      title: decodeHtml(title),
      author: author.replace('/u/', ''),
      subreddit,
      upvotes: scoreMatch ? parseInt(scoreMatch[1]) : 0,
      score: scoreMatch ? parseInt(scoreMatch[1]) : 0,
      comments: commentsMatch ? parseInt(commentsMatch[1]) : 0,
      created: published ? new Date(published).getTime() / 1000 : Date.now() / 1000,
      permalink: link.replace('https://www.reddit.com', ''),
      url: link,
      selftext: null,
      thumbnail: null,
      flair: null,
      isNsfw: false,
      isPinned: false,
    });
  }
  return posts;
}

function extractTag(str, tag) {
  const match = str.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : null;
}

function extractAttr(str, tag, attr) {
  const match = str.match(new RegExp(`<${tag}[^>]*${attr}="([^"]+)"`));
  return match ? match[1] : null;
}

function decodeHtml(html) {
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '');
}

function formatPost(post) {
  return {
    id: post.id,
    title: post.title,
    author: post.author,
    subreddit: post.subreddit,
    upvotes: post.ups || 0,
    score: post.score || 0,
    ratio: post.upvote_ratio || 0,
    comments: post.num_comments || 0,
    created: post.created_utc,
    permalink: post.permalink,
    url: post.url,
    selftext: post.selftext?.slice(0, 300) || null,
    thumbnail: post.thumbnail?.startsWith('http') ? post.thumbnail : null,
    flair: post.link_flair_text || null,
    isNsfw: post.over_18 || false,
    isPinned: post.stickied || false,
  };
}

function getSamplePosts(subreddit) {
  // Return contextual sample data when Reddit is unavailable
  const samples = {
    coffee: [
      { id: 's1', title: 'My pour-over setup after 2 years of experimentation', upvotes: 2847, comments: 234 },
      { id: 's2', title: 'Is a $300 grinder really worth it? My honest review', upvotes: 1923, comments: 456 },
      { id: 's3', title: 'Local roaster just won a national award - so proud!', upvotes: 1567, comments: 89 },
    ],
    Philippines: [
      { id: 's1', title: 'Hidden gem cafes in Makati you need to try', upvotes: 1834, comments: 312 },
      { id: 's2', title: 'Best work-from-cafe spots with stable wifi?', upvotes: 945, comments: 187 },
      { id: 's3', title: 'Support local coffee farmers - where to buy beans direct', upvotes: 723, comments: 56 },
    ],
    entrepreneur: [
      { id: 's1', title: 'I bootstrapped to $10k MRR - lessons learned', upvotes: 3421, comments: 567 },
      { id: 's2', title: 'Stop building features, start talking to customers', upvotes: 2156, comments: 234 },
      { id: 's3', title: 'The real cost of starting a food/beverage business', upvotes: 1876, comments: 345 },
    ],
  };

  const basePosts = samples[subreddit] || samples.coffee;
  return basePosts.map((p, i) => ({
    ...p,
    author: 'sample_user',
    subreddit,
    score: p.upvotes,
    ratio: 0.92,
    created: Date.now() / 1000 - (i + 1) * 3600,
    permalink: `/r/${subreddit}/comments/${p.id}/`,
    url: `https://reddit.com/r/${subreddit}`,
    selftext: null,
    thumbnail: null,
    flair: null,
    isNsfw: false,
    isPinned: false,
  }));
}
