import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.resolve(ROOT_DIR, process.env.COSMOS_OUTPUT_DIR || "public");
const CONFIG_PATH = path.resolve(
  ROOT_DIR,
  process.env.COSMOS_GALLERIES_FILE || "config/galleries.json",
);
const FEED_BASE_URL =
  process.env.COSMOS_FEED_BASE_URL ||
  "https://rclaycock.github.io/cosmos-scraper-mk-3";
const REQUEST_TIMEOUT_MS = getPositiveInteger(process.env.COSMOS_TIMEOUT_MS, 30_000);
const PAGE_SIZE = getPositiveInteger(process.env.COSMOS_PAGE_SIZE, 96);
const MAX_PAGES = getPositiveInteger(process.env.COSMOS_MAX_PAGES, 50);
const USER_AGENT =
  process.env.COSMOS_USER_AGENT ||
  "Mozilla/5.0 (compatible; CosmosScraperMk3/1.0; +https://github.com/rclaycock/cosmos-scraper-mk-3)";

const GRAPHQL_URL = "https://api.cosmos.so/graphql?q=GetClusterElements";
const CLUSTER_ELEMENTS_QUERY = `
query GetClusterElements($clusterId: ClusterId, $pageCursor: String, $pageSize: Int) {
  clusterConnections(
    clusterId: $clusterId
    meta: { pageSize: $pageSize, pageCursor: $pageCursor }
  ) {
    items {
      element {
        __typename
        ... on MediaElementTile {
          multipleMedia {
            ...ElementMedia
          }
          media {
            ...ElementMedia
          }
        }
        ... on ProductElementTile {
          media {
            ...ElementMedia
          }
        }
        ... on WebsiteElementTile {
          media {
            ...ElementMedia
          }
        }
      }
    }
    meta {
      nextPageCursor
      count
    }
  }
}

fragment ElementMedia on Media {
  __typename
  ... on StaticImage {
    url
    width
    height
    notSafeForWorkStatus
    aiGenerated
    blurHash
  }
  ... on AnimatedImage {
    url
    width
    height
    notSafeForWorkStatus
    aiGenerated
    blurHash
    video {
      url
    }
  }
  ... on Video {
    thumbnail {
      hash
      url
    }
    duration
    isStored
    mux {
      playbackUrl
      mp4Url(quality: LOW)
    }
    width
    height
  }
}
`.trim();

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const galleryEntries = await loadGalleryEntries();
  if (galleryEntries.length === 0) {
    throw new Error("No gallery URLs found. Check config/galleries.json or COSMOS_URLS.");
  }

  const summaries = [];

  for (const gallery of galleryEntries) {
    console.log(`\nScraping ${gallery.url}`);
    try {
      const feed = await buildFeed(gallery);
      const outputPath = path.join(OUTPUT_DIR, `${gallery.slug}.json`);
      await writeJson(outputPath, feed);
      summaries.push({
        slug: gallery.slug,
        url: gallery.url,
        count: feed.count,
        ok: feed.ok,
      });
      console.log(`Wrote ${gallery.slug}.json with ${feed.count} items`);
    } catch (error) {
      console.error(`Failed to scrape ${gallery.url}: ${error.message}`);
      const fallbackFeed = {
        ok: false,
        source: gallery.url,
        count: 0,
        items: [],
      };
      await writeJson(path.join(OUTPUT_DIR, `${gallery.slug}.json`), fallbackFeed);
      summaries.push({
        slug: gallery.slug,
        url: gallery.url,
        count: 0,
        ok: false,
      });
    }
  }

  await fs.writeFile(
    path.join(OUTPUT_DIR, "index.html"),
    renderIndexHtml(summaries),
    "utf8",
  );
}

async function loadGalleryEntries() {
  const overrideUrls = parseList(process.env.COSMOS_URLS);
  const rawEntries = overrideUrls.length > 0 ? overrideUrls : JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  const onlyTokens = new Set(parseList(process.env.COSMOS_ONLY));

  return rawEntries
    .map(normaliseGalleryEntry)
    .filter((entry) => {
      if (onlyTokens.size === 0) return true;
      return onlyTokens.has(entry.slug) || onlyTokens.has(entry.url);
    });
}

function normaliseGalleryEntry(entry) {
  if (typeof entry === "string") {
    return {
      url: entry,
      slug: slugFromUrl(entry),
    };
  }

  if (entry && typeof entry === "object" && typeof entry.url === "string") {
    return {
      url: entry.url,
      slug: entry.slug || slugFromUrl(entry.url),
    };
  }

  throw new Error(`Unsupported gallery config entry: ${JSON.stringify(entry)}`);
}

async function buildFeed(gallery) {
  const html = await requestText({
    url: gallery.url,
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  const clusterId = extractClusterId(html);
  const items = await collectFeedItems({
    clusterId,
    pageUrl: gallery.url,
  });

  return {
    ok: true,
    source: gallery.url,
    count: items.length,
    items,
  };
}

async function collectFeedItems({ clusterId, pageUrl }) {
  const collected = [];
  const seen = new Set();
  let pageCursor = null;

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const page = await fetchClusterPage({
      clusterId,
      pageCursor,
      pageUrl,
    });

    const elementItems = page.items || [];
    for (const entry of elementItems) {
      for (const item of normaliseElement(entry?.element)) {
        const key = `${item.type}|${canonicaliseUrl(item.src)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(item);
      }
    }

    const nextCursor = page.meta?.nextPageCursor || null;
    if (!nextCursor) {
      break;
    }

    pageCursor = nextCursor;
  }

  return collected;
}

async function fetchClusterPage({ clusterId, pageCursor, pageUrl }) {
  const payload = {
    operationName: "GetClusterElements",
    variables: {
      clusterId,
      pageCursor,
      pageSize: PAGE_SIZE,
    },
    query: CLUSTER_ELEMENTS_QUERY,
  };

  const text = await requestText({
    url: GRAPHQL_URL,
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      origin: "https://www.cosmos.so",
      referer: pageUrl,
    },
    body: JSON.stringify(payload),
  });

  const parsed = JSON.parse(text);
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join("; "));
  }

  return parsed.data?.clusterConnections || { items: [], meta: { nextPageCursor: null } };
}

function normaliseElement(element) {
  if (!element || typeof element !== "object") return [];
  const mediaItems = getElementMediaList(element);
  return mediaItems.map(normaliseMedia).filter(Boolean);
}

function getElementMediaList(element) {
  if (Array.isArray(element.multipleMedia) && element.multipleMedia.length > 0) {
    return element.multipleMedia;
  }

  if (element.media) {
    return [element.media];
  }

  return [];
}

function normaliseMedia(media) {
  if (!media || typeof media !== "object") return null;

  switch (media.__typename) {
    case "StaticImage":
      return makeFeedItem("image", media.url, media.width, media.height);
    case "AnimatedImage":
      if (media.video?.url) {
        return makeFeedItem("video", media.video.url, media.width, media.height);
      }
      return makeFeedItem("image", media.url, media.width, media.height);
    case "Video":
      return makeFeedItem(
        "video",
        media.mux?.mp4Url || null,
        media.width,
        media.height,
      );
    default:
      if (typeof media.url === "string") {
        return makeFeedItem("image", media.url, media.width, media.height);
      }
      return null;
  }
}

function makeFeedItem(type, src, width, height) {
  const normalisedSrc = canonicaliseUrl(src);
  if (!normalisedSrc) return null;

  return {
    type,
    src: normalisedSrc,
    width: clampDimension(width),
    height: clampDimension(height),
  };
}

function extractClusterId(html) {
  const scopedMatch = html.match(/GetClusterElements[\s\S]{0,800}?"clusterId":(\d+)/);
  if (scopedMatch) {
    return Number(scopedMatch[1]);
  }

  const looseMatch = html.match(/"clusterId":(\d+)/);
  if (looseMatch) {
    return Number(looseMatch[1]);
  }

  throw new Error("Could not find clusterId in page HTML.");
}

async function requestText({ url, method = "GET", headers = {}, body = null }) {
  try {
    return await requestTextWithFetch({ url, method, headers, body });
  } catch (error) {
    console.warn(`Fetch failed for ${method} ${url}. Falling back to curl. ${error.message}`);
    return requestTextWithCurl({ url, method, headers, body });
  }
}

async function requestTextWithFetch({ url, method, headers, body }) {
  const response = await fetch(url, {
    method,
    headers: {
      "user-agent": USER_AGENT,
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  return text;
}

async function requestTextWithCurl({ url, method, headers, body }) {
  const args = [
    "--silent",
    "--show-error",
    "--location",
    "--compressed",
    "--max-time",
    String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)),
    "--user-agent",
    USER_AGENT,
    "--write-out",
    "\n__CURL_STATUS__:%{http_code}",
    "-X",
    method,
  ];

  for (const [name, value] of Object.entries(headers)) {
    args.push("-H", `${name}: ${value}`);
  }

  if (body !== null) {
    args.push("--data-binary", body);
  }

  args.push(url);

  const { stdout } = await execFileAsync("curl", args, {
    maxBuffer: 25 * 1024 * 1024,
  });

  const match = stdout.match(/\n__CURL_STATUS__:(\d{3})$/);
  const text = match ? stdout.slice(0, match.index) : stdout;
  const status = match ? Number(match[1]) : 0;

  if (status >= 400) {
    throw new Error(`HTTP ${status}: ${text.slice(0, 500)}`);
  }

  return text;
}

function slugFromUrl(urlString) {
  const url = new URL(urlString);
  const parts = url.pathname.split("/").filter(Boolean);
  return parts.at(-1) || "gallery";
}

function canonicaliseUrl(urlString) {
  if (typeof urlString !== "string" || urlString.length === 0) {
    return null;
  }

  try {
    const url = new URL(urlString);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function clampDimension(value) {
  const number = Math.floor(Number(value) || 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(number, 20_000);
}

function getPositiveInteger(value, fallback) {
  const number = Number.parseInt(value ?? "", 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function renderIndexHtml(summaries) {
  const generatedAt = new Date().toISOString();
  const listItems = summaries
    .map((summary) => {
      const feedUrl = `${FEED_BASE_URL}/${summary.slug}.json`;
      return `
        <li>
          <a href="./${escapeHtml(summary.slug)}.json">${escapeHtml(summary.slug)}.json</a>
          <span>${summary.count} items</span>
          <code>${escapeHtml(feedUrl)}</code>
        </li>
      `.trim();
    })
    .join("\n");

  const exampleSlug = summaries.find((summary) => summary.ok)?.slug || "studio-tests";
  const exampleFeedUrl = `${FEED_BASE_URL}/${exampleSlug}.json`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Cosmos Scraper MK-3</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #13212f;
        --muted: #5d6f7d;
        --line: #d8e2e8;
        --paper: #f6f9fb;
        --card: #ffffff;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Basis Grotesque Pro", "Avenir Next", "Segoe UI", sans-serif;
        background: radial-gradient(circle at top, #ffffff 0%, var(--paper) 55%, #edf3f7 100%);
        color: var(--ink);
      }

      main {
        max-width: 960px;
        margin: 0 auto;
        padding: 48px 20px 64px;
      }

      h1 {
        margin: 0 0 12px;
        font-size: clamp(2rem, 5vw, 3.75rem);
        line-height: 0.95;
      }

      p {
        color: var(--muted);
        line-height: 1.6;
      }

      .card {
        margin-top: 28px;
        padding: 24px;
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--card);
        box-shadow: 0 24px 60px rgba(19, 33, 47, 0.08);
      }

      ul {
        margin: 18px 0 0;
        padding: 0;
        list-style: none;
      }

      li {
        display: grid;
        gap: 8px;
        padding: 14px 0;
        border-top: 1px solid var(--line);
      }

      li:first-child {
        border-top: 0;
        padding-top: 0;
      }

      a {
        color: inherit;
        font-weight: 600;
        text-decoration: none;
      }

      code,
      pre {
        font-family: "SFMono-Regular", "Menlo", monospace;
        font-size: 0.95rem;
      }

      pre {
        overflow-x: auto;
        padding: 16px;
        border-radius: 18px;
        background: #0f1720;
        color: #f3f8fb;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Cosmos Scraper MK-3</h1>
      <p>Generated ${escapeHtml(generatedAt)}. These feeds keep the same flat JSON contract as mk-2, but they are now built from Cosmos V2 GraphQL instead of a headless browser scroll capture.</p>

      <section class="card">
        <h2>Feeds</h2>
        <ul>
          ${listItems}
        </ul>
      </section>

      <section class="card">
        <h2>22slides Embed</h2>
        <pre>&lt;meta name="robots" content="noindex, nofollow"&gt;
&lt;section class="widget gallery gallery--cobblestone"
         data-cosmos-feed="${escapeHtml(exampleFeedUrl)}"
         data-cosmos-limit="0"
         data-cosmos-skip-avatars="1"&gt;
  &lt;div class="gallery__container"&gt;
    &lt;div class="gallery__images" id="rlp-collage"&gt;&lt;/div&gt;
  &lt;/div&gt;
&lt;/section&gt;</pre>
      </section>
    </main>
  </body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
