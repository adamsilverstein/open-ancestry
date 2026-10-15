# Release notes

## v1 (unreleased)

- **Tree format: schema v5, forward-only.** Opening a tree upgrades it to schema version 5 (v4 added person aliases, v5 adds the people list's sort index, `person_sort`). The upgrade cannot be undone: an older open-ancestry refuses a v5 tree ("newer than this app supports"), so keep a copy of the tree folder, or a JSON export, before opening it with this release if you may need the older app.
