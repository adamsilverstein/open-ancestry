# Changelog

## v1.0.0 (draft)

The first release of open-ancestry: a local-first family tree app. Import your Ancestry.com tree, then browse, search, edit and export it on your own computer. The app sends nothing anywhere; what you export is up to you, and exports leave living people's details out by default (see [Privacy and export](#privacy-and-export)).

open-ancestry is for one person per computer account. Don't run it on a shared or multi-user machine (see [Security](#security)).

> **Upgrading a tree is one-way.** A tree opened in this version can't be opened by an older version of the app. Before opening a tree you care about, keep a copy of its folder or export it as JSON.

### Known limitations

- **Names with right-to-left or other control characters** can change how the text after them is displayed. This includes the labels on the re-import review and the merge prompt, and tree names accept these characters too (#190, #264).
- **Search matches surnames by sound, but not yet common spellings across scripts**: Yılmaz and Yilmaz, Straße and Strasse, pointed and unpointed Hebrew, O'Brien and OBrien (#199).
- **Dual dates sort apart from the same day in the old calendar.** A dual-dated day such as `29 FEB 1751/52` sorts as if it were a modern calendar date, so it lands 11 days away from the same day written as an old-calendar (Julian) date, which is how a GEDCOM 7 export writes it (#298).

### Import and re-import

- **Import Ancestry GEDCOM and GEDZIP files** from the start page (drag and drop) or with `open-ancestry import`. Ancestry's own details are understood: links to Ancestry records, MyTreeTags, photos and primary photos, adopted and step relationships, and military events. Nothing is dropped: every line is either understood or kept as is, so the tree can be exported again.
- **Import report** with counts, warnings by line number, anything that could not be understood, and how many lines were kept as they are for export. Photo size details in the GEDCOM (width, height and file size) are always read: they fill in what the photo file itself doesn't give, and are no longer reported as unmapped when the file does, as in a GEDZIP the app exported.
- **Accented names come through intact** even when a file's header names the wrong text encoding and its first accented letter is far into the file. GEDZIP files made with macOS's Compress or the `zip` command keep accented photo names, so those photos are found.
- **Media from a GEDZIP or a media folder** is linked by its location in the folder. Missing files are reported but keep their location, so an export still names them, and existing files are never overwritten.
- **Re-import an updated Ancestry export** into an existing tree. People are matched, with a confidence and the reasons for each match, and look-alikes are found by their other names too. A review screen, grouped by what needs a decision, lets you accept or reject each change before anything is written, and matching stays fast on large trees.
  - It compares three ways, so what you changed since the last import is kept apart from what Ancestry changed: your edits aren't offered again, values an earlier re-import brought in aren't mistaken for your edits, and a place you renamed stays renamed.
  - A marriage or divorce whose date was corrected, on either side, is offered as a change, not as a second marriage. A fact Ancestry corrected in both date and place is paired with the one from your earlier import when both cite the same record. A fact you typed in yourself is never paired this way.
  - A place Ancestry renamed shows up as one review item instead of one per fact, and doesn't lower anyone's match.
  - What you decline stays declined: an addition you left unticked isn't offered ticked again while the export says the same, and a tag you removed stays removed. A new fact at a place's old name lands on the place you renamed.
  - New photos in an updated GEDZIP or media folder are copied in, the same photo under another name isn't added twice, and a photo whose file changed is offered as a choice between yours and Ancestry's.
  - After applying, a summary lists what changed for each person, with links. Undo closes its notice and marks the summary as undone. Cancelling or discarding a review returns to the tree.
  - The comparison runs in the background, so the app stays responsive while a large tree is compared. If the tree changes after the comparison, the review offers to compare again, and a ticked name conflict says what it will do.
  - By design, people missing from the new export are listed but never removed: re-import adds and updates, it doesn't sync deletions. And a fact you deleted comes back as an addition if Ancestry changed both its date and its place, since nothing ties the two versions together.
- **Dates as they appear in real trees**: `ABT`, `BEF`, `AFT`, `BET … AND`, `FROM … TO`, US-style `05/28/1960`, ISO dates, decades, centuries and year ranges, and dual-dated days such as `29 FEB 1751/52`. A note after a date, as in `BEF 1850 (per census)`, keeps the "before". Text that is not a date is kept as typed.
- **GEDCOM 7** files, including calendar dates, which are checked.
- **Accented names stay consistent**: accented letters typed different ways match, in names, places and photo file names.
- **Imports run in the background**, with size limits you can change (`--max-gedcom-mb` for the GEDCOM text, `--max-archive-mb` for a whole GEDZIP, 1 GB by default). An upload that can't succeed is refused before it is sent, and an import can be cancelled.
- **GEDZIP files have a size limit**: imports and exports stop at 4 GiB or 65,535 files, and imports also stop at `--max-archive-mb`. A larger media library needs a GEDCOM plus a media folder instead.
- Changes to a tree are refused while it is importing, including when another copy of the app or `open-ancestry import` is the one importing it. The app keeps working meanwhile: the tree list still loads, and a page for the busy tree says so and offers to try again.
- **A JSON backup from an older version** imports cleanly into this one.
- **Command line and import polish**: `--help` and clear usage errors, `serve` opens the browser, blank tree names are refused with a plain message, a fuller import report, a size check before upload, and focus moves to the import result so screen readers announce it.

### Tree views

- **Family tree view**: the focus person with partners, parents and grandparents above, and children below. Generation labels, photos or silhouettes, and life years. Click a card for a quick view; double-click or press Enter to re-center on that person.
- **Pedigree, descendant and fan views** from the same layout, switchable from the toolbar, keeping the focus person.
- **Expand and collapse** ancestors, descendants and siblings card by card, at any depth: ancestors further up offer their siblings too, and a person whose children were partly shown in another view gets the rest. Half-siblings hang from their shared parent, and cousins keep their parents together.
- **Pan, zoom, minimap and keyboard navigation**: arrow keys move between related cards. The web address names the focus person, so any view can be bookmarked, and a hand-edited address falls back to the default view instead of breaking it.
- **Pedigree collapse** (the same person reached twice) is drawn as a linked duplicate card.
- **Quick view polish**: Edit opens the editor directly, a living person shows "Living" once, and people without a photo get a silhouette tinted by sex. At phone width it opens above or below the card and stays on screen, with larger touch targets.
- **Fan chart labels fit inside their segments**, and Fit stays readable on phones. Switching trees from the top bar moves the open person page or tree view to the new tree, and the tree view settles correctly after fast changes.
- **Copied trees are told apart**: a tree folder copied by hand shows its folder name next to the tree name in the switcher, start page and export dialog.
- **Kinship labels** on tree cards name step, adoptive and foster links, not just birth relationships, and come from the relationship calculator itself, so the two always agree ("sister-in-law", "stepmother", "3rd great-grandfather"). The parent-set switcher reaches every set of parents, and a family with thousands of children still fits.
- **Dates read the same everywhere**: tree cards keep "abt." and "bef.", and the people list and gallery show `bet. 1870 and 1872` or `28 May 1960` rather than the date as typed.

### Person page

- **Header** with the profile photo, name, a nickname ("Known as …"), birth and death summary, tags, and the relationship to the home person, with its path drawn.
- **Facts tab** with three columns:
  - **Timeline:** events with year and age, and family events such as siblings' births and parents' deaths.
  - **Sources:** citations, linking back to the Ancestry record.
  - **Relationships:** parents, siblings, and partners with their children.
- **Gallery tab** with thumbnails, a lightbox, and attaching media to the person or an event. Photos stored on Ancestry's site are shown as placeholders and are never downloaded.
- **Notes, LifeStory and Sources tabs.** A link to someone who doesn't exist, including a malformed address, shows "Person not found".
- **Half, step, adoptive, foster and guardian kin are named as such** in the timeline ("Birth of half-sister …"), the Relationships column (separate Siblings, Half-siblings and Step-siblings groups) and LifeStory, which also reads dates as prose ("was born about 1842") and tells adoptions and step-parents in their own sentences. The timeline is in date order, and a relative's event that may fall after the person's death says so ("may be after his death") and shows no age.
- **Relationship calculator**: the relationship between any two people ("2nd cousin once removed", "step-mother", "sister-in-law", "step-first cousin", "guardian"), with every path when there is more than one.

### Search and the people list

- **Command palette** (Cmd/Ctrl-K) searches people by name, place and year, matching surnames by sound. Equally good matches are listed by name, and when more people match than it shows, "Show all N people" lists up to 100. It also runs app actions. Results update on each pause in typing, keys typed right after opening it aren't lost, and screen readers hear how many results there are and land on the heading of the page a result opens.
- **People list**: every person in the tree, sortable and filterable by tag, living status and sex.
- **Tree checker**: possible duplicates, impossible dates and people without sources, each linking to the person.

### Editing

- **Add a person without a relative**, including the first person in a new tree, who becomes its home person. Add person is on the people list, the empty-tree page and the command palette.
- **Add, edit and delete** people, names, events (with a live preview of how the date is read), notes, tags and relationships. A new event asks for its type rather than assuming Birth, and its place field suggests places already in the tree.
- **Relationship fixes**: set or change a partnership's type, and remove a wrong parent, partner or child link. People are never deleted by these.
- **Merge duplicate people** in one step. Each merge is recorded, so a later re-import still recognizes the person who was merged away.
- **Undo and redo your edits**: Cmd/Ctrl-Z, Shift-Cmd/Ctrl-Z, and a History panel listing the last 50 changes. Each dialog save is one undo step, re-imports can be undone too, and history survives app upgrades. A few limits:
  - The first import of a tree isn't an undo step. To take it back, delete the tree.
  - Undo refuses a change that a later edit has since touched. Undo the later edit first.
  - A few older changes can't be undone after the upgrade that makes accented letters match. Undo steps over them and says so.
- **Several tabs stay in sync**: an edit, undo or re-import in one tab refreshes the others, and a save based on data another tab (or an undo) has since changed is refused with a clear message instead of mixing old and new values.
- **Edits run in order**: each change to a tree waits for the one before it, undo waits for edits still on their way, and a save that gets no answer gives up after 30 seconds with a clear message.
- **A failed save keeps the dialog open**, with what you typed and the reason, so you can try again.
- **Edits to someone deleted elsewhere** (in another window, or by undo) get one plain message, no retry that can't work, and land on a close relative.
- **Delete a person** and their own notes, media and citations go with them (including ones only their imported GEDCOM lines pointed to), while anything still used by someone else stays. You land on a close relative (or the people list), with an Undo button in the toast. Undo brings you back to the restored person.
- **No tree open**: History and the File menu say a tree is needed instead of waiting or offering exports.
- **Rename a tree** to a different capitalization of the same name.
- **Phone-width top bar** keeps the open tree's name readable: People and Find become icons with tooltips.
- **Keyboard friendly**: focus returns to whatever opened a dialog, including after a mouse click in Safari, and the History list scrolls from the keyboard.

### Privacy and export

- **Your data stays on your computer.** Each tree is a folder (a database plus media) in your library. The app never contacts other websites.
- **Export GEDCOM 5.5.1** (Ancestry compatible, keeping Ancestry's own details), **GEDCOM 7**, **GEDZIP** with media, and **JSON** for backup and tools. Nothing is lost when a GEDCOM 7 import is exported as 5.5.1, same-sex couples keep their tags in 5.5.1, and a line that should point at a record but holds text is reported, not silently dropped.
- **GEDZIP exports stream** one media file at a time, so a large media library exports without loading it all, and an archive past the size limit (4 GiB or 65,535 files) is refused before anything is sent. The export applies the same media checks as the app, so a file from outside the tree can't end up in the archive.
- **JSON exports can leave out edit history**, and do by default from the export dialog, since that history holds anything you deleted. Without history, places, notes, photos, citations and sources only a deleted person used are left out too.
- **Privatize living people**, on by default when exporting, and on again each time the export dialog opens or the format changes. Private and confidential records are hidden, and record ids are renumbered, so the exported GEDCOM text says nothing about a hidden person. In a privatized GEDZIP, photos lose their embedded details (camera, location, captions), and files whose details can't be removed, such as PDFs, are left out.
- **Privatized exports scrub withheld people's names** from free text too: notes, event descriptions, photo titles and file names on other people's records.
- **Living status** is worked out from dates and can be set by hand.

### Security

- The app only answers requests from this computer. It checks where each request comes from, every change needs a per-session token, which stops other websites, not other programs on this computer, and pages can only run the app's own scripts.
- GEDCOM files are treated as untrusted. Values cannot inject extra GEDCOM lines on export, text that looks like a link to another record stays text, coordinates are read safely, and control characters are escaped in command-line output.
- When the app imports, shows or exports media, it refuses files outside the tree, hard-linked files, a symlinked media folder and a file swapped in during the import, and checks again after reading. Uploads have size limits. A GEDZIP whose entries share or overlap stored data is refused.
- The library's files are private to your user account, and another site can't make the app drop an export into Downloads. open-ancestry assumes one user per computer: a running app answers anyone on that machine. A library folder that other accounts can change is refused unless you start the app with `--shared-library`.

### Performance

Fast on trees of 100,000 people: imports, search, the people list and the tree views all have speed budgets that are checked on every change, and the tree view stays fast however long you browse. See [For contributors](#for-contributors) for the figures.

### Technical notes

- Trees are stored as schema version 5. Version 4 records merges as person aliases, and version 5 adds sort keys for the people list.
- Text is normalized to Unicode NFC on import, on edit, and once when a tree is upgraded.
- GEDZIP archives are plain ZIP; ZIP64 archives are not read. File names stored as UTF-8 without the UTF-8 flag are read as UTF-8 when they are valid.
- Upgrades run each step under a write lock and skip a step another process already applied, so two copies of the app can open an old tree at once. A JSON backup with decomposed (NFD) text imports with its undo history intact.
- A busy tree answers 409 with the error code `busy`. A tree being imported carries a `busy.lock` file in its folder, so another copy of the app sees it too.
- GEDCOM 7 exports give each media file's format as a MIME type.
- Original GEDCOM records are re-read by their own GEDCOM version on export.
- The server listens on `127.0.0.1` only. Requests are checked by Host and Origin, the API refuses cross-site navigations, and a strict Content Security Policy is sent with no inline scripts.
- Ancestry record links come from `_APID`. Tags that could not be mapped are listed in the import report and kept on export.

### For contributors

- Property tests for round-trips and undo in the data layer, and fixes for the root causes of flaky tests.
- Benchmarks run in their own CI job, and e2e runs in four shards with the merged coverage gate kept as `ci`.
- Test temp folders are cleaned up automatically, and the e2e server has room for every test's import and review. Stale upload and photo-attach folders are swept after a crash, and an abandoned re-import review frees its space after a while.
- `downgradeTree` rewrites a tree as an older schema version, so migration tests run the real migrations.
- Tree layouts read from an index the graph cache keeps, so laying out a few cards costs the same however much of the tree was browsed before.
- No page the end-to-end tests open trips the Content Security Policy, and every end-to-end test fails if one does.

Performance budgets are checked in CI on 10,000-person and 100,000-person synthetic trees. The figures below are for an M-series laptop; CI's shared runners check them scaled by 2.5 (`OA_BENCH_FACTOR`).

| What | Budget on a 10,000-person tree |
| --- | --- |
| Import an Ancestry GEDCOM | under 3 s |
| Server start to first answer | under 300 ms |
| First page load | under 1 s, with under 150 KB of JavaScript |
| Open a person or a part of the tree | under 20 ms on the server |
| Search | under 50 ms |
| Re-focus the tree view | under 50 ms; under 35 ms at mid zoom |
| Pan and zoom | 60 fps with 2,000 cards |

Other speed-ups include imports that build indexes once at the end and batch their writes, cached people lists and marriage indexes, a tree view cache that starts over cleanly after an edit, sibling links built in linear time so very large families lay out at once, and stored sort keys so the people list opens sorted by birth or death in a 100,000-person tree without scanning it.

### Changes by PR

Every change in this release, with its pull request: [merged pull requests](https://github.com/adamsilverstein/open-ancestry/pulls?q=is%3Apr+is%3Amerged).
