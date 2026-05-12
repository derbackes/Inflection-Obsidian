# Foundry Obsidian Plugin

Obsidian plugin for publishing the current note to Foundry as a pitch, running server-side pitch checks, splitting ready pitches into briefs, and linking notes back to Foundry through a `foundry:` frontmatter block.

## Development

```bash
npm install
npm run build
```

## Manual install

Copy `manifest.json`, `main.js`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/foundry-obsidian-plugin/
```

Enable the plugin from Obsidian's Community plugins settings.

## Configuration

Open the Foundry settings tab and set:

- Foundry base URL, defaulting to `https://app.foundry.example`
- Personal API token
- Default tenant, loaded from `GET /api/plugin/v1/me`

Saving validates the token before persisting settings.
