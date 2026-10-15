# Changelog

## v1.0.0 (draft)

The first release of open-ancestry: a local-first family tree app. Import your Ancestry.com tree, then browse, search, edit and export it on your own computer. Nothing leaves your machine.

PR numbers point to the change on GitHub.

> **Upgrading a tree is one-way.** Opening a tree upgrades its database to schema version 5: version 4 records merges as person aliases (#219), and version 5 adds sort keys for the people list (#244). An older version of the app refuses a version 5 tree. Before opening a tree you care about, keep a copy of its folder or export it as JSON.

### Import and re-import

- **Import Ancestry GEDCOM and GEDZIP files** from the start page (drag and drop) or with `open-ancestry import`. Ancestry's own tags are understood: record links (`_APID`), MyTreeTags, photos and primary photos, adopted and step relationships, and military events. Nothing is dropped: every line is either mapped or kept as is, so the tree can be exported again. (#22, #30, #43, #44)
- **Import report** with counts, warnings by line number, and the tags that could not be mapped. (#30, #43)
- **Media from a GEDZIP or a media folder** is linked by its relative path. Missing files are reported but keep their path, so an export still names them, and existing files are never overwritten. (#45, #51, #221)
- **Re-import an updated Ancestry export** into an existing tree. People are matched, with a confidence and the reasons for each match, and a review screen lets you accept or reject each change before anything is written. (#72, #184, #192)
- **Dates as they appear in real trees**: `ABT`, `BEF`, `AFT`, `BET … AND`, `FROM … TO`, US-style `05/28/1960`, ISO dates, decades, centuries and year ranges. Text that is not a date is kept as typed. (#21, #52, #66)
- **GEDCOM 7** files, including calendar dates, which are validated. (#64, #142)
- **Accented names stay consistent**: text is normalized to NFC on import and edit, so names, places and media paths match however they were typed. (#164)
- **Imports run in the background** in their own worker, with size limits that can be configured. A GEDZIP is limited by its GEDCOM text, not by its photos, an upload that can't succeed is refused before it is sent, and an import can be cancelled. (#156)
- Writes to a tree are refused while it is importing. (#149)
- **Command line and import polish**: `--help` and clear usage errors, `serve` opens the browser, blank tree names are refused with a plain message, a fuller import report, a size check before upload, and focus moves to the import result so it is announced. (#228)

### Tree views

- **Family tree view**: the focus person with partners, parents and grandparents above, and children below. Generation labels, photos or silhouettes, and life years. Click a card for a quick view; double-click or press Enter to re-center on that person. (#25, #39)
- **Pedigree, descendant and fan views** from the same layout, switchable from the toolbar, keeping the focus person. (#25, #61, #154, #170, #191)
- **Expand and collapse** ancestors, descendants and siblings card by card. Half siblings hang from their shared parent, and cousins keep their parents together. (#31, #53, #73)
- **Pan, zoom, minimap and keyboard navigation**: arrow keys move between related cards. The URL names the focus person, so any view can be bookmarked, and a hand-edited URL falls back to the default view instead of breaking it. (#39, #77, #214)
- **Pedigree collapse** (the same person reached twice) is drawn as a linked duplicate card. (#39)
- **Copied trees are told apart**: a tree folder copied by hand shows its folder name next to the tree name in the switcher, start page and export dialog. (#235)
- **Kinship labels** on tree cards name step, adoptive and foster links, not just birth relationships. (#157)

### Person page

- **Header** with the profile photo, name, birth and death summary, tags, and the relationship to the home person, with its path drawn. (#35, #49)
- **Facts tab** with three columns:
  - **Timeline:** events with year and age, and family events such as siblings' births and parents' deaths.
  - **Sources:** citations, linking back to the Ancestry record.
  - **Relationships:** parents, siblings, and partners with their children.

  (#35)
- **Gallery tab** with thumbnails, a lightbox, and attaching media to the person or an event. Remote Ancestry photos are shown as placeholders and are never downloaded. (#51, #168, #183)
- **Notes, LifeStory and Sources tabs.** (#35)
- **Relationship calculator**: the relationship between any two people ("2nd cousin once removed", "step-mother", "sister-in-law"), with every path when there is more than one. (#37, #176)

### Search and the people list

- **Command palette** (Cmd/Ctrl-K) searches people by name, place and year, with phonetic matching on surnames. It also runs app actions. Results update on each pause in typing. (#40, #59, #180)
- **People list**: every person in the tree, sortable and filterable by tag, living status and sex, and fast even with 100,000 people. (#40, #47)
- **Tree checker**: possible duplicates, impossible dates and people without sources, each linking to the person. (#69)

### Editing

- **Add, edit and delete** people, names, events (with a live preview of how the date is read), notes, tags and relationships. (#48)
- **Relationship fixes**: set or change a partnership's type, and remove a wrong parent, partner or child link. People are never deleted by these. (#165)
- **Merge duplicate people** in one step. Each merge is recorded, so a later re-import still recognizes the person who was merged away. (#70, #219)
- **Undo and redo everything**: Cmd/Ctrl-Z, Shift-Cmd/Ctrl-Z, and a History panel listing recent changes. Each dialog save is one undo step, and history survives app upgrades. (#48, #148)
- **A failed save keeps the dialog open**, with what you typed and the reason, so you can try again. (#177)
- **Edits to someone deleted elsewhere** (in another window, or by undo) get one plain message, no retry that can't work, and land on a close relative. (#240)
- **Delete a person** and their own notes, media and citations go with them, while anything still used by someone else stays. You land on a close relative (or the people list), with an Undo button in the toast. Undo brings you back to the restored person. (#181, #232)
- **Keyboard friendly**: focus returns to whatever opened a dialog, including after a mouse click in Safari, and the History list scrolls from the keyboard. (#59, #171, #208)

### Privacy and export

- **Your data stays on your computer.** Each tree is a folder (a SQLite database plus media) in your library. The app makes no third-party network requests. (#23, #29)
- **Export GEDCOM 5.5.1** (Ancestry compatible, keeping Ancestry's custom tags), **GEDCOM 7**, **GEDZIP** with media, and **JSON** for backup and tools. Original records are re-read by their own GEDCOM version, so nothing is lost when a GEDCOM 7 import is exported as 5.5.1, and a line that should point at a record but holds text is reported, not silently dropped. GEDCOM 7 exports give each media file's format as a MIME type. (#23, #46, #221, #223)
- **JSON exports can leave out edit history**, and do by default from the export dialog, since that history holds anything you deleted. (#220)
- **Privatize living people**, on by default when exporting. Private and confidential records are hidden, and record ids are renumbered so nothing about a hidden person leaks. (#46, #104)
- **Living status** is worked out from dates and can be set by hand. (#21, #48)

### Security

- The server listens on `127.0.0.1` only. Requests are checked by Host and Origin, every change needs a per-session token, and a strict Content Security Policy is sent with no inline scripts. Nothing in the app trips that policy, and every end-to-end test fails if anything does. (#29, #34, #47, #174)
- GEDCOM files are treated as untrusted. Values cannot inject extra GEDCOM lines on export, text that looks like a pointer stays text, coordinates are parsed safely, and control characters are escaped in command-line output. (#26, #150, #166, #179)
- Media is served without path traversal, and uploads have size limits. (#29, #51)

### Performance

Budgets are checked in CI on 10,000-person and 100,000-person synthetic trees. (#38, #63)

| What | Budget on a 10,000-person tree |
| --- | --- |
| Import an Ancestry GEDCOM | under 3 s (#204) |
| Server start to first answer | under 300 ms (#55) |
| First page load | under 1 s, with under 150 KB of JavaScript (#55) |
| Open a person or a part of the tree | under 20 ms on the server |
| Search | under 50 ms (#67) |
| Re-focus the tree view | under 50 ms; under 35 ms at mid zoom (#78) |
| Pan and zoom | 60 fps with 2,000 cards (#63) |

Other speed-ups include faster imports that build indexes once at the end and batch their writes (#204), cached people lists and marriage indexes (#47, #150), a tree view cache that starts over cleanly after an edit (#147), sibling links built in linear time so very large families lay out at once (#218), and stored sort keys so the people list opens sorted by birth or death in a 100,000-person tree without scanning it (#244).

### For contributors

- Property tests for round-trips and undo in the data layer, and fixes for the root causes of flaky tests. (#94, #105, #242)
- `downgradeTree` rewrites a tree as an older schema version, so migration tests run the real migrations. (#229)
