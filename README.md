# Cosmos Scraper MK-3

This is a fresh rebuild of the Cosmos gallery scraper for Cosmos V2.

The output contract stays compatible with the 22slides code insert:

```html
<meta name="robots" content="noindex, nofollow">
<section class="widget gallery gallery--cobblestone"
         data-cosmos-feed="https://rclaycock.github.io/cosmos-scraper-mk-3/studio-tests.json"
         data-cosmos-limit="0"
         data-cosmos-skip-avatars="1">
  <div class="gallery__container">
    <div class="gallery__images" id="rlp-collage"></div>
  </div>
</section>
```

## What Changed In Cosmos V2

- The site is now a Next.js app-router build with streamed server components.
- Gallery pages still rely on GraphQL.
- Public gallery HTML exposes the current `clusterId`.
- The gallery media comes from `clusterConnections(...)`, with typed media objects for `StaticImage`, `AnimatedImage`, and `Video`.

That means the old browser-scroll scraper is no longer the best base layer. It can still be useful for debugging, but mk-3 uses direct HTTP requests instead.

## MK-3 Approach

1. Fetch the public gallery page.
2. Extract the live `clusterId` from the page HTML.
3. Page through Cosmos V2 GraphQL with `GetClusterElements`.
4. Flatten only real media objects into the feed:
   - `StaticImage` -> `image`
   - `AnimatedImage.video.url` -> `video`
   - `Video.mux.mp4Url` -> `video`
5. Publish JSON files to GitHub Pages.

Because the scraper only reads typed media fields, it avoids the old mk-2 problems where unrelated URLs such as profile avatars or video thumbnails leaked into the feed.

## Output Shape

Each feed stays flat and simple:

```json
{
  "ok": true,
  "source": "https://www.cosmos.so/rlphoto/studio-tests",
  "count": 238,
  "items": [
    {
      "type": "image",
      "src": "https://cdn.cosmos.so/...",
      "width": 1080,
      "height": 1440
    }
  ]
}
```

## Local Use

```bash
npm install
npm run scrape
```

Generated files land in `public/`.

Useful overrides:

- `COSMOS_ONLY=studio-tests npm run scrape`
- `COSMOS_URLS=https://www.cosmos.so/rlphoto/studio-tests npm run scrape`
- `COSMOS_FEED_BASE_URL=https://rclaycock.github.io/cosmos-scraper-mk-3 npm run scrape`

## Add Or Remove Galleries

Edit [config/galleries.json](/Users/rupertlaycock/Documents/GitHub/cosmos-scraper-mk-3/config/galleries.json).

Each URL becomes `<slug>.json`, where `<slug>` is the last path segment of the Cosmos URL.

## GitHub Workflow

The workflow lives at [.github/workflows/Comsos-scraper-03.yaml](/Users/rupertlaycock/Documents/GitHub/cosmos-scraper-mk-3/.github/workflows/Comsos-scraper-03.yaml) and runs hourly plus manual dispatch.

It does not commit generated JSON back to `main`. Instead it deploys the current `public/` folder straight to GitHub Pages, which keeps the repository history clean.
