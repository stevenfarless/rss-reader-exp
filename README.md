# RSS Reader

A reading-focused RSS reader designed to run entirely on GitHub Pages. It uses static HTML, CSS, and vanilla JavaScript with no build step.

## Features

- RSS 2.0, RSS 1.0/RDF, Atom, and JSON Feed parsing
- One Add a feed box: type a feed or website address to add it directly (conventional locations and WordPress are probed for bare sites), or type a publication, podcast, or topic to search Apple Podcasts and public RSS directories (RSS.mobi and RSSAmp, plus Feedsearch for website addresses) in one deduplicated result list
- Discover feed links from publisher pages
- Feed refresh, unread and saved article views, and per-feed navigation
- Feed folders: create, rename, delete, and move feeds between folders (OPML folders are kept on import). Click a folder name in the sidebar to read all of its feeds as one merged newest-first list; collapse a folder with the chevron beside its name (the collapsed state is remembered)
- Unsubscribe from a feed with the × beside it in the sidebar, or from the Folders &amp; tags dialog; the feed's articles are removed, except ones you saved
- Article tags: create, rename, and delete tags; apply them from the reader (t); filter by tag from the sidebar; search covers tags
- Full-text search: the search box matches article bodies (loaded full text, then feed content) as well as titles, summaries, authors, and tags
- Saved searches: save the current search and view as a named filter in the sidebar (keywords, feed/folder scope, tag, unread-only), with rename/delete in the organize dialog
- Rules: automatically tag, save, or mark read new articles that match (feed/folder scope, title keyword, author). Rules run on new arrivals at refresh and never delete anything; manage them in Settings with an on/off toggle per rule
- Highlights and notes: select text in the reader to save a highlight with an optional note; passages are marked back into the article when it opens, listed under the article and in a Highlights view, with edit-note, show-in-article, and delete
- Markdown article rendering for plain-text RSS, Atom, and JSON Feed content, including headings, links, lists, tables, and code blocks
- Full-article view: "Load full article" (or press W to toggle full article / feed excerpt) extracts the article text from the original page with Mozilla Readability (the library behind Firefox Reader View), with a hand-rolled fallback
- Listen to an article in the reader (text-to-speech, with pause/resume, stop, and speed)
- Estimated reading time on cards and in the reader
- Reader font (serif, sans-serif, Nunito, Ubuntu) and line height (compact/comfortable/roomy) in Settings
- Share an article: the system share sheet, or a copy-link fallback where the sheet is unavailable
- Mark everything above or below the open one read (in the Mark read menu, Ctrl+M / Shift+M)
- Snooze an article (later today, tomorrow, next week) with a Snoozed view and unsnooze
- Duplicate articles (the same address in more than one feed) shown once, with a toggle in Settings
- Mute a feed: hide its articles from All and Unread without unsubscribing
- Search, date filters, and newest/oldest sorting
- OPML subscription import and export
- JSON settings import and export
- Subscriptions and preferences stored in browser localStorage
- Article cache and read/saved state stored in IndexedDB
- Application-style desktop toolbar with a searchable command palette, activity center, and persistent layout presets
- Mobile bottom navigation for All, Unread, Queue, and Saved, with secondary views and actions grouped under More
- Multi-select articles with bulk mark-read, save, and queue actions, including range selection
- Touch gestures in the article list to mark read or save, and horizontal navigation between open articles
- Focus reading mode that expands the reader and hides surrounding navigation
- Responsive desktop and mobile layout
- Collapsible sidebar: the ‹/› toggle in the top left folds the sidebar to a narrow rail, remembered across visits
- Per-feed automatic refresh scheduling on launch and while the reader is open, with a last-updated time under the heading
- Undo for bulk actions (mark all in this list read, unsubscribe)
- Article thumbnails, per-feed favicons, and relative dates ("5m ago")
- Dark mode by default, with light, system, OLED Black, and Pure White options
- Complete profile backup and restore: subscriptions, articles, read/saved/queued state, highlights, notes, folders, rules, searches, and preferences; restore can replace or merge
- Reading queue with persistent manual ordering
- Feed health indicators, last refresh details, retrieval-path diagnostics, and exponential retry backoff
- Global and per-feed refresh intervals while the reader is open
- Configurable article retention with protected saved, queued, highlighted, and noted items; browser storage estimates in Settings
- OPML import preview with folder, duplicate, and invalid-URL reporting before import
- Export highlights and article notes as JSON or Markdown, including available timestamps
- Local reading activity statistics with selectable time ranges
- Optional keyboard shortcut coaching after mouse or stylus actions
- Collapsed sidebar navigation rail with library views, next-unread, search, refresh, theme, and settings actions
- Browser end-to-end tests with Playwright, run alongside the Node test suite in GitHub Actions
- Adjustable reading width and text size
- Keyboard shortcuts: / search, j/k navigate, n/p next/previous unread, o or Enter open, v open original, m toggle read, s save, t add a tag, a mark all in this list read, Ctrl+M / Shift+M mark everything above/below read, u back to list, g then a/u/s go to All/Unread/Saved, r refresh, Space scroll, ? help, Esc close
- Gentium Book Plus typography

## Hosting

The GitHub Actions workflow in `.github/workflows/static.yml` deploys the repository root to GitHub Pages. A separate workflow runs the Node and Playwright test suites on pull requests and pushes to the default branch. Set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**.

### Automated audits

The `.github/workflows/lighthouse.yml` workflow runs on pull requests targeting `main`, pushes to `main`, and manual dispatches. It launches real Chrome through Lighthouse CI, audits the static site on a local server, and runs three Lighthouse passes. Performance, accessibility, best practices, and SEO thresholds initially report warnings so the first measurements can establish a baseline without blocking deployment.

Each run saves HTML and JSON reports as a downloadable GitHub Actions artifact for 30 days. Reports stay in the workflow artifact rather than being sent to public report storage.

The project test suite also checks the web app manifest, required icon files, mobile viewport metadata, and service worker registration and lifecycle handlers. These checks cover repository-level PWA configuration.

**Lighthouse no longer includes a PWA category.** Google removed it in Lighthouse 12. The workflow therefore uses current Lighthouse categories and explicit PWA configuration regression tests. To verify Chrome's live installability diagnostics, open the deployed site in Chrome and inspect **DevTools → Application → Manifest**. The automated checks do not claim to replace that browser-level check.


## Feed access

Browsers enforce cross-origin resource sharing (CORS). This reader loads feeds entirely in the page, with no backend of its own, in this order:

1. Direct fetch of the feed (works when the publisher sends permissive CORS headers).
2. The site's own WordPress REST API (`/wp-json/wp/v2/posts`), which sends permissive CORS headers even when the site's `/feed` does not.
3. A public feed-to-JSON service (rss2json), as a last resort. The feed address passes through that third party.

Feeds that block cross-origin requests and offer none of the above still cannot load from a browser page; that is a browser security rule, not a bug in this reader.

"Load full article" fetches the article the same way: directly, then the site's own WordPress API looked up by the article's slug (no third party involved), then public reader services (a Markdown reader, then a generic proxy). The fetched page is reduced to the article itself with Mozilla Readability (the library behind Firefox Reader View), falling back to a hand-rolled extractor when Readability returns nothing. Those services are free and rate-limited, and some publishers block them, so full text is not guaranteed for every site.

## Feed discovery

The Add Feed box takes a feed or website address, or a name or topic. An address is added directly: a bare website is probed at the conventional locations (`/feed`, `/rss`, `/feed.xml`, `/rss.xml`, `/atom.xml`, `/index.xml`) and through the WordPress API. A name or topic queries Apple Podcasts, RSSAmp, and RSS.mobi, and a website address also queries Feedsearch as a fallback if the direct add fails. Search terms are sent to those services; subscriptions and preferences remain in this browser. Results from the providers are combined and deduplicated by feed URL. Each provider is independent, so a temporary outage does not block the others.

## Local data

Subscriptions and preferences belong to the current browser profile and site origin. Export OPML and JSON backups before clearing site data or moving to another browser or device. Cached articles and reading state use IndexedDB.

## Bundled libraries

- [DOMPurify](https://github.com/cure53/DOMPurify) 3.4.18 sanitizes converted feed content before it enters the page. Its license is included in `licenses/DOMPurify-LICENSE.txt`.
- [Mozilla Readability](https://github.com/mozilla/readability) 0.6.0 extracts the article body from a fetched page for "Load full article". Its license is included in `licenses/Readability-LICENSE.txt`.
- `markdown.js` is a small local Markdown renderer maintained in this repository.

## Fonts

All fonts are bundled locally in `fonts/` and served by this repository, with no font CDN or cross-repository dependency:

- Gentium Book Plus (serif, the reader default): Regular, Bold, Italic, BoldItalic.
- Inter (sans, the UI font and the Sans-serif reader option): variable Regular and Italic, weight 100-900. License: `fonts/inter-font-license.txt` (OFL 1.1).
- Nunito (reader option): variable Regular and Italic, weight 200-1000, latin subset. License: `fonts/nunito-font-license.txt` (OFL 1.1).
- Ubuntu (reader option): Regular, Bold, Italic, BoldItalic, latin subset. License: `fonts/ubuntu-font-license.txt` (Ubuntu Font Licence 1.0).

## License

GNU General Public License v3.0. See [LICENSE](LICENSE).
