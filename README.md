# Fetcherr

Fetcherr gives Infuse and VidHub a Stremio-like streaming experience using your Trakt or MDBList library sources and a supported debrid provider, without needing a traditional media server or local mount.

It acts as a lightweight bridge between list sources, debrid providers, stream provider addons, and Jellyfin-compatible clients like Infuse and VidHub. Fetcherr builds a client-ready library from your optional Trakt watchlists, selected Trakt lists, and MDBList list URLs, watches for new episodes and movies as they become available, and exposes them through a Jellyfin-compatible interface.

The goal is simple: open Infuse, browse your library, and press play. Fetcherr handles stream discovery, prefers cached debrid results, and automatically picks the best match instead of making you choose from a stream list every time.

## Responsible Use

The developer of Fetcherr does not condone, encourage, or support using Fetcherr with illegally acquired content. Fetcherr should only be used with media you own, have lawfully obtained, or are otherwise authorized to access.

## What It Does

- Syncs movies and shows from optional Trakt watchlists, selected Trakt lists, and MDBList list URLs
- Exposes a Jellyfin-style library for Infuse and VidHub
- Resolves playback through direct providers such as Torrentio and Debridio
- Supports Real-Debrid or TorBox as the active debrid provider
- Verifies ambiguous audio with `ffprobe` when needed

## How It Differs

- Unlike Stremio and Stremio-style addons, Fetcherr is built around Jellyfin-compatible clients such as Infuse and VidHub.
- Unlike WebDAV, `rclone`, or mounted-library workflows, it does not rely on local mounts or Infuse scraping metadata on its own.
- Unlike traditional media servers, it does not require you to maintain a local media collection.
- To keep your debrid library cleaner, Fetcherr resolves cached links for playback and removes the associated torrent hash afterward.

## Requirements

- Docker
- A TMDB API key
- A Real-Debrid API key or TorBox API key
- Optional: TVDB API key for episode-image fallback
- Optional: Trakt client ID and secret

## Debrid Providers

Fetcherr supports one active debrid provider at a time: Real-Debrid or TorBox. Configure the provider in Settings under `Debrid`.

Real-Debrid and TorBox do not behave identically:

- Real-Debrid playback can usually redirect clients directly to a resolved debrid URL.
- TorBox playback is proxied through Fetcherr so Fetcherr can present media-player-friendly response headers, including byte-range behavior expected by Infuse and VidHub.
- TorBox support has currently been tested with TorBox's official Stremio add-on. Other provider add-ons may work if they return usable torrent hashes or compatible TorBox-backed stream results, but they have not been validated as thoroughly.
- If you want to support continued Fetcherr development while switching to TorBox, consider using my referral link: [TorBox referral](https://torbox.app/subscription?referral=517608ee-35cb-458f-be00-850a2543a4f0)

Because the providers differ, Fetcherr intentionally encourages choosing one provider instead of configuring both at the same time.

## Container Image

GitHub Actions builds and publishes a container image to GitHub Container Registry on pushes to `main`, version tags, and manual runs.

Use:

```text
ghcr.io/goneturbo/fetcherr:latest
```

## Docker Compose

1. Create a `docker-compose.yml`:

```yaml
services:
  fetcherr:
    image: ghcr.io/goneturbo/fetcherr:latest
    container_name: fetcherr
    restart: unless-stopped
    ports:
      - "9990:9990"
    environment:
      PORT: "9990"
      DATABASE_PATH: /app/data/fetcherr.db
      SERVER_NAME: "${SERVER_NAME:-Fetcherr}"
      SERVER_ID: "${SERVER_ID:-fetcherr-001}"
      SERVER_URL: "${SERVER_URL:-http://localhost:9990}"
    volumes:
      - ./data:/app/data
```

2. Start the container:

```bash
docker compose up -d
```

3. Open:

```text
http://YOUR_SERVER:9990/ui/setup-admin
```

4. Create the first admin account.
5. Open Settings and enter your API keys, provider URLs, and any Trakt settings you want to use.

## Kubernetes

1. Open [`deploy/kubernetes/fetcherr.yaml`](deploy/kubernetes/fetcherr.yaml).
2. Set `SERVER_URL`.
3. Apply the manifest:

```bash
kubectl apply -f deploy/kubernetes/fetcherr.yaml
```

## Usage

- Complete first-run setup in `/ui/setup-admin`
- Configure providers and preferences in `/ui/settings`
- Add Fetcherr to Infuse or VidHub as a Jellyfin server
- Browse and play from your client of choice
- Use `/ui/logs` when sync or playback fails

## Environment

Most runtime configuration should be entered in the web UI and is stored in Fetcherr's database. `.env` is intentionally minimal and is mainly used for startup values.

| Variable | Required | Description |
| --- | --- | --- |
| `SERVER_URL` | Yes | External base URL used for playback redirects |
| `MDBLIST_MAX_ITEMS` | No | Advanced fallback: maximum MDBList items to import per list. Defaults to `1000`. |

## Tips

> [!TIP]
> Provider order matters. Earlier providers are tried first.

> [!IMPORTANT]
> Stream addons should return stream URLs containing a usable torrent hash. Fetcherr extracts that hash and resolves playback through the selected debrid provider. Proxy-only addon URLs that hide the hash are not compatible with the normal torrent-hash resolver path.

> [!NOTE]
> TorBox support has been tested with the official TorBox Stremio add-on. TorBox uses Fetcherr-proxied playback, while Real-Debrid generally uses direct redirects to resolved playback URLs.

> [!IMPORTANT]
> `ENGLISH_STREAM_MODE=require` is the strictest option for English audio. It allows explicit English metadata or ffprobe-confirmed English audio on probeable files.

> [!NOTE]
> Most runtime configuration now lives in the web UI and is stored in Fetcherr's database. `.env` is intentionally minimal.

> [!WARNING]
> Debrid provider account limits, IP rules, and subscription restrictions still apply.

## Current Limitations

- Anime has not been validated thoroughly yet
- Some metadata may still be enriched by Infuse itself
- `Logo` image behavior may vary by client
- VidHub support has been validated against the Jellyfin-compatible `/emby` API surface, but some client-specific edge cases may still surface
- Trakt Smart Lists are not currently supported because Trakt's public lists API does not expose them

## FAQ

### Does Fetcherr follow my Stremio add-on settings, or does it choose streams on its own?

Both.

Your add-on settings still matter because they control which streams each provider returns. Fetcherr then ranks those returned streams using its own playback criteria, such as debrid cache availability, language preference, match quality, and format compatibility.

If you configure multiple provider URLs, Fetcherr also respects their order. Earlier providers are tried first, and Fetcherr then picks the best candidate within that provider's results before moving on to the next one.

### How does TorBox differ from Real-Debrid in Fetcherr?

Real-Debrid and TorBox both resolve cached torrent-backed streams, but their playback URLs behave differently for media clients.

With Real-Debrid, Fetcherr generally redirects the client to the resolved RD playback URL. With TorBox, Fetcherr proxies the TorBox CDN response through your Fetcherr server so clients see the range and media headers they expect for reliable playback and seeking.

TorBox support has only been tested with TorBox's official Stremio add-on so far. For best results while testing TorBox, use that add-on and keep TorBox as the active provider in Settings.

### How does the English Audio setting work?

Fetcherr has three English-audio modes:

- `Off`: ignores English-language markers during ranking and does not run language checks.
- `Prefer English when available`: uses English markers from provider metadata, filenames, or indexer flags as a late tie-breaker. Fetcherr does not run ffprobe in this mode, so higher-quality neutral releases can still win.
- `Require English audio`: skips streams that clearly indicate non-English audio, accepts streams that clearly indicate English audio, and uses ffprobe to verify neutral probeable files such as MKV releases after the selected debrid provider resolves them.

Remote MP4/M4V files are treated more conservatively in `Require English audio` because they are less reliable to probe before playback. In those cases, Fetcherr still needs clear English metadata.

### How do I connect Infuse?

Add Fetcherr as a Jellyfin server in Infuse using your Fetcherr server URL and a Fetcherr user account. Use the same base URL you open in the browser, for example:

```text
http://YOUR_SERVER:9990
```

When connecting Infuse to Fetcherr, use:

- `Library Mode`: on
- `Auto Scan`: on
- `Install InfuseSync Plugin`: on

Those settings let Infuse treat Fetcherr like a library source and keep its local view updated as Fetcherr syncs lists and availability.

### How do I connect VidHub?

Add Fetcherr as a Jellyfin-compatible server in VidHub using your Fetcherr server URL and a Fetcherr user account.

If VidHub asks for a server type, choose Jellyfin when available. If it expects an Emby-compatible endpoint, use the same server with the `/emby` prefix:

```text
http://YOUR_SERVER:9990/emby
```

After connecting, trigger a library scan in VidHub if the library does not appear immediately.
