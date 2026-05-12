# Foundry Plugin — User Guide

This guide covers day-to-day use of the Foundry Obsidian plugin. For install and dev setup, see [README.md](./README.md).

## First-time setup

1. Open **Settings → Foundry**.
2. Fill in **Foundry base URL** (e.g. `https://app.foundry.example`) and your personal **API token** from Foundry → Settings.
3. Click **Save**. The plugin calls `GET /api/plugin/v1/me` to validate the token and load the list of tenants you belong to.
4. If you belong to more than one tenant, pick a **Default tenant** from the dropdown. This is the tenant pre-selected when you publish.

If the token is rejected, you'll see "Token rejected by Foundry." inline under the form. The base URL and token are only persisted on a successful validation.

## Concepts

- **Pitch** — the Foundry-side record created from your note. A note becomes "linked" to a pitch once published.
- **Linked note** — a note that has a `foundry:` block in its YAML frontmatter. The plugin uses this to know which pitch a note maps to.
- **Tenant** — the Foundry workspace the pitch belongs to. Required at publish time.
- **Brief** — a sub-document split out of a ready pitch.

## Workflows

### 1. Publish a note as a pitch

Use **Command palette → "Publish current note to Foundry as pitch"** while a Markdown note is open.

What happens:

1. The plugin checks the note has no existing `foundry.pitchId` (otherwise it refuses — re-publishing existing pitches isn't supported yet).
2. A tenant picker appears. Your default tenant is at the top; type to filter.
3. The note's title is taken from the first `#` heading, falling back to the filename. The body is sent as Markdown, with any existing `foundry:` frontmatter block stripped before upload.
4. On success, the plugin writes a `foundry:` block into the note's frontmatter and shows "Published current note to Foundry."

The resulting frontmatter looks like:

```yaml
---
foundry:
  pitchId: pit_abc123
  tenantId: ten_xyz
  publishedAt: "2026-05-12T18:32:11.000Z"
---
```

Do not edit these fields by hand — the plugin uses them to identify the pitch.

### 2. Run Foundry checks

With a linked note open, run **"Run Foundry checks"** from the palette. The command is hidden when the active note isn't linked.

The plugin calls `POST /pitches/:id/lint` and opens a **Foundry checks** pane in the right sidebar with a table of:

- **Check** — the rule's label
- **Severity** — `pass`, or the rule's severity badge (`info`, `warning`, `error`, etc.) when failed
- **Message** — the rule's result message
- **Hint** — remediation guidance (only shown on failure)

A summary line at the top reads `N passed · M failed`. Re-running the command refreshes the same pane.

### 3. Split a ready pitch into briefs

With a linked note open, run **"Split pitch into briefs"**.

Preconditions:

- The pitch's server-side status must be `ready`. If not, you'll see "This pitch is not ready for splitting yet."
- If the server responds `501 splitting-not-available`, you'll see "Splitting isn't available yet - try again later" — Foundry hasn't enabled this feature for the tenant.

On success:

- A modal lists the new briefs. Picking one opens it in your browser (either the brief's own URL or `<base>/pitches/:pitchId/briefs/:briefId`).
- The note's `foundry:` frontmatter gains a `briefs` array recording each new brief's id and title:

```yaml
---
foundry:
  pitchId: pit_abc123
  tenantId: ten_xyz
  publishedAt: "2026-05-12T18:32:11.000Z"
  briefs:
    - id: br_001
      title: Brief one
    - id: br_002
      title: Brief two
---
```

## Status bar

When a linked note is active and the API token is set, the status bar shows `Foundry: <status>` (e.g. `Foundry: ready`, `Foundry: draft`). Clicking it opens the pitch in Foundry's web app.

- The text reads `Foundry: ...` while loading and `Foundry: unavailable` if the status request fails.
- The status bar hides when the active note isn't linked or no token is configured.
- Status updates on tab switch and when the active note's frontmatter changes.

## Command reference

| Command | When available | Effect |
| --- | --- | --- |
| Publish current note to Foundry as pitch | Any open Markdown note | Creates a new pitch, writes `foundry:` frontmatter |
| Run Foundry checks | Active note is linked | Runs server-side lint, opens checks pane |
| Split pitch into briefs | Active note is linked | Splits a `ready` pitch, opens briefs picker, records brief ids |

All commands also respect the **Foundry base URL** and **API token** being set — if either is missing, you'll get "Configure Foundry base URL and API token first."

## Troubleshooting

| Notice | Meaning / next step |
| --- | --- |
| Open a Markdown note first. | The active leaf isn't a Markdown view — focus a note and re-run. |
| This note is already linked. Use the future Update command to push edits. | Note has a `foundry.pitchId` — re-publishing is not supported yet. Remove the `foundry:` block manually if you really want a fresh pitch. |
| This note is not linked to a Foundry pitch. | Run Publish first, or open a note that has a `foundry:` block. |
| Configure Foundry base URL and API token first. | Open Settings → Foundry and save credentials. |
| Save Foundry settings to load tenants before publishing. | Click Save in settings to fetch the tenant list. |
| This pitch is not ready for splitting yet. | The pitch's server-side status is not `ready`. Move it forward in Foundry, then retry. |
| Splitting isn't available yet - try again later | Foundry returned 501 — the feature isn't enabled for this tenant. |
| Token rejected by Foundry. | The API token is invalid or expired. Re-issue one in Foundry settings. |
| Publish failed / Foundry checks failed / Pitch splitting failed: \<message\> | The Foundry API returned a non-2xx response. The message is the server's `message`/`error_description` field — check tenant permissions and pitch state. |

If a status request silently fails, the status bar shows `Foundry: unavailable`. Inspect the developer console (`Ctrl/Cmd+Shift+I`) for the raw error.

## Privacy note

Note content is sent to the Foundry base URL you configure, authenticated with your personal API token. The plugin makes no other outbound calls.
