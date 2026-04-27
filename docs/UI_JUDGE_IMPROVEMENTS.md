# UI improvements to impress a judge

This note captures the recommended UI changes to make the Trace frontend feel
more memorable, more productized, and more competition-ready without changing
the underlying product scope.

## Overall direction

The current UI is clean and competent, but it still reads more like a polished
internal tool than a standout finalist product. The strongest improvement is to
shift the experience from "search form plus results list" to an "investigation
command center."

## Recommended changes

### 1. Make the page feel like an active case workspace

Current issue:

- the large hero area takes up space but adds little once the user starts work

Recommended change:

- shrink the marketing header
- move immediately into a two-panel layout
- use the left side for the investigation request, structured filters, and curated cases
- use the right side for the ranked evidence trail, summary, and next action

### 2. Add a strong top-finding layer above the raw results

Current issue:

- every result currently has roughly the same visual weight

Recommended change:

- add a highlighted "Top lead" or "Top finding" card
- include:
  - strongest surfaced record
  - why it matters
  - active filters
  - result count
  - time window
- show remaining supporting records underneath

This gives the judge an immediate "aha" moment instead of making them parse the
list themselves.

### 3. Turn results into evidence cards instead of generic search hits

Current issue:

- the cards are readable but visually interchangeable

Recommended change:

- add a priority or severity rail or badge
- add a clearer provenance block
- show visible filter-match chips
- show excerpts with stronger visual hierarchy
- keep a dedicated "why surfaced" or "result context" block
- use a compact metadata footer

Each card should feel like an investigative artifact rather than a normal
search result.

### 4. Add one memorable signature visualization

Current issue:

- there is no single visual element that a judge is likely to remember

Recommended change:

- add one signature visualization such as:
  - an evidence timeline
  - an evidence ladder from strongest lead to supporting records
  - a jurisdiction and document-type summary strip
  - a compact Trace reasoning panel showing:
    - natural-language request
    - interpreted filters
    - constrained backend search
    - surfaced evidence

One memorable visual is likely to matter more than many small styling upgrades.

### 5. Make the AI-native moment impossible to miss

Current issue:

- the explanation layer exists, but it does not yet feel central to the
  product experience

Recommended change:

- make the flow visibly read as:
  - request entered
  - filters interpreted
  - evidence surfaced
  - defensible action assembled
- add a small handoff panel with:
  - investigation goal
  - applied scope
  - primary evidence
  - suggested handoff

Even if the handoff is deterministic and template-based, it makes the system
feel much more like a finished product.

### 6. Increase contrast, hierarchy, and drama

Current issue:

- the visual system is tasteful, but too polite

Recommended change:

- increase contrast between workspace zones
- use denser, more editorial typography
- apply more assertive color semantics
- reduce decorative space that does not help the workflow
- make state transitions between idle, searching, and results more visible

The product should feel operational, not merely pleasant.

### 7. Improve motion and sequencing

Current issue:

- results appear competently, but not memorably

Recommended change:

- stage the reveal when results arrive
- show the lead card first
- fade or stagger in supporting evidence afterward
- animate the filter summary into place
- make loading states read as "assembling evidence trail" instead of generic
  search progress

Judges should feel like the product is doing purposeful work.

### 8. Design the empty, loading, and no-results states as part of the demo

Current issue:

- the states are functional, but not especially product-specific

Recommended change:

- empty state: "Start an investigation"
- loading state: "Interpreting request / narrowing evidence / ranking records"
- no-results state: "No defensible match in current scope"

These states should reinforce the investigative story, not just fill space.

## What not to do

- do not add many extra tabs or workflows
- do not turn the UI into a generic AI chat surface
- do not add charts that are visually flashy but not directly useful to the
  investigation story

## Recommended execution direction

If this were redesigned within the current branch scope, the strongest path
would be:

- a compact top bar instead of a large hero
- a left-column investigation composer
- a right-column evidence workspace
- one featured top-lead card
- a timeline or evidence ladder beneath it
- a small defensible-handoff summary panel

That would preserve the current product scope and API shape while making the
frontend feel much more like a finalist demo surface.
