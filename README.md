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
git clone https://github.com/YOUR_USERNAME/chatgpt-web-ui-youtube-transcripts.git
cd chatgpt-web-ui-youtube-transcripts
npm ci
npm test
npm run check:public
npm run build
```

The unit tests use synthetic data and local SQLite. They do not prove that your network can retrieve live YouTube captions. The authenticated root page is a status shell, not a transcript viewer.

### 2. Set up the Sites backend

**Deployment happens through ChatGPT's Sites workflow—not `git push`, `npm run build`, or Docker.** Those commands prepare/check the source; Docker hosts only the acquisition worker. This repository does not ship a standalone Sites deployment CLI or assume a GitHub-import button exists.

#### A. Create the Site from this repository

1. Open **Work** in ChatGPT web, or Work/Codex in the ChatGPT desktop app. Start a conversation and mention **`@Sites`** (or explicitly ask to build a website). For an existing Site, open **Sites** in the sidebar and choose its edit action instead—do not accidentally create a replacement.
2. Give that Sites-capable task the public repository URL and this setup prompt. If it cannot retrieve GitHub source, attach a source-only archive of the repository, excluding local dependencies, runtime data and secrets.

```text
@Sites Create a new private website named YouTube Transcripts using the
actual source from https://github.com/YOUR_USERNAME/chatgpt-web-ui-youtube-transcripts.
Do not recreate a look-alike from the README. Read the installation guide.
Use Sites-managed D1 bound as DB, apply the supplied drizzle migrations,
and expose the existing ten MCP tools at /mcp. Preserve managed Sites
authentication and enable the mcp capability in .openai/hosting.json.
Do not deploy the Docker acquisition worker inside Sites.
Save a version and show the preview, required setting names and any blocker.
Do not invent a project ID, publish publicly, print secrets, or claim live
caption retrieval before the separate signed worker and plugin are tested.
Ask before credentials/security grants; wait for my review before publishing.
```

3. Review its saved version and preview. Require confirmation that it used this source, retained `app/mcp/route.ts` and both acquisition routes, provisioned `DB`, and applied the migrations. Let Sites assign the project ID; do not copy another deployment's identity. A preview alone does not verify backend storage or MCP configuration.

The creation/editing entry points are documented in [Creating and using Sites](https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites). Missing Work/Sites or a denied permission is an account/admin/rollout blocker, not something `npm` can install.

#### B. Enter hosted settings privately

As the **Site owner**, open **Sites → your Site → More actions → Settings** and add the hosted environment values/secrets below. Enter secret values there, **not in the chat prompt, source files, `.openai/hosting.json`, or GitHub**. After settings change, have the Sites task redeploy the approved saved version. See the [Sites developer guide](https://developers.openai.com/codex/sites) for this settings/redeployment flow.

| Setting | Value / purpose |
|---|---|
| `OWNER_EMAIL` | Your authorized owner identity |
| `MCP_AUTH_KEY` | A securely generated service token of at least 32 characters |
| `ACQUISITION_MODE` | `private_mac` — a legacy selector name; the worker runs on Linux/VPS too |
| `ACQUISITION_PUBLIC_KEY` | Public Ed25519 key from worker initialization below |
| `ACQUISITION_CLAIM_WORKER_ID` | The matching public worker ID, to pin job claims |

The worker public key/ID come from step 3, so deployment is intentionally staged: configure owner/service auth and `ACQUISITION_MODE` first; publish to obtain the origin; initialize (but do not start) the worker; add its public key/ID in Site settings; then redeploy before starting it. Until registration is complete, acquisition is not ready. Do not temporarily disable authentication to get around this ordering.

#### C. Publish the approved version and capture its URL

Open the reviewed Site's **Share** controls, confirm the intended audience, and select **Publish** as the owner. Keep the audience limited unless wider access was separately approved. Once live, use **Visit** or **Copy link** to record the actual HTTPS origin. Append `/mcp` for the MCP endpoint; never use the preview URL or a guessed hostname. Owner publication is also required to create the initial associated plugin. Publishing updates a production URL, so review the saved version first. [Publishing steps](https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites), [Site-hosted plugin lifecycle](https://help.openai.com/en/articles/20001547-hosting-a-plugin-with-chatgpt-sites).

Ask the Sites task to confirm the published version, migrations, environment setting **names only**, and MCP `initialize`/`tools/list` results. A bare browser GET to `/mcp` is not an MCP handshake; a 401 without authentication can be expected. A successful build is not proof of a published or configured service.

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

Initialization generates a private signing key **inside the worker volume** and prints only its public identity. Register that public key and worker ID in the Site settings above, then have the Sites task **redeploy the approved saved version with those settings**. Confirm that registration is active before starting the worker; otherwise an auth denial may latch it stopped. Optionally set `EXPECTED_WORKER_ID` on the worker to detect a wrong volume/key. Then start it:

```sh
docker compose -p youtube-transcripts -f compose.worker.yaml up -d
docker compose -p youtube-transcripts -f compose.worker.yaml ps
```

For Dokploy, create a dedicated Compose project from this repository, select `compose.worker.yaml`, and set the same origin/public identity variables. Initialize the volume and register its public identity before expecting healthy acquisition. Keep its project/volume identity stable across deployments. No domain, published port, Docker socket, YouTube cookies or MCP/OAuth token is needed by the worker.

The worker is non-root, has a read-only container filesystem, bounded resources and a persistent private state volume. Its health check requires recent successful signed API contact. An authorization/access denial writes a persistent stop latch; it does not loop around a denial. Diagnose and correct the authorized configuration before deliberately clearing a latch. Never use `down -v` on a live instance unless loss of the worker identity/state is explicitly intended.

### 4. Connect ChatGPT web UI

**Use the Site-generated plugin first; manually creating a generic custom MCP app is not the default installation path.** After the owner publishes the MCP-enabled Site, the Sites task should display its associated plugin card:

1. Select **Install** on that card, then finish the managed connection/authorization flow.
2. To find your created plugin later, open **Plugins → Personal → Created by you**. If it is disconnected, select **Connect** and complete the unfinished authorization.
3. Inspect its tools: all ten names in the table above should appear. Publish Site changes before expecting changed tools, then verify the plugin's current tool list.
4. Mention/select that installed plugin in a new chat and invoke a real transcript tool.

If no card appears, ask the **same Sites task** to verify that the owner published the MCP-enabled version and to surface its associated plugin. Do not create duplicate plugins or substitute a guessed URL. Workspace roles may need plugin-use, upload and MCP-creation permissions. See [OpenAI's Site-hosted plugin installation and troubleshooting guide](https://help.openai.com/en/articles/20001547-hosting-a-plugin-with-chatgpt-sites).

Only if your account instead exposes the generic Apps/custom-MCP flow, use its actual endpoint/authentication controls and the managed OAuth integration supported by that deployment. Do not assume an API bearer-token field or invent OAuth endpoints. Installing a plugin and sharing a Site are separate operations; neither substitutes for authorization.

Select or mention your connected app in a new ChatGPT conversation. The app's display name determines the mention, for example `YouTube Transcripts`; this is an MCP app, not a Codex skill installed into ChatGPT. Ask it to use `get_transcripts` on a real video and return the complete cleaned text, title and URL. Pending acquisition needs another call; an HTTP 200 or a green connection indicator is not a transcript success.

### 5. Live acceptance, before removing an old worker

Manually exercise every advertised tool in ChatGPT web UI using real public videos/creators/playlists. Include an uncached video, ten mixed links/IDs, a creator with a custom limit, ordered playlist continuation, available languages, raw/timed pagination, provenance-labelled chapters, range extraction and oversized clean-text continuation. Confirm genuine text—not merely status—and explicit per-video failures.

Repeat successful requests and independently verify reuse of the same stored snapshots without new caption acquisition. Restart the worker and repeat. Keep any existing worker running until uncached retrieval and the complete UI→MCP→worker→UI path pass. Do not bypass a 403, bot/access denial or browser security warning.

## A prompt for your Codex agent

Copy this into an agent with access to your browser, GitHub CLI and deployment tools:

```text
Install https://github.com/YOUR_USERNAME/chatgpt-web-ui-youtube-transcripts
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
