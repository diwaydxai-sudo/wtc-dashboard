// Vercel Serverless Function - Reddit Proxy
// Fetches Reddit JSON server-side to bypass CORS restrictions

export default async function handler(req, res) {
  // Enable CORS for the dashboard
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

  // Sanitize subreddit name
  const cleanSubreddit = subreddit.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 50);
  const cleanLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 25);
  const cleanSort = ['hot', 'new', 'top', 'rising'].includes(sort) ? sort : 'hot';

  const redditUrl = `https://www.reddit.com/r/${cleanSubreddit}/${cleanSort}.json?limit=${cleanLimit}&raw_json=1`;

  try {
    const response = await fetch(redditUrl, {
      headers: {
        // Use a reasonable user agent - Reddit blocks generic ones
        'User-Agent': 'WTC-Dashboard/1.0 (Growth tracking tool)',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      // Handle Reddit-specific errors
      if (response.status === 403) {
        return res.status(403).json({ 
          error: 'Subreddit is private or quarantined',
          subreddit: cleanSubreddit 
        });
      }
      if (response.status === 404) {
        return res.status(404).json({ 
          error: 'Subreddit not found',
          subreddit: cleanSubreddit 
        });
      }
      throw new Error(`Reddit returned ${response.status}`);
    }

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      // Reddit returned HTML (security page) instead of JSON
      return res.status(503).json({ 
        error: 'Reddit returned non-JSON response (possible rate limit)',
        subreddit: cleanSubreddit 
      });
    }

    const data = await response.json();

    // Extract and clean the posts
    const posts = (data?.data?.children || []).map(child => {
      const post = child.data;
      return {
        id: post.id,
        title: post.title,
        author: post.author,
        subreddit: post.subreddit,
        upvotes: post.ups,
        downvotes: post.downs,
        score: post.score,
        ratio: post.upvote_ratio,
        comments: post.num_comments,
        created: post.created_utc,
        permalink: post.permalink,
        url: post.url,
        selftext: post.selftext?.slice(0, 500), // Truncate for size
        thumbnail: post.thumbnail,
        flair: post.link_flair_text,
        isNsfw: post.over_18,
        isPinned: post.stickied,
      };
    });

    // Cache for 5 minutes
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

    return res.status(200).json({
      subreddit: cleanSubreddit,
      sort: cleanSort,
      count: posts.length,
      posts,
      fetchedAt: new Date().toISOString(),
    });

  } catch (error) {
    console.error(`Reddit fetch error for r/${cleanSubreddit}:`, error);
    
    return res.status(500).json({
      error: 'Failed to fetch from Reddit',
      message: error.message,
      subreddit: cleanSubreddit,
    });
  }
}
