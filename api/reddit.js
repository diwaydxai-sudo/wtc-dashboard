// Vercel Serverless Function - Reddit Proxy
// Fetches Reddit JSON server-side to bypass CORS restrictions

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { subreddit, limit = '10', sort = 'hot' } = req.query;

  if (!subreddit) {
    return res.status(400).json({ error: 'Missing subreddit parameter' });
  }

  // Sanitize inputs
  const cleanSubreddit = subreddit.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 50);
  const cleanLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 25);
  const cleanSort = ['hot', 'new', 'top', 'rising'].includes(sort) ? sort : 'hot';

  // Try multiple approaches
  const attempts = [
    {
      url: `https://old.reddit.com/r/${cleanSubreddit}/${cleanSort}.json?limit=${cleanLimit}&raw_json=1`,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    {
      url: `https://www.reddit.com/r/${cleanSubreddit}/${cleanSort}.json?limit=${cleanLimit}&raw_json=1`,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
    },
    {
      // RSS fallback - more reliable but less data
      url: `https://www.reddit.com/r/${cleanSubreddit}/${cleanSort}.json?limit=${cleanLimit}`,
      userAgent: 'curl/8.0'
    }
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(attempt.url, {
        signal: controller.signal,
        headers: {
          'User-Agent': attempt.userAgent,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
      });

      clearTimeout(timeout);

      if (response.status === 403 || response.status === 429) {
        lastError = `Status ${response.status}`;
        continue; // Try next approach
      }

      if (!response.ok) {
        if (response.status === 404) {
          return res.status(404).json({ 
            error: 'Subreddit not found',
            subreddit: cleanSubreddit 
          });
        }
        lastError = `Status ${response.status}`;
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        lastError = 'Non-JSON response';
        continue;
      }

      const data = await response.json();

      if (!data?.data?.children) {
        lastError = 'Invalid JSON structure';
        continue;
      }

      // Success! Extract posts
      const posts = data.data.children
        .filter(child => child.kind === 't3') // Only posts, not ads
        .map(child => {
          const post = child.data;
          return {
            id: post.id,
            title: post.title,
            author: post.author,
            subreddit: post.subreddit,
            upvotes: post.ups,
            score: post.score,
            ratio: post.upvote_ratio,
            comments: post.num_comments,
            created: post.created_utc,
            permalink: post.permalink,
            url: post.url,
            selftext: post.selftext?.slice(0, 300),
            thumbnail: post.thumbnail?.startsWith('http') ? post.thumbnail : null,
            flair: post.link_flair_text,
            isNsfw: post.over_18,
            isPinned: post.stickied,
          };
        });

      // Cache for 5 minutes
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

      return res.status(200).json({
        success: true,
        subreddit: cleanSubreddit,
        sort: cleanSort,
        count: posts.length,
        posts,
        fetchedAt: new Date().toISOString(),
      });

    } catch (error) {
      lastError = error.name === 'AbortError' ? 'Timeout' : error.message;
      continue;
    }
  }

  // All attempts failed
  console.error(`All Reddit fetch attempts failed for r/${cleanSubreddit}: ${lastError}`);
  
  return res.status(503).json({
    success: false,
    error: 'Reddit API unavailable',
    message: lastError,
    subreddit: cleanSubreddit,
    suggestion: 'Reddit may be rate-limiting. Try again in a few minutes.',
  });
}
