# Termail website

Public product site for Termail. Fully static: semantic HTML, plain CSS,
and a small vanilla script for the setup copy buttons. No framework, no
build step, no dependencies. The CLI application is untouched; everything
for the site lives under `website/`.

## Serving locally

Serve the `website/` directory with any static file server. Examples:

```bash
cd website
python -m http.server 8000
```

```bash
cd website
npx serve .
```

Then open `http://localhost:8000` (port depends on the server you chose).

Deployment works the same way: serve the static files directly from
`website/`. There is no server runtime and nothing to build.

## Files

- `index.html` — the complete single page.
- `styles.css` — the full site stylesheet.
- `script.js` — copy-button behavior only; the page is fully readable
  without JavaScript.
- `termail.png` — byte-identical copy of the synthetic demo screenshot at
  `docs/termail.png`. It shows fictional demo data, never private mail.

## Canonical and social metadata

There is no production domain yet, so the page deliberately omits a
self-referencing canonical URL and absolute Open Graph URLs (`og:url`,
`og:image` require absolute URLs and no domain has been chosen — nothing
is invented or hardcoded).

When the domain is chosen, add inside `<head>` in `index.html`, using the
real origin (shown here with a placeholder):

```html
<link rel="canonical" href="https://example.com/" />
<meta property="og:url" content="https://example.com/" />
<meta property="og:image" content="https://example.com/termail.png" />
```

No tooling change is needed: edit the values directly, since the site has
no build step. `twitter:card` is currently `summary` (no image); switch it
to `summary_large_image` and add `twitter:image` at the same time if
desired.
