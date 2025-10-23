import { Hono } from 'hono'

const app = new Hono()

// Helper: normalize origin from a URL string
function getOrigin(urlStr: string) {
  try {
    const u = new URL(urlStr)
    return u.origin
  } catch {
    return null
  }
}

// Parse robots.txt for User-agent: *
async function fetchRobots(
  origin: string
): Promise<{ allowed: (path: string) => boolean; crawlDelay?: number }> {
  const robotsUrl = `${origin}/robots.txt`
  try {
    const res = await fetch(robotsUrl, { redirect: 'follow' })
    if (!res.ok) {
      // No robots or unreachable -> treat as allowed
      return { allowed: () => true }
    }
    const txt = await res.text()
    // Very small robots.txt parser for user-agent *
    const lines = txt.split(/\r?\n/).map((l) => l.trim())
    let inStar = false
    const disallows: string[] = []
    let crawlDelay: number | undefined = undefined

    for (const line of lines) {
      if (!line || line.startsWith('#')) continue
      const [k, vRaw] = line.split(':', 2).map((s) => s.trim())
      const v = vRaw ?? ''
      if (/^User-agent$/i.test(k)) {
        inStar = v === '*' ? true : false
        continue
      }
      if (!inStar) continue
      if (/^Disallow$/i.test(k)) {
        // empty Disallow means allow all
        if (v) disallows.push(v)
      } else if (/^Crawl-delay$/i.test(k)) {
        const n = Number(v)
        if (!Number.isNaN(n)) crawlDelay = n
      }
    }

    return {
      allowed: (path: string) => {
        // simple matching: if any disallow is a prefix of path, it's disallowed
        for (const d of disallows) {
          if (d === '') continue // empty means allow all
          if (path.startsWith(d)) return false
        }
        return true
      },
      crawlDelay,
    }
  } catch {
    return { allowed: () => true }
  }
}

// Strip HTML tags and collapse spaces
function stripTags(s: string) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Basic extraction using regex (keeps dependencies out)
function extractData(html: string, baseOrigin: string) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? stripTags(titleMatch[1]) : null

  const headings: string[] = []
  const hRegex = /<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi
  let hMatch: RegExpExecArray | null
  while ((hMatch = hRegex.exec(html)) && headings.length < 5) {
    headings.push(stripTags(hMatch[2]))
  }

  const links: { href: string; text: string }[] = []
  const aRegex = /<a\s+[^>]*href=(["']?)([^"'\s>]+)\1[^>]*>([\s\S]*?)<\/a>/gi
  let aMatch: RegExpExecArray | null
  while ((aMatch = aRegex.exec(html)) && links.length < 50) {
    try {
      const rawHref = aMatch[2]
      const text = stripTags(aMatch[3])
      // normalize relative URLs
      const href = new URL(rawHref, baseOrigin).toString()
      links.push({ href, text })
    } catch {
      // skip malformed href
    }
  }

  // Deduplicate and take first 10
  const unique: { href: string; text: string }[] = []
  const seen = new Set<string>()
  for (const l of links) {
    if (!seen.has(l.href)) {
      seen.add(l.href)
      unique.push(l)
      if (unique.length >= 10) break
    }
  }

  return { title, headings, links: unique }
}

// Basic rate-limit guard via a simple token in query (for demo) — you should implement a proper rate limiter in production.
app.get('/', (c) => c.text('Hello Hono! Use /scrape?url=...'))

/**
 * /scrape?url=<target>
 * Example: /scrape?url=https://www.sharesansar.com/
 */
app.get('/scrape', async (c) => {
  const url = c.req.query('url') || 'https://www.sharesansar.com/'
  let targetUrl: URL
  try {
    targetUrl = new URL(url)
  } catch {
    return c.json({ success: false, error: 'Invalid URL' }, 400)
  }

  const origin = targetUrl.origin
  const path = targetUrl.pathname + (targetUrl.search || '')

  // fetch and parse robots.txt
  const robots = await fetchRobots(origin)
  if (!robots.allowed(path)) {
    return c.json({ success: false, error: 'Blocked by robots.txt' }, 403)
  }

  // OPTIONAL: honor crawl-delay if provided (we only return it to caller so they can decide)
  // NOTE: Cloudflare Worker can't "sleep" reliably between requests for multiple calls; implement delays at client or scheduler level.

  // fetch the page
  try {
    const res = await fetch(targetUrl.toString(), {
      headers: {
        // set a reasonable user-agent
        'User-Agent': 'Hono-Scraper/1.0 (+https://yourdomain.example)',
      },
    })
    if (!res.ok) {
      return c.json(
        { success: false, status: res.status, statusText: res.statusText },
        502
      )
    }
    const html = await res.text()

    const data = extractData(html, origin)
    return c.json({
      success: true,
      url: targetUrl.toString(),
      robots: { crawlDelay: robots.crawlDelay ?? null },
      data,
    })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message ?? String(err) }, 500)
  }
})

export default app
