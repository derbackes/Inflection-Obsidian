# Foundry Obsidian Plugin

Obsidian plugin for publishing the current note to Foundry as a pitch, running server-side pitch checks, splitting ready pitches into briefs, and linking notes back to Foundry through a `foundry:` frontmatter block.

## Installation

This plugin is not yet listed in Obsidian's Community Plugins directory, so it must be installed manually (or via BRAT).

### Option A — Manual install

1. Build the plugin (or download the release artifacts):

   ```bash
   npm install
   npm run build
   ```

   This produces `main.js` in the repo root. The other required files (`manifest.json`, `styles.css`) are already present.

2. Locate your Obsidian vault on disk. Inside it, create the plugin folder:

   ```text
   <vault>/.obsidian/plugins/foundry-obsidian-plugin/
   ```

   On macOS, `.obsidian` is hidden — press `Cmd+Shift+.` in Finder to reveal it.

3. Copy these three files into that folder:

   - `manifest.json`
   - `main.js`
   - `styles.css`

4. In Obsidian, open **Settings → Community plugins**.
   - If you see a warning about third-party plugins, click **Turn on community plugins**.
   - Under **Installed plugins**, click the refresh icon, then toggle **Foundry** on.

5. A **Foundry** tab will appear in Settings — see [Configuration](#configuration) below.

### Option B — Install via BRAT (recommended for updates)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs and auto-updates plugins from a GitHub repo.

1. In Obsidian, install and enable the **BRAT** community plugin.
2. Open **Settings → BRAT → Add Beta Plugin**.
3. Enter this repository's URL and confirm.
4. Enable **Foundry** under **Settings → Community plugins**.

## Development

```bash
npm install
npm run dev    # rebuilds on change
npm run build  # production build
```

To iterate against a real vault, symlink the repo into your vault's plugins folder:

```bash
ln -s "$(pwd)" "<vault>/.obsidian/plugins/foundry-obsidian-plugin"
```

Reload Obsidian (or use the **Hot Reload** community plugin) to pick up changes.

## Configuration

Open the Foundry settings tab and set:

- Foundry base URL, defaulting to `https://app.foundry.example`
- Personal API token
- Default tenant, loaded from `GET /api/plugin/v1/me`

Saving validates the token before persisting settings.
