---
"@in-the-loop-labs/pair-review": patch
---

Fix files with non-ASCII names (such as `café.js`)

- Files with non-ASCII names no longer appear twice in the PR file list, and their diffs show in both PR and Local reviews.
- Untracked files with non-ASCII names now appear in Local reviews.
- Comments on these files are submitted to GitHub as inline comments.
- A rename whose old and new paths share nothing (such as `lib/x.js` to `docs/y.js`) is now recorded as a rename.
