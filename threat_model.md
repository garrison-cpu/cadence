# Threat Model

## Project Overview

Cadence is a Node.js + Express application that serves a public-facing static frontend from `public/` and exposes a small same-origin proxy API from `server.js`. The frontend is a large single-page Preact app embedded in `public/app.html`; the backend forwards requests to Anthropic, TokAPI, and Reddit using secrets stored in environment variables. The current deployment is on Replit Autoscale and is configured as **private**, so internet-wide unauthenticated probing is out of scope unless production reachability is demonstrated.

## Assets

- **Provider API secrets** — `CLAUDE_API_KEY` and `RAPIDAPI_KEY` in the server environment. Exposure would let an attacker consume paid upstream services and impersonate the application to those providers.
- **Proxy spending authority** — even without leaking raw secrets, any reachable `/api/*` route can spend the owner’s Anthropic or RapidAPI quota. This is effectively a billable asset.
- **User research inputs and generated outputs** — niches, audience data, trend ideas, and generated content stored in browser local storage. This is lower sensitivity than server secrets but still user data that should not be exposed cross-origin.
- **Application origin trust** — because the frontend stores state in the same origin and relies on same-origin API calls, any active content served under the app’s origin can access browser-held data and act as the user within the application.

## Trust Boundaries

- **Browser → Express server** — all frontend requests cross into untrusted server input. The browser is not trusted to enforce access control, request shaping, or spend limits.
- **Express server → external APIs** — `server.js` forwards user-influenced requests to Anthropic, TokAPI, and Reddit. This is the highest-risk boundary because upstream requests use server-held secrets and inherit the application’s origin when proxied back to users.
- **Server secrets → application logic** — provider keys come from environment variables and must remain server-only.
- **Private deployment gate → application routes** — because the deployment visibility is private, public-internet abuse scenarios are deprioritized. Findings still matter if a weakness impacts authorized/private users or collapses same-origin trust.
- **Third-party content → first-party origin** — any proxied upstream response rendered as active content under the app’s origin can blur the boundary between trusted app code and untrusted third-party code.

## Scan Anchors

- Production entry points: `server.js`, `public/index.html`, `public/app.html`
- Highest-risk code areas: `/api/claude`, `/api/tokapi/*`, `/api/reddit/*` in `server.js`; any client storage or DOM sinks in `public/app.html`
- Surface split: static marketing site at `/`, app UI at `/app`, same-origin proxy API at `/api/*`
- Dev-only / usually ignore: `.local/`, build metadata, cached scanner rules, `node_modules/`

## Threat Categories

### Spoofing

There is no application-defined user account system in this codebase; the main spoofing risk is misuse of the server as a trusted caller to upstream APIs. The server must only send provider credentials to intended upstream hosts, and private deployment assumptions must not be treated as a substitute for validating any future authenticated or signed requests.

### Tampering

All client inputs, including prompt text, query parameters, and proxy paths, are untrusted. The server must constrain how user input shapes upstream requests so users cannot alter request targets, headers, or content types in ways that change the trust model of the application.

### Information Disclosure

The primary disclosure risks are exposure of provider secrets, browser-stored user data, and same-origin data reachable from the frontend. The application must avoid returning secrets to the client, avoid serving untrusted active content as first-party content, and avoid leaking unnecessary upstream error detail that expands attacker knowledge.

### Denial of Service

The most realistic DoS risk is cost or quota exhaustion against Anthropic and RapidAPI rather than process crashes. The backend must bound request sizes and expensive upstream usage so a reachable user cannot turn the proxy into an unmetered spend amplifier.

### Elevation of Privilege

Because the backend represents the app to external APIs, any flaw that lets a user broaden proxy reach, execute third-party active content under the app origin, or pivot from browser input into server-side capability expansion is a privilege-escalation issue. All proxied routes must preserve strict host, path, and response-type constraints so users cannot gain more power than intended by the product design.
