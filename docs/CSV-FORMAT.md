# Events CSV format

Upload in the dashboard: **Events → Upload events CSV**. A sample file is
downloadable from that tab.

```csv
date,time,tv,name,message,duration,media
2026-08-13,10:30,Room 1,Aiden,,5,
2026-08-13,11:00,Room 2,Maya,Happy 8th Birthday Maya!,5,Birthday Loop
2026-08-13,1:30 PM,Room 1,Liam,,5,
2026-08-13,15:00,Room 3,Sofia,,10,
```

| Column | Required | Format | Notes |
|---|---|---|---|
| `date` | yes | `2026-08-13` or `8/13/2026` | The party's date (server's local timezone). |
| `time` | yes | `14:30` or `2:30 PM` | Start time. The takeover begins at this moment. |
| `tv` | yes | text | Must match a TV's name in the dashboard. Forgiving: `room1`, `Room 1`, `TV Room 1` all match a TV named "Room 1". Unmatched rows are flagged at import, not silently dropped. |
| `name` | yes | text | Shown on screen: "Happy Birthday, *Name*!" |
| `message` | no | text | Replaces the default headline entirely (e.g. "Happy 8th Birthday Maya!"). |
| `duration` | no | minutes | How long the takeover lasts. Default **5**. |
| `media` | no | media label | A media label from your library to play as the background. Blank = the library's **Set as birthday** video, or the built-in animated screen if none is set. |

Header aliases are accepted (`room` for `tv`, `start` for `time`,
`minutes` for `duration`, `video` for `media`). Column order doesn't matter.
Extra columns are ignored — so an export from your booking system with more
columns works as long as the required four exist.

**Re-uploading replaces all *pending* events** (already-played and currently
active ones are kept as history). So the workflow "fix the CSV, upload again"
is always safe.
