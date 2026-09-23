# Tools

Command-line checks that the viewer can also run from its Tools tab.

Each tool is a script plus a `<name>.tool.json` manifest beside it. The server
reads every manifest at request time, so adding a tool is: drop in the script,
drop in the manifest, reload the page. No server or UI change.

## Manifest

```json
{
  "id": "unique-id",
  "name": "Shown in the tool list",
  "description": "One line, shown under the name",
  "target": "dataset", // "dataset" or "mcap": what the tool is pointed at
  "script": "my_tool.py", // resolved next to the manifest
  "jsonFlag": "--json", // optional: added when present, so output renders as a table
  "options": [
    // optional: rendered as a small form
    {
      "flag": "--limit",
      "label": "Episodes to sample",
      "type": "number",
      "default": 5
    },
    {
      "flag": "--fast",
      "label": "Skip the slow pass",
      "type": "boolean",
      "default": false
    }
  ]
}
```

The script is invoked as `python3 <script> <target path> [options] [jsonFlag]`.
The target path is resolved by the server inside a configured root; a tool never
receives a path from the browser.

Write to stdout. JSON is rendered as a table when it is a list of objects or an
object of scalars, and pretty-printed otherwise; anything else is shown as text.
Exit non-zero to mark the run as failed.

## The tools here

| Tool                     | Target  | What it reports                                                                                                                                                                                                                                                        |
| ------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate_lerobot_v3.py` | dataset | Required files and metadata keys, count agreement across info.json / episode table / data rows / video frames, contiguous episode indices and uniform k/fps timestamps, and the image-to-state lag in frames measured by correlating image motion with joint velocity. |
| `mcap_analyze.py`        | mcap    | Per-channel message counts, span, mean rate and jitter, plus a dataset-level rate spread when pointed at a directory. Messages are counted, never decoded.                                                                                                             |

Both also run standalone: `python3 tools/validate_lerobot_v3.py <dataset_root>`.
