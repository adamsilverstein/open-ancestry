# Changelog

## v1.0.0 (draft)

The first release of open-ancestry: a local-first family tree app. Import your Ancestry.com tree, then browse, search, edit and export it on your own computer. The app sends nothing anywhere; what you export is up to you, and exports leave living people's details out by default (see [Privacy and export](#privacy-and-export)).

open-ancestry is for one person per computer account. Don't run it on a shared or multi-user machine (see [Security](#security)).

PR numbers point to the change on GitHub.

> **Upgrading a tree is one-way.** Opening a tree upgrades its database to schema version 5: version 4 records merges as person aliases (#219), and version 5 adds sort keys for the people list (#244). An older version of the app refuses a version 5 tree. Before opening a tree you care about, keep a copy of its folder or export it as JSON.

### Import and re-import

- **Import Ancestry GEDCOM and GEDZIP files** from the start page (drag and drop) or with `open-ancestry import`. Ancestry's own tags are understood: record links (`_APID`), MyTreeTags, photos and primary photos, adopted and step relationships, and military events. Nothing is dropped: every line is either mapped or kept as is, so the tree can be exported again. (#22, #30, #43, #44)
- **Import report** with counts, warnings by line number, and the tags that could not be mapped. (#30, #43)
- **Media from a GEDZIP or a media folder** is linked by its relative path. Missing files are reported but keep their path, so an export still names them, and existing files are never overwritten. (#45, #51, #221)
- **Re-import an updated Ancestry export** into an existing tree. People are matched, with a confidence and the reasons for each match, and look-alikes are found by their other names too. A review screen, grouped by what needs a decision, lets you accept or reject each change before anything is written. (#72, #194, #234)
  - It compares three ways, so what you changed since the last import is kept apart from what Ancestry changed: your edits aren't offered again, values an earlier re-import brought in aren't mistaken for your edits, and a place you renamed stays renamed. (#224, #259)
  - New photos in an updated GEDZIP or media folder are copied in, the same photo under another name isn't added twice, and a photo whose file changed is offered as a choice between yours and Ancestry's. (#243, #252)
  - After applying, a summary lists what changed for each person, with links. Undo closes its notice and marks the summary as undone. (#239)
  - The comparison runs in the background, so the app stays responsive while a large tree is compared. (#246)
  - By design, people missing from the new export are listed but never removed: re-import adds and updates, it doesn't sync deletions. And a fact you deleted comes back as an addition if Ancestry changed both its date and its place, since nothing ties the two versions together.
- **Dates as they appear in real trees**: `ABT`, `BEF`, `AFT`, `BET … AND`, `FROM … TO`, US-style `05/28/1960`, ISO dates, decades, centuries and year ranges. Text that is not a date is kept as typed. (#21, #52, #66)
- **GEDCOM 7** files, including calendar dates, which are validated. (#64, #142)
- **Accented names stay consistent**: text is normalized to NFC on import and edit, so names, places and media paths match however they were typed. (#164)
- **Imports run in the background** in their own worker, with size limits that can be configured (`--max-gedcom-mb` for the GEDCOM text, `--max-archive-mb` for a whole GEDZIP, 1 GB by default). An upload that can't succeed is refused before it is sent, and an import can be cancelled. (#156)
- **GEDZIP files are plain ZIP**: imports and exports stop at 4 GiB or 65,535 files (ZIP64 archives are not read), and imports also stop at `--max-archive-mb`. A larger media library needs a GEDCOM plus a media folder instead. (#156, #227)
- Writes to a tree are refused while it is importing. (#149)
- **A JSON backup from an older version** imports cleanly into this one. (#206)
- **Command line and import polish**: `--help` and clear usage errors, `serve` opens the browser, blank tree names are refused with a plain message, a fuller import report, a size check before upload, and focus moves to the import result so it is announced. (#228)

### Tree views

- **Family tree view**: the focus person with partners, parents and grandparents above, and children below. Generation labels, photos or silhouettes, and life years. Click a card for a quick view; double-click or press Enter to re-center on that person. (#25, #39)
- **Pedigree, descendant and fan views** from the same layout, switchable from the toolbar, keeping the focus person. (#25, #61, #154, #170, #191)
- **Expand and collapse** ancestors, descendants and siblings card by card. Half siblings hang from their shared parent, and cousins keep their parents together. (#31, #53, #73)
- **Pan, zoom, minimap and keyboard navigation**: arrow keys move between related cards. The URL names the focus person, so any view can be bookmarked, and a hand-edited URL falls back to the default view instead of breaking it. (#39, #77, #214)
- **Pedigree collapse** (the same person reached twice) is drawn as a linked duplicate card. (#39)
- **Quick view polish**: Edit opens the editor directly, a living person shows "Living" once, and people without a photo get a silhouette tinted by sex. At phone width it opens above or below the card and stays on screen, with larger touch targets. (#155, #178)
- **Fan chart labels fit inside their segments**, and Fit stays readable on phones. Switching trees from the top bar moves the open person page or tree view to the new tree, and the tree view settles correctly after fast changes. (#167, #172, #247, #256)
- **Copied trees are told apart**: a tree folder copied by hand shows its folder name next to the tree name in the switcher, start page and export dialog. (#235)
- **Kinship labels** on tree cards name step, adoptive and foster links, not just birth relationships, and use the same words as the relationship calculator ("sister-in-law", "stepmother", "wife of uncle"). (#157, #238)

### Person page

- **Header** with the profile photo, name, birth and death summary, tags, and the relationship to the home person, with its path drawn. (#35, #49)
- **Facts tab** with three columns:
  - **Timeline:** events with year and age, and family events such as siblings' births and parents' deaths.
  - **Sources:** citations, linking back to the Ancestry record.
  - **Relationships:** parents, siblings, and partners with their children.

  (#35)
- **Gallery tab** with thumbnails, a lightbox, and attaching media to the person or an event. Remote Ancestry photos are shown as placeholders and are never downloaded. (#51, #168, #183)
- **Notes, LifeStory and Sources tabs.** A link to someone who doesn't exist, including a malformed address, shows "Person not found". (#35, #213)
- **Half, step, adoptive, foster and guardian kin are named as such** in the timeline ("Birth of half-sister …"), the Relationships column (separate Siblings, Half-siblings and Step-siblings groups) and LifeStory, which also reads dates as prose ("was born about 1842") and tells adoptions and step-parents in their own sentences. A relative's event that may fall after the person's death sorts before it, without an age. (#152, #231)
- **Relationship calculator**: the relationship between any two people ("2nd cousin once removed", "step-mother", "sister-in-law", "step-first cousin", "guardian"), with every path when there is more than one. (#37, #176, #231)

### Search and the people list

- **Command palette** (Cmd/Ctrl-K) searches people by name, place and year, with phonetic matching on surnames. It also runs app actions. Results update on each pause in typing, keys typed right after opening it aren't lost, and screen readers hear how many results there are and land on the heading of the page a result opens. (#40, #59, #175, #180, #233, #260)
- **People list**: every person in the tree, sortable and filterable by tag, living status and sex, and fast even with 100,000 people. (#40, #47)
- **Tree checker**: possible duplicates, impossible dates and people without sources, each linking to the person. (#69)

### Editing

- **Add a person without a relative**, including the first person in a new tree, who becomes its home person. Add person is on the people list, the empty-tree page and the command palette. (#153)
- **Add, edit and delete** people, names, events (with a live preview of how the date is read), notes, tags and relationships. (#48)
- **Relationship fixes**: set or change a partnership's type, and remove a wrong parent, partner or child link. People are never deleted by these. (#165)
- **Merge duplicate people** in one step. Each merge is recorded, so a later re-import still recognizes the person who was merged away. (#70, #219)
- **Several tabs stay in sync**: an edit, undo or re-import in one tab refreshes the others, and a save based on data another tab (or an undo) has since changed is refused with a clear message instead of mixing old and new values. (#203)
- **Edits run in order**: each change to a tree waits for the one before it, undo waits for edits still on their way, and a save that gets no answer gives up after 30 seconds with a clear message. (#205)
- **Undo and redo everything**: Cmd/Ctrl-Z, Shift-Cmd/Ctrl-Z, and a History panel listing recent changes. Each dialog save is one undo step, and history survives app upgrades. (#48, #148)
- **A failed save keeps the dialog open**, with what you typed and the reason, so you can try again. (#177)
- **Edits to someone deleted elsewhere** (in another window, or by undo) get one plain message, no retry that can't work, and land on a close relative. (#240)
- **Delete a person** and their own notes, media and citations go with them (including ones only their imported GEDCOM lines pointed to), while anything still used by someone else stays. You land on a close relative (or the people list), with an Undo button in the toast. Undo brings you back to the restored person. (#181, #232, #254)
- **Phone-width top bar** keeps the open tree's name readable: People and Find become icons with tooltips. (#217)
- **Keyboard friendly**: focus returns to whatever opened a dialog, including after a mouse click in Safari, and the History list scrolls from the keyboard. (#59, #171, #208)

### Privacy and export

- **Your data stays on your computer.** Each tree is a folder (a SQLite database plus media) in your library. The app makes no third-party network requests. (#23, #29)
- **Export GEDCOM 5.5.1** (Ancestry compatible, keeping Ancestry's custom tags), **GEDCOM 7**, **GEDZIP** with media, and **JSON** for backup and tools. Original records are re-read by their own GEDCOM version, so nothing is lost when a GEDCOM 7 import is exported as 5.5.1, and a line that should point at a record but holds text is reported, not silently dropped. GEDCOM 7 exports give each media file's format as a MIME type. (#23, #46, #221, #223)
- **GEDZIP exports stream** one media file at a time, so a large media library exports without loading it all, and an archive past the ZIP limits (4 GiB or 65,535 files) is refused before anything is sent. The export applies the same media checks as the app, so a file from outside the tree can't end up in the archive. (#227, #248)
- **JSON exports can leave out edit history**, and do by default from the export dialog, since that history holds anything you deleted. (#220)
- **Privatized exports scrub withheld people's names** from free text too: notes, event descriptions, photo titles and file names on other people's records. (#212)
- **Privatize living people**, on by default when exporting. Private and confidential records are hidden, and record ids are renumbered so nothing about a hidden person leaks. (#46, #104)
- **Living status** is worked out from dates and can be set by hand. (#21, #48)

### Security

- The server listens on `127.0.0.1` only. Requests are checked by Host and Origin, every change needs a per-session token, which stops other websites, not other programs on this computer, and a strict Content Security Policy is sent with no inline scripts. No page the end-to-end tests open trips that policy, and every end-to-end test fails if one does. (#29, #34, #47, #174)
- GEDCOM files are treated as untrusted. Values cannot inject extra GEDCOM lines on export, text that looks like a pointer stays text, coordinates are parsed safely, and control characters are escaped in command-line output. (#26, #150, #166, #179)
- Media is served without path traversal, hard-linked media files and a symlinked media folder are refused (and checked again after reading), and uploads have size limits. (#29, #51, #236, #251)
- The library's files are private to your user account, and the API refuses navigations from other sites, so another site can't drop an export into Downloads. open-ancestry assumes one user per computer: a running app answers anyone on that machine at `127.0.0.1`. A library folder that other accounts can write to is refused unless you start the app with `--shared-library`. (#151, #237)

### Performance

Budgets are checked in CI on 10,000-person and 100,000-person synthetic trees. (#38, #63) The figures below are for an M-series laptop; CI's shared runners check them scaled by 2.5 (`OA_BENCH_FACTOR`).

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

### Known limitations

- Search matches surnames phonetically, but not yet common spelling equivalents across scripts: Yılmaz and Yilmaz, Straße and Strasse, pointed and unpointed Hebrew, O'Brien and OBrien (#199).
- A name containing right-to-left override or other control characters can change how the text after it is displayed (#190).

### For contributors

- Property tests for round-trips and undo in the data layer, and fixes for the root causes of flaky tests. (#94, #105, #242, #249)
- Benchmarks run in their own CI job, and e2e runs in four shards with the merged coverage gate kept as `ci`. (#253, #262)
- Test temp folders are cleaned up automatically, and the e2e server has room for every test's import and review. (#187, #250, #255, #258)
- `downgradeTree` rewrites a tree as an older schema version, so migration tests run the real migrations. (#229)
