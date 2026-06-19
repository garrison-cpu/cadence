# Cadence — beta (Replit)

Marketing site + the tool, combined, with a server-side proxy so your API keys
are **never exposed to the browser**.

## How the pieces fit

```
visitor → /            marketing site (public/index.html)
        → /app         the tool       (public/app.html)
the tool → /api/claude → server.js → Anthropic   (server adds your key)
         → /api/tokapi → server.js → TokAPI      (server adds your key)
         → /api/reddit → server.js → Reddit      (avoids browser CORS)
```

The browser holds **no keys** and never talks to Anthropic/TokAPI directly.

## Run it on Replit (5 minutes)

1. Create a new Repl → "Import from / upload" → drop this whole folder in.
2. Open **Tools → Secrets** and add (see `.env.example`):
   - `CLAUDE_API_KEY` — your Anthropic key
   - `RAPIDAPI_KEY` — your RapidAPI/TokAPI key
   - `CLAUDE_MODEL` *(optional)* — defaults to `claude-sonnet-4-6`
3. Press **Run**. Replit installs `express` and starts `server.js`.
4. Open the web preview. `/` is the site; clicking any CTA goes to `/app`.

## Why your Claude key is safe now

Originally the tool called `api.anthropic.com` from the browser with your key in
an `x-api-key` header (it even used `anthropic-dangerous-direct-browser-access`).
Anything in browser JS is visible in DevTools — there is no way to hide a key
client-side. Now the key lives only in `process.env.CLAUDE_API_KEY` on the
server (a Replit Secret), and the browser calls your `/api/claude` endpoint with
no key at all. Same pattern for the RapidAPI key.

## Access

Open — anyone with the link can use it. All usage runs on **your** keys, so you
pay for everything. There is no per-user limit yet, so a single heavy user (or
someone who finds the link) can run up your API bill. When you want to cap that,
add a rate limit or an access gate in front of the `/api/*` routes in
`server.js`.

## Notes / next steps

- The tool's brand "direction" is locked to **full**.
- "Watch 2-min demo" and the demo button are placeholders (no video yet).
- "Talk to sales" points to `hello@example.com` — change it in `public/index.html`.
- For real SaaS later, add per-user accounts + Stripe and per-user usage
  metering in `server.js` before each `/api/claude` call.
  The proxy you have now is exactly the right foundation — no rebuild needed.
