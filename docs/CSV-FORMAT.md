# Events CSV format

Upload in the dashboard: **Events → Upload events CSV**. A sample file is
downloadable from that tab.

```csv
date,time,tv,name,message,duration,theme,media
2026-08-13,10:30,Room 1,Aiden,,5,superhero,
2026-08-13,11:00,Room 2,Maya,Happy 8th Birthday Maya!,5,,Licensed Party Video
2026-08-13,1:30 PM,Room 1,Liam,,5,ninja,
2026-08-13,15:00,Room 3,Sofia,,10,princess,
```

| Column | Required | Format | Notes |
|---|---|---|---|
| `date` | yes | `2026-08-13` or `8/13/2026` | The party's date (server's local timezone). |
| `time` | yes | `14:30` or `2:30 PM` | Start time. The takeover begins at this moment. |
| `tv` | yes | text | Must match a TV's name in the dashboard. Capitalization, spaces and punctuation don't matter: `room1`, `Room 1`, `ROOM-1` all match a TV named "Room 1" — but the words must be the same (`Room 13` will NOT quietly match `Room 1`). Unmatched rows are flagged at import, not silently dropped or guessed. |
| `name` | yes | text | Shown on screen: "Happy Birthday, *Name*!" |
| `message` | no | text | Replaces the default headline entirely (e.g. "Happy 8th Birthday Maya!"). |
| `duration` | no | minutes | How long the takeover lasts. Default **5**. |
| `theme` | no | `party`, `superhero`, `princess`, `space`, `ninja`, or the name of any custom theme you built in the dashboard's **Themes** tab | Which animated birthday screen to use. Blank = `party`. Synonyms work for the built-ins (`hero`, `galaxy`, `royal`, …); unknown values are flagged and fall back to `party`. |
| `media` | no | media label | A media label from your library to play full-screen as the background (e.g. licensed character content you have rights to). Takes priority over `theme`. Blank = the theme's animated screen. |

Header aliases are accepted (`room` for `tv`, `start` for `time`,
`minutes` for `duration`, `video` for `media`). Column order doesn't matter.
Extra columns are ignored — so an export from your booking system with more
columns works as long as the required four exist.

**Re-uploading replaces the *pending* events for the dates in the file** —
already-played and currently active ones are kept as history, and events on
other dates (e.g. tonight's parties when you pre-load tomorrow's CSV) are
untouched. A file with no valid rows changes nothing at all. So the workflow
"fix the CSV, upload again" is always safe.

## Temporary test-bookings format (Parties page)

The Parties page imports raw *booking exports* — deliberately without name
or theme columns, because the server parses the kid's name and age out of
the booking text ("byline") exactly as it will from live ROLLER data:

    date,time,room,byline,duration
    2026-09-13,13:00,Room 1,Nathan's 10th birthday party,5

Parsed name/age are pre-filled and always editable in the Parties table;
rows the parser wasn't sure about carry a ⚠ check chip. This import (and
this section) is temporary — it is removed once the ROLLER connection is
live. The classic format above still works against `POST /api/events/csv`
for scripted use.
