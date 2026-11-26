# Changelog

## [1.9.19] - 2026-11-25

### Fixed
- Use multi-element selectors for OPML feed checkbox counting, bulk selection, and selected-feed collection.
- Align the OPML preview browser assertion with the current summary text.
- Add unit coverage for OPML multi-selection behavior.


## [1.9.18] - 2026-11-25 

### Fixed
- Use the all-dialog selector when closing any remaining open dialogs before the OPML preview opens.


## [1.9.17] - 2026-11-25

### Fixed
- Correctly enumerate all open dialogs before opening the OPML preview, avoiding a single-element iteration error.


## [1.9.16] - 2026-11-25

### Fixed
- Initialize the OPML import selection state used while building the preview, fixing the runtime error that prevented OPML previews from opening.
- Remove temporary browser-test diagnostics after identifying the regression.


## [1.9.15] - 2026-11-25

### Fixed
- Fall back to a non-modal OPML preview if the browser rejects modal promotion after closing other dialogs.
- Focus the article list explicitly in the Vim browser test before checking pane navigation.


## [1.9.14] - 2026-11-25

### Fixed
- Defer the OPML preview modal until the browser has completed closing Settings.
- Include the individual Vim key-handling results in browser test output when a regression occurs.


## [1.9.13] - 2026-11-25

### Fixed
- Wait for the Settings dialog close event before opening the OPML preview, avoiding modal-stack timing failures.
- Preserve the Vim pane preference during browser reload tests instead of resetting it from the test setup script.


## [1.9.12] - 2026-11-25

### Added
- Add Vim-style Escape handling: leave an editing field first, then use Escape in Normal mode to focus the sidebar.
- Add uppercase D to collapse or expand the sidebar while the sidebar pane is focused.
- Add a persistent, preset-aware keyboard shortcut strip with a Settings toggle.
- Add browser and unit regression coverage for Vim sidebar controls and shortcut-strip preferences.


## [1.9.11] - 2026-11-25

### Fixed
- Close the Settings dialog before opening the OPML import preview, avoiding nested modal dialog failures.
- Assert that Vim pane focus is written to settings before testing restoration after reload.


## [1.9.10] - 2026-11-25

### Fixed
- Preserve the selected Vim navigation pane when settings are validated and restored after reload.
- Add browser coverage for Vim preset activation, pane switching, keyboard handling, and persisted pane focus.


## [1.9.9] - 2026-11-25

### Fixed
- Add an OPML import selection list with all eligible feeds selected by default and controls to select or clear feeds individually or in bulk.
- Keep the article-list column at its configured width when collapsing the sidebar, shifting the article list and reader left and giving the reader the freed width.
- Update browser regression tests for the intended collapsed layout and OPML selection behavior.


## [1.9.8] - 2026-11-25

### Fixed
- Preserve automatic list expansion when collapsing the sidebar, while allowing the article-list splitter to reduce the pane to its configured minimum.
- Add browser regression coverage for manually resizing the article list after collapsing the sidebar.


## [1.9.7] - 2026-11-25

### Fixed
- Disable keyboard shortcut coaching on mobile-sized layouts and clear any visible suggestion when switching to mobile; the desktop preference remains intact.
- Added unit and browser regression coverage for mobile and desktop behavior.

## [1.9.6] - 2026-11-25

### Fixed
- Let the article list expand into the space freed by collapsing the sidebar, while preserving the reader's minimum width and preventing horizontal overflow.
- Added a browser regression test for collapsed-sidebar pane sizing.

## [1.9.2] - 2026-11-25

### Fixed
- Give contextual shortcut suggestions a dedicated notification surface so action toasts cannot overwrite them.
- Keep shortcut suggestion dismissal and per-action suppression independent of ordinary notifications.


## [1.9.1] - 2026-11-24

### Fixed
- Corrected contextual shortcut coaching so article actions are matched to the active shortcut preset.
- Excluded keyboard, scripted, and touch-only activations from coaching prompts.
- Added per-action and global notification cooldowns, reliable dismissal, and regression tests.

## [1.9.0] - 2026-11-24

### Added
- Full local profile backup and restore with validation, merge, replacement, and rollback.
- Automated Playwright end-to-end browser coverage in GitHub Actions.
- Feed health reporting, refresh diagnostics, and exponential retry backoff.
- Persistent reading queue with manual ordering and bulk removal.
- Configurable article retention with protection for saved and annotated content.
- OPML import preview with folder hierarchy and duplicate/invalid URL reporting.
- Global and per-feed refresh intervals with automatic scheduling.
- JSON and Markdown export for highlights and notes.
- Reading activity statistics with selectable time ranges.
- OLED Black and Pure White themes.
- Collapsed-sidebar quick navigation and contextual keyboard shortcut coaching.

### Improved
- Sidebar layout, hover actions, folder spacing, and navigation density.
- Keyboard focus behavior and article-list sizing.
