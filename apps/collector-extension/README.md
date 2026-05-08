# WeWe RSS Content Collector Extension

Chrome/Edge MV3 extension for collecting WeChat article content from the user's local browser and submitting it to WeWe RSS.

## What It Does

- Polls the WeWe RSS server for one pending content collection job.
- Opens the WeChat article in a non-active tab.
- Extracts title, author, text content, and HTML from `#js_content`.
- Submits the content back to the server.
- Closes the tab and waits 1-5 seconds before opening the next article.
- If WeChat shows a verification page, switches the tab to the foreground for manual verification. After article content is available, it switches back to the previously active tab.

## Server API Contract

The extension expects these tRPC mutations:

- `rag.claimContentJob`
- `rag.submitArticleContent`
- `rag.failContentJob`

All requests send the configured auth code in the `Authorization` header.

## Local Installation

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Click "Load unpacked".
4. Select this directory:

```text
apps/collector-extension
```

## Build Zip

From the repository root:

```bash
node apps/collector-extension/build.js
```

The zip file will be written to:

```text
dist/wewe-rss-content-collector.zip
```

## Configuration

- Server URL: WeWe RSS server address, for example `http://your-server:4000`.
- Auth Code: backend authorization code.
- Collector ID: generated automatically, can be changed manually.
- Interval: 1-5 seconds between article tabs.

## Notes

This extension does not bypass WeChat verification. It only uses the user's real local browser environment. If verification is required, the article tab is brought to the foreground so the user can complete it.
