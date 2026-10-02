# YouTube transcripts for ChatGPT web UI

A self-hosted MCP backend for retrieving available YouTube captions into a ChatGPT conversation. Supports mixed batches of up to **10 video IDs, URLs or share links**, creator uploads, ordered playlists, chapters and time ranges. Clean paragraph Markdown is the default: video title, canonical URL and transcript text, without a timestamp next to each word.

This repository contains the application and private acquisition worker—not a preconfigured public transcript service. You must deploy your own instance and connect it to your ChatGPT account. No paid transcript API, proxy, model service or YouTube cookies are required by this implementation. Hosting costs and upstream limits still apply; some videos cannot be retrieved.

## Mental model

```text
ChatGPT conversation (select / mention your connected app)
    │ managed OAuth + MCP tool calls
    ▼
ChatGPT Sites: HTTPS /mcp + durable D1 snapshots + acquisition queue
    ▲ signed job claims and results (outbound HTTPS only)
    │
Private Docker worker on your VPS → public YouTube metadata and captions
```

- **ChatGPT web UI is the client.** Its connected app advertises the tools. Calling a tool returns transcript text to the model's context, not merely a completion status. What ChatGPT chooses to quote in its final response is separate from the tool result.
- **Sites is the authenticated MCP server and cache.** It normalizes inputs, keeps successful caption snapshots, isolates per-video failures and queues missing data. A pending job is not a transcript and must be followed up.
- **The VPS worker retrieves uncached data.** It polls the Site, fetches available captions, and submits signed results. It has no inbound port and does not need your ChatGPT credentials. A Mac is not required.
- **Two separate authentication boundaries:** ChatGPT connects through the managed Sites OAuth/app gateway; the worker uses an Ed25519 signing key whose private half stays in its persistent volume. The optional MCP bearer service key is not the worker key and is not a substitute for the managed ChatGPT OAuth flow.

Successful stored captions are reused across normalized links and repeated calls. “Never refetch” depends on preserving the database/snapshots; deleting or replacing storage loses that guarantee. Metadata may have different refresh semantics. This is not an unlimited coverage or throughput promise.

## Tools and output

| Tool | Purpose |
|---|---|
| `get_transcripts` | 1–10 mixed IDs/URLs/share links; cleaned full text by default |
| `get_creator_transcripts` | Newest available captions; default 10, limit 1–100; bounded scan of at most 3×limit uploads to fill caption gaps |
| `get_playlist` | Observed playlist order, including duplicates/unavailable slots; ignores URL `index=` |
| `get_playlist_transcripts` | Captions in that order, without filling failed positions from later videos |
| `get_video_info` | Video metadata and supplied caption tracks |
| `get_available_languages` | Available track languages/types, not machine translation |
| `get_transcript` | Original caption cues, explicitly paginated |
| `get_timed_transcript` | Caption cues and timestamp links, explicitly paginated |
| `get_video_chapters` | Provenance-labelled native/description chapters; deterministic heuristic headings only when requested |
| `get_transcript_range` | Whole cues intersecting a requested range or chapter, from a stored snapshot |

Full cleaned text is returned when the **whole serialized response fits 240 KiB**. Larger results explicitly return continuation cursors—never silent truncation. Follow each video's `next_cursors`; creator and playlist selection cursors are separate. Selection processes at most ten items per call. `acquisition_pending` requires a follow-up after the stated delay. Explicit access/bot denials must not be retried or bypassed.

Transcript cleaning does not summarize, translate, infer speakers or invent missing speech. Captions remain untrusted source material. Range results disclose requested versus actual cue coverage; chapters distinguish creator, upstream-generated, unknown and heuristic provenance.

## Install

### 1. Prerequisites and local checks

You need Node.js **22.13+**, an existing Docker/Dokploy VPS, access to ChatGPT Sites with managed D1/MCP support, and permission to create/connect a custom ChatGPT app. Availability and administrator controls vary by account: consult the current [ChatGPT MCP setup guide](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) and [app connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).

```sh
git clone https://github.com/jroth1111/chatgpt-web-ui-youtube-transcripts.git
cd chatgpt-web-ui-youtube-transcripts
npm ci
npm test
npm run check:public
npm run build
```

The unit tests use synthetic data and local SQLite. They do not prove that your network can retrieve live YouTube captions. The authenticated root page is a status shell, not a transcript viewer.

### 2. Set up the Sites backend

Import this source into a new, or explicitly selected, ChatGPT Site. Let Sites assign its own project identity; do not copy another deployment's identity. Enable the MCP capability and a managed D1 binding named `DB` using `.openai/hosting.json`. Apply the migrations in `drizzle/` through the managed deployment workflow, without resetting existing production data.

Configure these **private deployment settings**, never in committed files:

| Setting | Value / purpose |
|---|---|
| `OWNER_EMAIL` | Your authorized owner identity |
| `MCP_AUTH_KEY` | A securely generated service token of at least 32 characters |
| `ACQUISITION_MODE` | `private_mac` — a legacy selector name; the worker runs on Linux/VPS too |
| `ACQUISITION_PUBLIC_KEY` | Public Ed25519 key from worker initialization below |
| `ACQUISITION_CLAIM_WORKER_ID` | The matching public worker ID, to pin job claims |

Publish the Site and record its actual HTTPS origin. The MCP URL is `https://YOUR-SITE/mcp`. Initial publication and key registration may need separate managed configuration steps; do not treat a successful build as a configured service.

The owner identity headers are trusted only behind the Sites gateway that authenticates users and strips caller-supplied identity headers. Do not expose this application on an arbitrary host with spoofable identity headers. The repository does **not** implement a standalone OAuth authorization server: the managed Sites gateway provides that integration.

### 3. Initialize and register the isolated VPS worker

Use an isolated Compose/Dokploy project; do not add this service to unrelated applications. Set `YOUTUBE_MCP_ORIGIN` to your Site's HTTPS **origin**, with no `/mcp` path. `.env.example` contains only non-secret examples. Keep the same Compose project name throughout so initialization and deployment use the same named volume.

```sh
export YOUTUBE_MCP_ORIGIN=https://YOUR-SITE
docker compose -p youtube-transcripts -f compose.worker.yaml build worker
docker compose -p youtube-transcripts -f compose.worker.yaml run --rm state-init
docker compose -p youtube-transcripts -f compose.worker.yaml run --rm worker \
  node scripts/private-acquisition-worker.mjs --init
```

Initialization generates a private signing key **inside the worker volume** and prints only its public identity. Register that public key and worker ID in the Site settings above. Optionally set `EXPECTED_WORKER_ID` on the worker to detect a wrong volume/key. Then start it:

```sh
docker compose -p youtube-transcripts -f compose.worker.yaml up -d
docker compose -p youtube-transcripts -f compose.worker.yaml ps
```

For Dokploy, create a dedicated Compose project from this repository, select `compose.worker.yaml`, and set the same origin/public identity variables. Initialize the volume and register its public identity before expecting healthy acquisition. Keep its project/volume identity stable across deployments. No domain, published port, Docker socket, YouTube cookies or MCP/OAuth token is needed by the worker.

The worker is non-root, has a read-only container filesystem, bounded resources and a persistent private state volume. Its health check requires recent successful signed API contact. An authorization/access denial writes a persistent stop latch; it does not loop around a denial. Diagnose and correct the authorized configuration before deliberately clearing a latch. Never use `down -v` on a live instance unless loss of the worker identity/state is explicitly intended.

### 4. Connect ChatGPT web UI

In the account/workspace's Apps/custom-app settings, create/connect the app using your published `/mcp` URL and the **managed OAuth flow**. Scan the actual tools, complete the authorization prompt and verify that all ten tools appear. Refresh the app's tool definitions after backend tool changes. UI names and developer-mode availability change; use the official guides linked above rather than assuming that an API bearer token field exists.

Select or mention your connected app in a new ChatGPT conversation. The app's display name determines the mention, for example `YouTube Transcripts`; this is an MCP app, not a Codex skill installed into ChatGPT. Ask it to use `get_transcripts` on a real video and return the complete cleaned text, title and URL. Pending acquisition needs another call; an HTTP 200 or a green connection indicator is not a transcript success.

### 5. Live acceptance, before removing an old worker

Manually exercise every advertised tool in ChatGPT web UI using real public videos/creators/playlists. Include an uncached video, ten mixed links/IDs, a creator with a custom limit, ordered playlist continuation, available languages, raw/timed pagination, provenance-labelled chapters, range extraction and oversized clean-text continuation. Confirm genuine text—not merely status—and explicit per-video failures.

Repeat successful requests and independently verify reuse of the same stored snapshots without new caption acquisition. Restart the worker and repeat. Keep any existing worker running until uncached retrieval and the complete UI→MCP→worker→UI path pass. Do not bypass a 403, bot/access denial or browser security warning.

## A prompt for your Codex agent

Copy this into an agent with access to your browser, GitHub CLI and deployment tools:

```text
Install https://github.com/jroth1111/chatgpt-web-ui-youtube-transcripts
for my ChatGPT web UI, using ChatGPT Sites for the authenticated MCP/cache
and an isolated Docker/Dokploy VPS acquisition worker.

First read the README and applicable local instructions. Inspect actual
browser tabs, account, Site project, server and running services; reconcile
any existing installation before creating or resending anything. Ask me
which target to use if ambiguous. Preserve unrelated projects and data.

Run isolated synthetic tests and the build. Obtain explicit approval before
generating/registering keys, OAuth/persistent grants, security changes,
payments, public sharing changes or destructive operations. Do not print
secrets, cookies, session storage, private keys or credential-bearing errors.
Use managed Sites storage and the existing VPS; no paid transcript APIs,
proxies, external model calls or denial/security-warning bypasses.

Follow the README setup: configure managed DB/migrations and owner auth,
initialize a persistent worker identity, register only its public key/ID,
publish /mcp, then connect the managed OAuth app in ChatGPT web UI. Keep
the worker isolated, non-root and without inbound ports. Do not remint
credentials or replace an existing worker without explicit authorization.

Manually verify every one of the ten advertised tools in the real ChatGPT
web UI. Test uncached retrieval, ten mixed IDs/share links/URLs, creator
default/custom limit and bounded older-upload fill, actual playlist order,
languages, raw/timed pages, chapter provenance, ranges and full-text overflow
cursors. Verify title, canonical URL and genuine caption text in tool results.
Repeat requests and restart the worker to verify durable snapshot reuse and
no duplicate caption acquisition. Keep existing service until E2E passes.

Report exact deployed URL, observed live evidence, partial results and any
blocker. Do not claim success from source, unit tests, HTTP 200, connection
status or worker reports alone. Leave explicit access denials as failures.
```

## Security and license

Do not commit `.env`, owner identity, private keys, credentials, database/cache contents or deployment receipts. `npm run check:public` checks publication hygiene; run a separate secret scanner such as Gitleaks before sharing. These checks reduce risk; they are not a proof that arbitrary future changes are secret-free.

MIT licensed; see [LICENSE](LICENSE) and [third-party attribution](ATTRIBUTION.md). This is an independent project, not an official OpenAI or YouTube product. Respect upstream terms and access controls.
