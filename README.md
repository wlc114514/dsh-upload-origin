# dsh-upload-origin

A host-side plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that resolves the **original local absolute path** of a file the user dragged into the conversation.

## Why

When a file is dragged into the web composer, the browser upload surface can send the file bytes and its display name, but it cannot expose the original absolute path to JavaScript. DSH stores the uploaded snapshot under:

```text
<session cwd>/.dsh-uploads/<sessionId>/<sha256-16>-<name>
```

`dsh-upload-origin` runs on the DSH host, scans the session workspace and common user folders, and matches that snapshot against local files by **name + size + sha256**. The resolved original path is then injected into the system prompt for the current agent and is also available through a tool.

## What it does

1. Watches the current session's `.dsh-uploads` directory when a turn is assembled.
2. Keeps only uploads that a human prompt actually referenced.
3. Resolves each referenced upload against local files:
   - first through the official workspace file-reference index (`ctx.fileReferences`);
   - then through a bounded filesystem scan of the session cwd, `Desktop`, `Documents`, `Downloads`, `OneDrive`, and a shallow home scan.
4. Injects a mapping block into the system prompt:

   ```text
   [Uploaded files: original local paths]
   - uploaded: .dsh-uploads/session-.../7538541a1efdc6c6-report.docx
     original: C:\Users\Alice\Desktop\report.docx [exact]
     Prefer this original path when the user refers to their local file; the
     .dsh-uploads copy is a snapshot.
   ```

5. Registers the `resolve_uploaded_file` tool for on-demand lookup.

## Install

Publish source install:

```sh
dsh plugin --profile web add dsh-upload-origin
```

Or install a published tarball directly.

The package declares `dsh.bundle`, so it installs through the normal DSH bundle/profile flow.

## Tool: `resolve_uploaded_file`

Arguments:

| Argument | Type | Description |
|---|---|---|
| `file_path` | string, optional | Uploaded path, absolute or relative to the session workspace. |
| `name` | string, optional | Original file name to locate when no uploaded path is known. |
| `search_roots` | string[], optional | Extra absolute directories to scan. |
| `max_results` | integer, optional | Maximum candidates to return (1-20, default 10). |

The result contains the uploaded path, the original name, size, sha256, the best original path, confidence, candidates, scanned roots, and scan metadata.

Confidence values:

| Confidence | Meaning |
|---|---|
| `exact` | Name, size, and sha256 all match. |
| `name+size` | Name and size match; sha256 was not checked or differs. |
| `name+size-hash-differs` | Name and size match, but content has changed since upload. |
| `name-only-size-differs` | Same name, different size. |
| `name-only` | Same name only. Verify manually. |

## Configuration

The plugin accepts these optional config fields in a bundle patch row:

```yaml
- id: upload-origin
  name: 'dsh-upload-origin'
  config:
    maxSearchFiles: 250000
    searchTimeoutMs: 9000
    maxDepth: 12
    maxHashChecks: 30
    maxResults: 10
    recentUploadMs: 604800000
    maxRecentUploads: 8
    autoResolveTimeoutMs: 7000
```

| Field | Default | Description |
|---|---|---|
| `maxSearchFiles` | `250000` | Maximum filesystem entries visited per resolution. |
| `searchTimeoutMs` | `9000` | Overall search deadline per resolution. |
| `maxDepth` | `12` | Directory depth for common roots. |
| `maxHashChecks` | `30` | Maximum candidate files whose content is hashed. |
| `maxResults` | `10` | Maximum candidates returned by the tool. |
| `recentUploadMs` | `604800000` | Only uploads newer than this are auto-resolved (7 days). |
| `maxRecentUploads` | `8` | Maximum recent uploads considered per prompt assembly. |
| `autoResolveTimeoutMs` | `7000` | Maximum wait for automatic prompt mapping per turn. |

## Limitations

- Browsers do not expose the original absolute path during drag-and-drop. This plugin recovers it by matching the uploaded snapshot on the host.
- If the original file was modified after upload, the sha256 will differ; the plugin falls back to name + size or name-only candidates.
- Files outside the default roots are not found automatically. Pass `search_roots` to the tool or configure additional roots in a future version.
- The uploaded copy remains the durable source of truth for reading; the original path is used when the user wants to edit their local file.

## Security

- Host-side only. No network calls.
- No credentials are read, stored, or transmitted.
- The plugin reads only local files whose names match the uploaded snapshot; content hashes are computed locally to confirm the match.
- The `resolve_uploaded_file` tool is read-only.

## License

MIT
