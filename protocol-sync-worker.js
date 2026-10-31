/* =========================================================
   Daily Protocol — sync endpoint
   Cloudflare Worker + KV. Free tier is far more than enough:
   this stores one small JSON blob and reads it a few times a day.

   THIS FILE IS THE SOURCE OF TRUTH for the protocol-sync Worker.
   To update the live Worker: Cloudflare dashboard > Workers & Pages >
   protocol-sync > Edit code > select all, delete, paste this file > Deploy.
   Bindings and secrets (STATE, SECRET, READ_KEY) are kept when you do.

   SETUP (dashboard, no command line needed)
   1. cloudflare.com -> sign up (free)
   2. Compute > Workers & Pages > Create > Start with Hello World
      -> name it e.g. "protocol-sync" -> Deploy
   3. Edit code -> delete everything -> paste this file -> Deploy
   4. The Worker's Settings tab > Bindings > Add > KV namespace
        Variable name: STATE
        KV namespace:  create one called "protocol" and pick it
   5. Same Settings tab > Variables and Secrets > Add
        Type:  Secret
        Name:  SECRET
        Value: a long random string you invent. This is the password
               that guards your data. Keep a copy — the app needs it.
   6. Deploy again. Your URL is shown at the top, something like
      https://protocol-sync.<your-subdomain>.workers.dev
      Paste that URL and the secret into the app's Sync panel.

   READ-ONLY ACCESS (for Claude / the morning brief)
   7. Settings > Variables and Secrets > Add
        Type:  Secret
        Name:  READ_KEY
        Value: a DIFFERENT long random string. It can only read.
      Then GET  https://protocol-sync.<sub>.workers.dev/read?k=<READ_KEY>
      returns the same JSON the app syncs. PUT/POST are refused on
      /read, and READ_KEY is never accepted on the main route.
      If READ_KEY is not set, /read is simply switched off.

   CANVAS FEED (added 2026-10-31)
      GET /canvas with headers x-sync-key (the SECRET) and x-feed (your
      private Canvas calendar link). The Worker fetches the .ics and hands
      it back, because Canvas sends no CORS headers and the app cannot
      fetch it directly. Only https links whose path is
      /feeds/calendars/<something>.ics are fetched, so this cannot be
      used as a general proxy, and it needs the same key as your state.

   Verify it works: opening the URL in a browser should return
   {"error":"unauthorized"} — that is the correct response. It means
   the Worker is live and refusing requests without the key.
   ========================================================= */

const KEYNAME = 'state';
const MAX_BYTES = 512 * 1024;
const MAX_ICS = 5 * 1024 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-sync-key, x-read-key, x-feed',
  'Access-Control-Max-Age': '86400'
};

function reply(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json' }, CORS)
  });
}

/* length-independent compare, so response timing leaks nothing */
function keyMatches(given, want) {
  let ok = given.length === want.length;
  for (let i = 0; i < Math.max(given.length, want.length); i++) {
    if (given.charCodeAt(i) !== want.charCodeAt(i)) ok = false;
  }
  return ok;
}

/* Fetch a Canvas calendar feed for the app. */
async function canvasFeed(request) {
  const raw = (request.headers.get('x-feed') || '').trim().replace(/^webcals?:\/\//i, 'https://');
  let feed;
  try { feed = new URL(raw); } catch (e) { return reply({ error: 'missing or invalid feed link' }, 400); }
  if (feed.protocol !== 'https:' || !/^\/feeds\/calendars\/[^\/]+\.ics$/i.test(feed.pathname)) {
    return reply({ error: 'not a Canvas calendar feed link' }, 400);
  }
  let r;
  try {
    r = await fetch(feed.toString(), {
      headers: { 'accept': 'text/calendar, */*', 'user-agent': 'protocol-sync (personal Canvas feed)' },
      redirect: 'follow'
    });
  } catch (e) {
    return reply({ error: 'could not reach Canvas' }, 502);
  }
  if (!r.ok) return reply({ error: 'Canvas answered ' + r.status + (r.status === 404 ? ' (link expired or reset?)' : '') }, 502);
  const text = await r.text();
  if (text.length > MAX_ICS) return reply({ error: 'feed too large' }, 413);
  if (text.indexOf('BEGIN:VCALENDAR') === -1) return reply({ error: 'that link did not return a calendar' }, 502);
  return new Response(text, {
    headers: Object.assign({ 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' }, CORS)
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
  // ---- app hand-off: no key, no state ----
    if (new URL(request.url).pathname === '/journal') {
      const target = 'dayone://post';
      const html = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opening Day One</title>
<style>
  html,body{margin:0;height:100%;background:#16191F;color:#E6E8EA;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
  body{display:grid;place-items:center;text-align:center;padding:24px;}
  a{display:inline-block;margin-top:18px;padding:16px 26px;border-radius:10px;
    background:#7C89F0;color:#16191F;font-weight:700;font-size:17px;
    text-decoration:none;}
  p{color:#8A929C;font-size:14px;margin:0;}
</style></head><body><div>
<p>Opening Day One&hellip;</p>
<a id="go" href="${target}">Open Day One</a>
</div>
<script>
  // Try it automatically. WebKit usually allows this on load; if it's blocked,
  // the button below is a real user gesture on a real https page, which is
  // never blocked.
  setTimeout(function(){ try{ location.replace(${JSON.stringify(target)}); }catch(e){} }, 60);
</script>
</body></html>`;
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' }
      });
    }
    if (!env.STATE) {
      return reply({ error: 'server not configured: missing STATE binding' }, 500);
    }

    const url = new URL(request.url);

    // ---- read-only route: separate key, GET only ----
    if (url.pathname === '/read') {
      if (!env.READ_KEY) return reply({ error: 'read endpoint disabled' }, 404);
      if (request.method !== 'GET') return reply({ error: 'read-only' }, 405);
      const givenRead = (request.headers.get('x-read-key') || url.searchParams.get('k') || '').trim();
      if (!keyMatches(givenRead, String(env.READ_KEY).trim())) {
        return reply({ error: 'unauthorized' }, 401);
      }
      const stored = await env.STATE.get(KEYNAME);
      if (!stored) return reply(null, 200);
      return new Response(stored, {
        headers: Object.assign(
          { 'content-type': 'application/json', 'cache-control': 'no-store' }, CORS)
      });
    }

    if (!env.SECRET) {
      return reply({ error: 'server not configured: missing SECRET' }, 500);
    }

    /* Header preferred. Query fallback exists only so you can test in a
       browser address bar — avoid using it normally, since URLs end up
       in logs and history and the key is the only thing guarding this. */
    const given = (request.headers.get('x-sync-key') || url.searchParams.get('k') || '').trim();

    /* Trimmed on both sides: pasting a secret into a dashboard field very
       often carries a trailing newline, which produces a 401 against a
       secret that looks identical to the eye. */
    const want = String(env.SECRET).trim();

    if (!keyMatches(given, want)) return reply({ error: 'unauthorized' }, 401);

    // ---- Canvas calendar feed, fetched on the app's behalf ----
    if (url.pathname === '/canvas') {
      if (request.method !== 'GET') return reply({ error: 'method not allowed' }, 405);
      return canvasFeed(request);
    }

    if (request.method === 'GET') {
      const stored = await env.STATE.get(KEYNAME);
      if (!stored) return reply(null, 200);
      return new Response(stored, {
        headers: Object.assign({ 'content-type': 'application/json' }, CORS)
      });
    }

    if (request.method === 'PUT' || request.method === 'POST') {
      const body = await request.text();
      if (body.length > MAX_BYTES) return reply({ error: 'payload too large' }, 413);

      let parsed;
      try { parsed = JSON.parse(body); }
      catch (e) { return reply({ error: 'body is not valid JSON' }, 400); }

      /* Refuse anything that is not recognisably a protocol state, so a
         stray request can't blank out your history. */
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.checked)) {
        return reply({ error: 'not a protocol state object' }, 400);
      }

      await env.STATE.put(KEYNAME, body);
      return reply({ ok: true, bytes: body.length, mtime: parsed.mtime || null });
    }

    return reply({ error: 'method not allowed' }, 405);
  }
};
