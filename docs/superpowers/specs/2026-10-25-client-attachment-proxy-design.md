# Client Attachment Proxy — design (v1.0, 2026-10-25)

Status: APPROVED — build DEFERRED by user 2026-10-25 ("we will build later").
Tracker: CAPTUREPIP #21 (Todo) — https://192.168.2.201:8090/jotty (project Capture Pipeline).
Scope locked by user 2026-10-25 (all option-1 picks).
Upstream target: jotty 1.29.x attachment serving (`/api/attachment/<itemUuid>/<name>`), prod updated 2026-10-25.

## 0. Problem

The client syncs note content verbatim, so migrated notes arrive with server-relative
asset URLs (`![](/api/attachment/<uuid>/<name>.png)`). In the Tauri webview those srcs
resolve against the app origin and cannot load; nothing in the client fetches them.
Result: notes with embedded images render a broken/empty image slot. (Identical
behavior pre-migration with `/api/image/...` — this feature makes images actually work.)

## 1. Goal / success criteria

1. Opening a note whose markdown embeds `/api/attachment/...` images shows the real
   image inline, in both editor surfaces (visual TipTap view + markdown-mode preview).
2. Works offline after first display (disk cache).
3. Byte-purity: the note's stored markdown (and the server copy) is NEVER modified by
   rendering — save round-trip stays byte-exact minus the edited region (0.31.3 law).
4. No access (401/403/404/offline-uncached) → neutral placeholder, never a crash and
   never silent re-save of content.
5. Client stays a pure stock-API consumer — no server fork, no cookie emulation.

Out of scope (locked with user): upload/insert/delete attachments (upstream has no REST
upload endpoint; insert-by-URL already exists and is unchanged), video/file inline
playback (fileAttachment cards stay cards), avatar serving, legacy
`/api/image|file|video/...` proxying, thumbnail strip for attachment cards.

## 2. Server facts this design stands on (source-verified at 1.29.1)

- `GET /api/attachment/{itemUuid}/{name}` authenticates via session cookie OR
  `x-api-key` header (`whoGoesThere`); access = `mayView` = owner / shared-READ /
  public item; serves bytes with `Content-Type: mimeOf(name)`, `CachePolicies.PRIVATE`
  headers, inline disposition for images. Non-owner failures: 401 (anon), 404
  (masked, for both not-found AND no-permission when authed — `_turnAway`).
- **Attachment names are immutable**: `storeUpload`/`adoptFile` never overwrite an
  existing `(itemUuid, name)` — same name + different bytes ⇒ suffixed new file
  (`image-1.png`) with a NEW URL. Therefore `(uuid, name) → bytes` is a stable
  mapping: cache-forever per name is semantically correct; no invalidation protocol
  exists or is needed. Cache shrink only (size-cap prune).
- Legacy `/api/image|video|file/<user>/<file>` routes authenticate ONLY by cookie
  (`getCurrentUser`); the API key is NOT consulted there. Zero legacy refs exist on
  prod today. ⇒ the proxy maps ONLY the modern route; legacy refs stay undecorated
  (render as whatever they render as today).

## 3. Approach (locked: option 1 = custom-protocol proxy + view-only)

Rejected alternatives (documented so the plan doesn't relitigate):

- **Data-URL rewrite at md→html** — memory blowup (base64 +33% per view, per open),
  no persistence across launches, and `JottyImage` parses with `allowBase64: false`
  (portal parity) so data: srcs would be dropped on parse-back anyway. Rejected.
- **Absolute URL in img src (`<base>/api/attachment/...`)** — `<img>` requests can't
  carry the `x-api-key` header; the client holds no session cookie; only public
  attachments would render; no offline cache. Dead end. Rejected.

### 3.1 Architecture

```
SQLite store (original md, untouched)
        │  sync (unchanged)
        ▼
editor/doc model: img node attrs.src = ORIGINAL relative URL (never rewritten)
        │                                │
        │ node VIEW (visual)             │ markdown-preview DOM pass
        ▼                                ▼
display src = jottyatt://<sanitized path & query>   (via convertFileSrc(src, 'jottyatt'))
        │
        ▼ (webview → native)
Tauri custom protocol handler (Rust, registers scheme `jottyatt`)
        │ parse → (itemUuid, name) → cache path
        ├─ cache HIT  → serve file bytes from disk (correct mime)
        └─ cache MISS → GET <base>/api/attachment/<uuid>/<name>
                        (reqwest, x-api-key from AppState) → write cache → serve
                any failure → HTTP 404 response → node view overlays placeholder
        ▼
wry <img> renders bytes
```

### 3.2 Rust side — new module `src-tauri/src/jotty/assets.rs`

- `display_src_for(src: &str) -> Option<String>`-equivalent lives FRONTEND-side in TS
  (single source of truth for the pattern); Rust receives the already-decorated URL.
- Protocol handler — registered in `lib.rs` `Builder::default()...` via
  `.register_uri_scheme_protocol("jottyatt", handler)`:
  - Input URI: `jottyatt://att/<itemUuid>/<percent-encoded name>` (+ cache-buster
    query, stripped before lookup). Windows/Android URL form differences are
    absorbed by calling `convertFileSrc(path, 'jottyatt')` from the frontend
    (`http://jottyatt.localhost/...` on Windows form is parsed identically — the
    handler matches BOTH host forms defensively but construction is always via
    `convertFileSrc`).
  - Reads `AppState`: base URL + API key come from `state.client`
    (`RwLock<Option<JottyClient>>`). `JottyClient` fields are private → add
    `pub(crate) async fn attachment_request_parts(&self) -> (String, String)`
    (base, key) accessor; OR read `sync_state` instance_url + keystore directly like
    `restore_connection` does. Decision for the plan: accessor on the client struct
    (one borrow, no second reqwest client build).
  - NOT connected (client = None) → 404 response (placeholder path), never a panic.
  - Cache dir: `app_cache_dir()/attachments/<itemUuid>/<name>` (Tauri
    `BaseDirectory::Cache`), keyed by sanitized `fileOf`-equivalent rules lifted
    from upstream `store.ts` (`isCleanName`: no leading dot, no `\\ / \0`, ≤180
    bytes) — a hostile URL string can never produce a traversal path
    (`..`-segments rejected before any fs touch).
  - Fetch: GET `<base>/api/attachment/<uuid>/<name>`, header
    `x-api-key: <key>`, 30s timeout, streaming to a temp file, atomic rename into
    the cache slot, then serve. Response to webview: status passthrough for
    2xx; EVERY non-2xx ⇒ 404-style empty response + delete of the temp file
    (never cache error bodies).
  - Offline rule: on fetch failure with an EXISTING cache slot, serve stale bytes
    (stale-while-error). No cache slot + unreachable ⇒ 404.
  - Size cap: single-attachment cap = `maximumFileSize`-like constant 25 MB
    (server allows up to settings.maximumFileSize, 10 MiB default ⇒ 25 MiB headroom
    is safe); over-cap ⇒ refuse and 404. Startup prune: if cache dir > 250 MB, drop
    oldest-mtime files until under cap.
  - Mime: mirrored tiny `mimeOf` table (image exts first: png/jpe?g/gif/webp/avif,
    video mp4/webm/mov, pdf, text/plain, fallback application/octet-stream) — the
    webview render only needs image/* correctness; the rest is card semantics.
- Testing (cargo, wiremock):
  - URL parse: happy path, percent-encoding, cache-buster query, BOTH host forms,
    traversal/name attacks rejected (30+ fuzz-ish cases as a table).
  - Cache miss→fetch→serve: request has `x-api-key` header (assert), bytes served,
    cache file created atomically.
  - Cache hit: NO network call (hit counter = 0), bytes from disk.
  - Stale-while-error: mounted failing server + pre-seeded cache slot → 200 from disk.
  - 401/403/404/500 upstream ⇒ 404-style response, no cache write, temp cleaned.
  - No client connection ⇒ 404-style, no panic.
  - Mime table: png→image/png, unknown→octet-stream (exact map fixtures).

### 3.3 Frontend side

- **Decoration fn** (`src/editor/attachmentProxy.ts`, pure, exported):
  `isProxyableAttachmentSrc(src): boolean` — absolute-path, src starts with
  `/api/attachment/`, path parses to ≥2 segments, name passes a JS mirror of
  `isCleanName`. `decorateAttachmentSrc(src): string` — `convertFileSrc(rest,
  'jottyatt')` inside try/catch (jsdom: return `jottyatt://` + rest verbatim so
  tests can assert the string deterministically).
  Patterns NOT matched (stay as-is): `https://...` external images (already work in
  the webview), `/api/image|file|video/...` legacy (server can't auth them by key),
  relative `./` paths, data: URLs.
- **Visual editor**: ReactNodeView for `JottyImage` (`src/editor/extensions/image.ts`
  gets `addNodeView()`; `src/editor/AttachmentImageView.tsx`):
  - Renders `<img src={decorateAttachmentSrc(node.attrs.src)} …existing sizing
    attrs…>` — the doc MODEL keeps the original src (fence: getJSON().src ==
    original string is a standing test).
  - `onError` → state → overlay chip on the frame: "attach-ment unavailable offline"-
    style compact label (neutral broken-image placeholder per locked option); click
    chip = retry (append `?r=<Date.now()>` cache buster, reset error state).
  - `onLoad` clears error state. Selected-node UI (resize flow `useImageResize`)
    keeps working — node view must not swallow drag/resize handles (verify against
    existing imageResize tests).
- **Markdown preview** (`MarkdownPreview` in `src/components/MarkdownEditor.tsx`):
  the existing `useEffect` DOM pass (same shape as `enhanceDiagramFragment`) walks
  rendered `img[src^="/api/attachment/"]` nodes and rewrites `src` to the decorated
  form + same onError placeholder chip + click-to-retry. Preview is display-only —
  nothing reads this HTML back into the doc (0.31.3 law holds trivially).
- **Save path: untouched.** Turndown reads the doc model (node view renders are
  excluded from `editor.getHTML()`); no new turndown rules; round-trip purity is a
  REQUIRED zero-delta fence (existing markdown/image tests stay green unchanged).
- **fileAttachment cards**: sniffing unchanged — ext-based sniff already classifies
  `image.png`; `/api/attachment/` does not need to enter the sniff map (cards are
  name+type only). Optional rider (if a leaf wants it, same phase): accept
  `/api/attachment/` in the type-check branch. Non-blocking.
- CSP: `tauri.conf.json` has `"csp": null` (disabled) today — no CSP change needed;
  the spec records this state so a future CSP introduction must add `jottyatt:`
  to img-src (comment next to the security key).

### 3.4 Data flow / states

- Editor open with image note → node view mounts → decorated src → protocol request:
  cache hit (instant) | fetch (spinner: browser-native image loading; no custom
  spinner phase) | 404 (placeholder chip).
- No async state is stored app-side; the img element owns its loading lifecycle.
- Delete note containing images → cache entries for its uuids are NOT pruned
  proactively (bounded by the 250 MB cap; a sync-success sweep MAY prune orphaned
  uuid dirs as a non-blocking follow-up — explicit out if not needed).

## 4. Verification plan

1. Cargo gates (baseline census law stands; expect +0 warnings — new module code).
2. Vitest: pure-fn tables for isProxyable/decorate; node view mount (jsdom): model
   purity + chip on simulated error + retry bumps buster; preview DOM pass; save
   round-trip byte-fence on a note containing image + ZWSP + CRLF (the
   Enterprise-Fortress shape).
3. Headless UX probe (WebKitGTK harness, real dist): dev fixture upgraded to
   jotty **1.29.1** (image pin `ghcr.io/fccview/jotty:1.29.1`; bind drift law —
   resolve mounts via docker inspect); seed an attachment by writing the file into
   the fixture's `data/attachments/<uuid>/` + a note md referencing it; assert
   `img` renders with `naturalWidth > 0` (evaluate_javascript), then take stills
   at 1280 + 412 (mobile layout law: editor card + preview).
4. Offline probe: stop the fixture container with cache warm → image still renders
   (cached). Also 403 probe: remove the fixture user's access → chip appears,
   content text unchanged on disk after a Save (byte-compare).
5. integration_real.rs (env-gated): attachment GET against a real 1.29.1 instance
   returns 200 + matching bytes; 404 on unknown uuid; header asserted on the wire.
6. Phone gate (explicit): the custom-protocol round-trip on Android is the ONE
   platform-behavior risk — device verify required before the Android stage ships.

## 5. Risks / mitigations

- **Save pollution** (jottyatt:// leaking into server md): mitigated by node-view
  render (model untouched) + standing byte-fence test; the turndown layer gains ZERO
  new rules.
- **Windows/Android protocol URL forms**: construction always via `convertFileSrc`;
  handler accepts both forms; phone gate covers Android reality.
- **Legacy refs** (can't be key-authed upstream): stay undecorated; if upstream
  later key-enables legacy routes, extend the pattern set (one-line change).
- **CSP currently null**: recorded; no change; future CSP must whitelist the scheme.
- **Dev fixture bump 1.28.0 → 1.29.1** touches the harness all integration tests
  rely on: the fixture swap runs BEFORE implementation starts (plan task 0), and
  the full existing suite re-runs against it — any pre-existing-suite breakage
  lands in Phase 0, not mid-feature.

## 6. Phasing (SDD)

- **P0**: dev fixture 1.29.1 swap + suite confirmation (pre-existing-green proof).
- **P1**: Rust `assets.rs` module + protocol registration + accessor + cargo tests.
- **P2**: frontend decoration + node view + preview pass + chip + vitest fences.
- **P3**: seam verification (headless UX probe + integration_real + stills) + gates.
- Release follows the standing ship procedure at an explicit release ask
  (Desktop+Android per locked scope; APK-first staging order applies).