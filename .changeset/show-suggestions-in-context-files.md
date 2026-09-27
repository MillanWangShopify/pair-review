---
"@in-the-loop-labs/pair-review": patch
---

Allow AI findings on existing unchanged files in PR and Local reviews. Create context files for final analysis results and when selecting a council voice; reveal suggested ranges in place without adding context files during rendering. A removed panel returns when a later final analysis reports a finding there, when selecting a voice with a finding there or whenever the suggestions reload while that voice is selected (for example after a refresh, a whitespace toggle, or a scope change), or when clicking a finding or comment in that file. Keep unchanged-file comments out of GitHub review submissions while retaining them locally, with a visible notice in the UI and warnings in headless mode.
