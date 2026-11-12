---
title: uTerm feature guide
status: active
type: reference
created: 2026-09-24
updated: 2026-11-12
---

# uTerm feature guide

[简体中文](features.zh-CN.md) · [Download and quick start](../README.md) ·
[Development](development.md)

**Contents**

- [Product scope](#product-scope)
- [Project website](#project-website)
- [Installation](#installation)
- [Workspaces and sessions](#workspaces-and-sessions)
- [SSH and remote files](#ssh-and-remote-files)
- [Redis connections and workbench](#redis-connections-and-workbench)
- [Files and source control](#files-and-source-control)
- [Java and Maven builds](#java-and-maven-builds)
- [Python projects and logs](#python-projects-and-logs)
- [Agents and settings](#agents-and-settings)
- [Interface](#interface)
- [Architecture](#architecture)
- [Validation and limits](#validation-and-limits)
- [Database connections and optional components](#database-connections-and-optional-components)

## Product scope

uTerm is a Windows and macOS desktop terminal. Local terminal and Agent processes run locally; SSH
remote shells run on their servers.

The interface supports Simplified Chinese and English.

### Personal macOS app

The experimental **uTerm Personal** app uses Swift/AppKit and the shared Rust core/helper on macOS
14+. It is ad-hoc signed for free personal use, without a paid Apple Developer account, App Store
listing or Apple notarization.

Download the **Personal** Apple Silicon or Intel DMG/ZIP from the versioned
[GitHub Release](https://github.com/YondFane/uTerm/releases), verify its personal SHA256SUMS file,
and drag **uTerm Personal.app** into Applications. Published attachments have no automatic expiry or
GitHub sign-in requirement. First launch may require approval in **System Settings → Privacy &
Security**. Version 0.2.6 has no updater: install an updater-enabled release manually once.

In an updater-enabled build, **Settings → Software updates → Automatically check and download
updates** enables Sparkle checks and signed downloads after **Save settings**. It is off by default.
The app menu and settings also provide **Check for updates…**. Background downloads can install when
the app quits; Sparkle asks before an immediate install/relaunch. Existing editor, transfer and
database quit guards still apply. Turning the option off stops future automatic checks/downloads; an
already prepared update can still install on quit. Update failures remain visible and can be retried
manually. Update status text follows language changes immediately, including the no-update result.

The personal client uses separate HTTPS `personal-stable-arm64.xml` and `personal-stable-x86_64.xml`
feeds and Ed25519-signed ZIPs. The SDK verifies signatures before extraction; platform,
architecture, channel and archive origin are checked before download, and older versions are
excluded. Existing Tauri installers and JSON feeds remain separate. No paid Apple signing
certificate is needed for these updater signatures.

The identity `sh.uterm.desktop.personal` keeps its profile in
`~/Library/Application Support/sh.uterm.desktop.personal/`, without importing Tauri/QA data. Symlink
redirects into another profile are rejected. Updates replace the app, retaining the profile and
detached sessions. Before a manual replacement or rollback, keep the previous package, stop tasks,
close sessions, quit and back up this directory. Never restore old data over an active app/host. The
shared core retains conflict checks, draft recovery and explicit rollback exports; installing the
app does not automatically restore old data or perform the Tauri-to-native cutover.

#### Native workspace interaction

Both clients include the same unmodified Cascadia Code 2407.24 static faces and their SIL Open Font
License. The default face loads before a Web terminal mounts; native CoreText registration remains
inside the app process. No font installation or startup download is required, and custom family
settings remain available. Font loading failures show a retry or reinstall message.

Matching workspace evidence records the bundled regular-face digest and actual measured character
width. The comparison rejects stale files, fallback faces or widths differing by 0.1 point or more.
Linux checks verify release bytes, styles, delayed mounting, load failures and retry. Actual
Chromium loads all five faces with an M advance of 9.9609375px at 17px. Latest macOS font
registration, window rendering and paired metrics still require CI.

Regular toolbar/sidebar vectors and dimensions use `shared/contracts/chrome-ui-v1.json`. React reads
that source and Swift renders the generated paths through CoreGraphics. The native candidate uses
the shared 44-point toolbar and interface palette; Agent brands and special close controls remain
outside this vector contract.

The 48-point category rail sits at the left edge, workspace selection above its list, and the
title/Java/Python controls above the main pane. The sidebar defaults to 248 points, clamps to 30% of
the window (at most 320), and retains the rail when collapsed. Add, Commands, Settings and Agents
have separate footer entries.

Tools default to 35% of the remaining width and reserve a 320-point main pane. Narrow windows keep
the whole tools column inside the window. Side/tool separators support dragging, arrows, Home/End
and Return; native layout avoids an extra split-view titlebar inset.

The file tools use the full window height, with their toolbar at the top and the path footer at the
bottom. Embedded tools stay in normal document flow; narrow WebKit viewports do not inherit the
ordinary floating panel's 44-point offset or shadow. Their root ignores the nested titlebar safe
area. Both collectors measure actual panel/header position, panel/viewport height and footer bounds;
pairing rejects offsets, missing metrics and clipped paths. Fifteen Linux pairing-policy tests and
Chromium geometry checks at five widths (128–1100px) pass; current-source macOS rendering still
requires CI.

Narrow sidebars allocate separate widths to the navigation rail and workspace menu/list. The
workspace name stays within its own button instead of pushing navigation icons outside the window.
Both collectors measure actual rail position/width and All-button position/size, rejecting clipping
regardless of the outer sidebar width. At source `1a9754a0f86acaf9178dbe65dd30e91957469627`, tested
merge `e59b91c76512f176a5fe904a38c46311a3a31931`, both Personal architectures pass the full package
and real-window/replacement checks. The
[ARM artifact](https://github.com/YondFane/uTerm/actions/runs/43051436652/artifacts/13869434943)
reports a 192px sidebar at 640px, rail left/width 0/48 and All button left/top/size 7/52/34×34.
English/dark workspace and Chinese/light PDF originals were inspected; the rail is fully visible.
The
[ARM native matrix](https://github.com/YondFane/uTerm/actions/runs/43051436660/artifacts/13871301710)
also passes, including actual typed SSH clearing, create/keep/prune and PostgreSQL disconnect.
Ordinary Mac pairing at this source fails its QA-only read observer because `session.entries` was
missing from its explicit read allowlist. The candidate adds only that read method; mutation retries
remain forbidden. Failed images/logs are retained in the
[ordinary artifact](https://github.com/YondFane/uTerm/actions/runs/43051436701/artifacts/13873090397).
The new modal and full pairing remain unaccepted until their own current-source run.

Paired artifacts also include a local `comparison.html` scene viewer alongside the original PNGs,
JSON and Markdown. Extract the artifact, select an area/scene, and open either image at its original
size. Source/merge identities, image digests and the pending functional-acceptance notice stay
visible; no screenshots are synthesized or changed. Linux browser checks verify all 34 historical
pairs, unchanged digests, the 24 settings-pair filter and previous/next actions. This is report-tool
validation. At source `760d433f319a0e95685e7dd4724a8b23b14b07ec`, merge
`6e78c0fd82c2aeb6a760d939e97c420bf3488c1d`, the
[paired artifact](https://github.com/YondFane/uTerm/actions/runs/43074768506/artifacts/13882103469)
contains the viewer, 36 pairs and 73 originals including restart. Image digests and all viewer
scenes were checked. English/dark wide and Chinese/light narrow Quick SSH pairs were inspected: the
form and live surrounding workspace now agree; sidebar styling and full functional parity remain
pending.

Real Mac reports exposed a one-pixel narrow terminal-header difference. Source
`becc4e233a0354137fe8248486e8dd7fb0df29fa`, merge `198238492c3f298999257b09bb3813468a1b11b3`, now
records 66px narrow and 35px wide across all eight Intel Personal scenes, with top inset 11px and
output gap 12px, in the
[Personal artifact](https://github.com/YondFane/uTerm/actions/runs/43065251107/artifacts/13876314613).
Native flow uses the measured 23px Mac font-button height; the Swift regression passes. The strict
pairing tolerance is unchanged, and matching current-source ordinary/ARM captures remain required.

The Intel native matrix at that source stops before launching database QA because Maven Central DNS
resolution fails. Its
[retained artifact](https://github.com/YondFane/uTerm/actions/runs/43051436660/artifacts/13871038779)
does pass the original Quick SSH/search/clipboard checks, but does not accept the full matrix or the
new modal. QA now tries the independent official Central domain after a transport failure, requiring
the same catalog size and SHA-256; integrity failures stop immediately. Five simulated download
checks cover DNS/partial files, timeouts, both hosts failing and digest rejection. Mac CI retains
`database-download-tests.log` and successful `database-jdbc.json` provenance; real PostgreSQL
acceptance remains mandatory.

The list separates Active, Pinned, SSH, Redis, Databases, loose terminals/chats and inactive
Projects.

Rows share a 32-point minimum height, 32-point section headers, 18-point section gaps and an 8-point
list inset. Row padding and larger interface text still expand rows.

Native selection uses the same rounded accent fill/border, and project folder icons reveal
disclosure arrows on hover. The toolbar shows pane zoom only for split layouts.

The native toolbar includes the selected repository's branch picker. Left click or Arrow Down opens
local and remote branches; right click or Shift-F10 opens Push, Pull, Fetch and Refresh. Mutations
capture the project, working directory and expected branch, retain editor-save and conflict checks,
and reject changed selections without retrying writes. Reads refresh every four seconds. Errors are
shown in the workspace.

Redis and Database sections list each saved connection by name. Selecting a row opens that exact
profile in its retained workbench, without closing other tabs or an open connection-editing draft.
Selection requests are scoped to the current workspace, survive initial document loading and are
consumed once. Deleted profiles and workspace changes reject the request. Sidebar text uses the
shared 600 weight; focusing a hidden session-close button invalidates its drawing immediately. The
GitHub PR modal casts the interface-theme shadow outside its clipped form.

**Toolbar and connection-row validation**

Linux x86_64 / Node 26: the frontend suite passes 478 checks (11 conditional skips); type checks,
production build and documentation checks pass. Focused checks cover workspace boundaries,
deleted/repeated targets, connection selection with a protected profile/password draft, and existing
save conflicts. Native Git QA exercises branch switching, stale expected-branch rejection and
restoration through the guarded application callback, and captures
`native-toolbar-branch-picker-en-dark.png`. Database/Redis QA selects the actual AppKit row and
captures `native-database-sidebar-profile-en-dark.png` and
`native-redis-sidebar-profile-en-dark.png`. These new Mac scenarios and current-source paired visual
acceptance remain pending CI; the branch popup's pointer/keyboard operation is not claimed from
model checks.

The first Intel CI compilation rejected a shadowed error property, an ambiguous Objective-C selector
and menu helpers missing main-actor isolation. The candidate corrects these diagnostics; no native
execution is claimed for the failed build. Fresh Mac execution remains required.

At source `b5ae671`, merge `85b133d`, ordinary macOS/Windows and the paired capture collector pass;
both Personal architectures pass initial/replacement windows and update installation. ARM native
execution exposes an outdated Redis capture count and a transient canonical writer refusal while
saving the final SSH trust fixture. Capture checks now require the added actual sidebar proof; the
SSH fixture simulates at most three explicit resubmissions only for `WRITER_BUSY`, preserving
`CONFLICT` failures. SSH/Redis failures remain mandatory gates while independent Git/database checks
continue. The complete native matrix and new Git/connection-row scenarios need a fresh run.

Actual row/header/gap/inset measurements are required in both clients; current-source native
rendering remains pending CI.

Session rows provide the same 22px **Close Session** action and shared close glyph in both clients.
Native actions appear on row hover or keyboard focus, retain their layout space while hidden and
reject pointer hits until visible. Focusing the native button shows its theme-colored focus ring;
Space closes that specific session. Closing a background row keeps the selected session and its
process generation. Busy operations and workspace modals disable the action. Long names use one line
with end ellipsis in both clients, leaving room for the close action; the full name remains in
accessibility text and the existing name control.

The new Personal QA captures `personal-{phase}-sidebar-close-background.png`, focuses the actual
AppKit control and posts Space, then checks the background ID was removed while selection and the
original generation remain. Its mandatory proof rejects stale metadata, missing controls or a
foreground target. Sixteen local Personal policies pass; the native control, mouse-hover rendering
and actual Space action still require this candidate's own Mac execution. A direct model call is no
longer sufficient for the new close-control proof.

At source `689c445d40878906c40314c0018697997b518f02`, tested merge
`c560eaeac79d2cbd790b9b3b60fb04673800cc9b`, ARM macOS 15.8.2 / Swift 6.1.2 stops at a type-checking
timeout in the close-proof dictionary. The candidate splits that construction without removing
fields or assertions. No close-control screenshot was produced at that source; a fresh Mac build and
interaction run remain required.

Section disclosures hide local rows without editing shared data or closing sessions; empty
connection categories retain their add/manage entry. Rail controls follow the interface palette and
active-icon color.

Quick SSH and host search appear inside the SSH section in both All and SSH categories. Filtering
uses name, host and username, ignoring case, and retains selection, sessions and an already-focused
search editor. Native Quick SSH displays the same modal form and parser over the main workspace.
Full workbench integration and visual alignment remain pending.

Agent usage polling waits for catalog initialization, including when polling starts before the
window reload task. Recovering the catalog restarts visible usage refresh without discarding drafts.

Java/Maven, Python and SSH/SFTP open as native tabs in the main workspace. Switching to the terminal
and back retains the same native view, run model, transfers and drafts; closing uses the existing
save/transfer/run guards. Database and Redis use workspace document tabs. Closing a workbench tab
hides its retained client; reopening restores the same WebKit document, connection handles and
drafts. Project changes scope visible panels without retargeting an in-flight request. New terminal
actions return to the terminal, and closing a native panel restores terminal focus.

The isolated `workspace-panels-native.json` scenario captures six actual main-window scenes, clicks
terminal/panel/close controls, checks retained views/documents and preserves terminal
identity/generation. Connection profiles in this integration scene are offline fixtures; the
existing PostgreSQL, Redis, SSH and run suites retain service/lifetime coverage. Linux passes 24
focused content/workbench checks and the production build. New AppKit integration and screenshots
remain pending macOS ARM/Intel CI; no full visual acceptance is claimed here.

Each native split pane has its own session/directory header, 10–32 point font controls, output
search, match-case toggle, match counter and previous/next controls. Escape closes search and
returns input to that terminal; search-field input does not enter the PTY. Missing reverse
selections recover within 1,000 matches; changing the query or closing search cancels recovery, and
long scans yield execution time. An exited local shell can restart from its header, retaining its
descriptor and view with a new process generation.

Both clients use the same explicit restart operation. It requires the current generation, input
control and an exited process; a failed launch retains the old replay for retry. Closing a session
still prevents reopening that ID. Older hosts show an upgrade message before any restart is sent.

Native pane margins now use the selected terminal background. Header labels and controls wrap
individually in their original order as the pane narrows, retaining font/search/status controls and
the 12 px gap before output. Both collectors measure actual left/right/bottom insets, header
position/height and output gap; mismatches reject pairing. Linux stylesheet probes cover nine pane
widths; 14 related frontend checks and 17 paired-evidence policy tests pass. The Swift wrapping
regression and the updated actual windows still require current-source macOS CI.

Read-only/take-control and visible transport/activity errors remain available. SSH restart, pane
dragging and complete toolbar alignment remain in the parity scope.

The native Files inspector embeds the same file tree, Quick open, Project search, inline naming,
context menus and deletion dialogs as the ordinary client. Its header uses the shared Files, Git,
GitHub and working-directory icons. Git and GitHub open in the same tools column, retaining their
documents when returning to Files. Moving tools left or right reorders stable native regions and
retains the mounted WebKit document and query. Deferred pane focus yields to a later explicit focus
change, but returns to the terminal when the previous control was removed and focus fell back to the
window; acceptance checks the actual visible file controls after swapping and restoring split panes.

GitHub and Files use the same translated tool switcher. Switching retains each WebKit document;
returning to Files applies the requested tree/search mode to its retained view. Requests stay bound
to the captured repository/project and reject changed workspace context.

Native Git status/snapshot reads normalize the returned repository root with the same Cocoa
filesystem rules as the selected Files root. This keeps temporary-directory and symlink aliases in
one path namespace without changing draft keys, relative change paths or write guards. Workspace
captures now require actual untracked markers on both fixture files; missing or incorrect states
fail Personal and paired evidence checks. Raw Git/selected/normalized roots remain in the report.

The Linux real Git/Core alias check and 20 file-state/native-transport regressions pass, as do 16
Personal and 26 paired/fixture policies. Two Swift checks cover alias normalization, malformed roots
and actual Core status for selected subdirectories. Their execution and the new actual macOS
markers/screenshots remain pending; the candidate does not yet accept the observed missing colors.

**New PR** uses the shared title/body/base/head/draft form over the entire main workspace, at up to
640px or 92% of its width. WebKit covers only the measured form; native views dim and blur the live
workspace. The tools and terminal remain mounted. Command-W hides the form and retains its literal
draft; **New PR** restores that same document. Cancel and Escape discard it. Without a form,
Command-W with tools focused hides the tools column. Draft-discard confirmation belongs to the main
window; pending CLI operations block closing and quitting until their actual result. The native host
injects the captured root/repository and rejects extra fields, invalid layout and duplicate
submission. Ambiguous create failures retain the warning to refresh before retrying.

At head `efcb4dfa997232d68458374f919a1b45f7d4fe26`, tested merge
`a3fb8fcd7f2785e50a43cbc42687a838aed2186e`, the
[ARM Personal artifact](https://github.com/YondFane/uTerm/actions/runs/43085265725/artifacts/13887612080)
and
[Intel artifact](https://github.com/YondFane/uTerm/actions/runs/43085265725/artifacts/13887922988)
both pass package, initial/replacement windows and the complete SDK installation, including original
host PID exit and endpoint removal. The
[paired artifact](https://github.com/YondFane/uTerm/actions/runs/43085266223/artifacts/13887811848)
contains all 38 pairs and 77 original PNGs. All 76 paired digests and all viewer scenes pass. Both
PR pairs were viewed: title/body/branches/draft, readable fields and centered 640×500 / 588×500
forms agree. English wide and Chinese narrow workspace pairs were also viewed; sidebar
controls/fonts, Git branch/status presentation and other visible differences remain. The native PR
shadow also needs alignment. These source-specific captures do not accept the new sidebar control or
full parity. Full functional acceptance stays false.

The same source's
[Intel native matrix artifact](https://github.com/YondFane/uTerm/actions/runs/43085265868/artifacts/13887393269)
retains a failing file-tools operation: `CONTENT_RENDER` reports a missing file path after the root,
symlink and hidden-file checks. Its GitHub and complete SDK checks pass, but the inspector and final
matrix remain failed. The original `native-inspector-failure.png` was viewed; the source literal
file remains and the copy-target directory is absent. This failure requires diagnosis and a targeted
regression; it is not waived by the successful Personal or paired runs.

Nine focused GitHub/grid checks and the full frontend suite (475 passed, 11 conditional skips) pass,
plus type/build, format, contracts and i18n checks. Context failures offer Retry/Cancel;
language/theme refresh retains literal input, frozen/pending forms cannot close or submit, and a
failed create never retries automatically. Chromium checks at widths 640/900/1100 match the shared
form dimensions within one pixel. These are frontend/CSS checks; the new Swift modal, actual
Command-W/reopen, Escape, quit cancellation and readable narrow fields still require their own Mac
run and ordinary-client paired images.

The shared screenshot grid includes English/dark 1100×720 and Chinese/light 640×720 PR drafts. Both
actual applications use the same temporary repository and isolated simulated CLI, enter the literal
title/body/branches/draft, capture the centered form and cancel without changing saved workspace
data or terminal generations. The collectors reject missing/stale/duplicate scenes, crushed fields,
injected form values, GitHub writes and geometry differing by at least one pixel. Personal repeats
the controls after app replacement. CLI logs and originals are artifacts; fixture responses are
explicitly simulated, not authenticated GitHub acceptance. The grid requires 39 ordinary captures
and 38 pairs (77 original PNGs including restart).

Twenty-five Python evidence/fixture policies and 15 Personal policies pass. They reject a reused
fixture, external/symlink project, old source metadata, 128px PR forms and missing no-write proof. A
real Rust Core process prepares/reads the new CLI fixture on Linux without an account or GitHub
write. Type/build, format, contracts and i18n checks pass. Actual new Mac images remain pending;
760d433's 36 pairs retain their original scope and do not satisfy the expanded grid.

The macOS ARM capture build at head `92bd88e2f0ba0f31d8fd20c02eed45d40229ac7d`, merge
`383f762158b9285bd65d70bfbbe3fe1bfcdca018`, fails because the new collector passed JSON Double sizes
to an Int window-sizing function. The candidate uses exact integer conversion, rejecting fractional
or non-finite dimensions. The
[failed build artifact](https://github.com/YondFane/uTerm/actions/runs/43084143961/artifacts/13885543296)
is retained; no new PR pair was accepted.

The workspace PR implementation itself passes the full ARM native matrix at head
`43b3995769cf7d8c687a2b038e57e3325941488b`, merge `5ff58f2dbdb25a063c222ab99df3852965bb43d1`. Both
original PR images in the
[artifact](https://github.com/YondFane/uTerm/actions/runs/43080810933/artifacts/13885342948) were
inspected: English 1100×720 uses a centered 640×500 form; Chinese 640×720 uses 588×500. Fields are
readable and the live workspace remains around the form. Actual draft, pending/quit, injected-root
and Escape checks pass. The same source's complete SDK installation accepts the update and proves
original host PID exit and endpoint removal. This accepts that source's ARM native QA scope; it does
not accept the new Personal/ordinary capture grid or Intel.

At source `760d433f319a0e95685e7dd4724a8b23b14b07ec`, merge
`6e78c0fd82c2aeb6a760d939e97c420bf3488c1d`, both native matrices pass. The
[Intel report](https://github.com/YondFane/uTerm/actions/runs/43074768464/artifacts/13882499663)
passes real host-trust Cancel/Approve/authentication and the full interaction matrix, including
Files/search/GitHub switching and guarded drafts. The earlier narrow GitHub form remains visually
rejected: those images do not accept the new workspace modal. The previous intermittent Intel trust
failure has not reproduced in this run; no speculative trust workaround was applied.

Files context refreshes discard older replies and errors when a newer mode request exists. A
reordered-response regression fails with the earlier handler and passes with this guard; hidden
Files documents cannot receive the GitHub mode value. The same-source native inspector checks pass.
Git embedding and the other remaining tools still require parity work.

File requests stay on the captured local project or Worktree. Writes first resolve open editor
drafts, then recheck the selected root; cancelled delivery does not release a dispatched write
early. Paste accepts only known project/Worktree source roots in saved workspaces. Native memory
retains the copied source when switching projects or workspaces and replacing the file-tools
document; paths are not saved to disk. A removed source project is rejected even if its files still
exist. Copy updates serialize, and a rejected copy restores the last confirmed source with a visible
error. Clipboard hydration ignores late replies from an older document. Cross-workspace native
execution still requires current-source CI.

Project metadata reads share the main state bridge with settings writes, while filesystem scans stay
on their worker. This avoids the client's own background reads rejecting a font change as
`WRITER_BUSY`; external writer conflicts retain their explicit retry behavior. Native acceptance
refreshes the actual file list while pressing smaller/larger font controls through six cycles,
including after application replacement. Acceptance uses the shared **Refresh files** control and
waits for directory mutation completion, rather than the early dismissal of its confirmation.

Focused Linux WebKit-transport simulations cover the shared controls, exact open path/line, visible
failure/retry, retained search text, language/theme refresh and quit freeze/resume. Native QA
operates actual WebKit tree/search controls and AppKit Return, checks symlink/root/method rejection
and stale-project writes, and creates, copies, renames and deletes literal temporary names,
including cancelled directory deletion. It also copies in one actual panel, switches projects and
workspaces, replaces that WebKit document and pastes into the new project, checking original bytes,
rejected outside-root clipboard values and a removed source whose files remain on disk. Native QA
also operates actual host search and Quick SSH controls, checks invalid/cancelled/stale-workspace
writes, and creates and keeps a temporary connection using loopback port 1 without external
credentials. This exercises failure handling, not authenticated remote login. Linux simulations
exercise queued failures, confirmed-source rollback and stale hydration.
`native-inspector-copy-across-projects-light-zh.png` records the destination panel. Personal
workspace captures require the mounted shared controls and translated labels. These new checks and
screenshots still require current-source macOS CI; simulations do not accept native rendering.

At head `ccdbf1ea0427ac4b37200b63f56808686d4e07f5`, tested merge
`eaa310c912902c2c222175b6b5fafc2fd19933ec`, both Personal architectures pass the full package,
real-window and same-source replacement checks in
[Personal CI](https://github.com/YondFane/uTerm/actions/runs/43037565205). The
[paired artifact](https://github.com/YondFane/uTerm/actions/runs/43037565265/artifacts/13865841147)
contains 32 matched pairs and the ordinary restart image; all paired image digests were checked, and
both English/dark workspace originals were inspected. Full-height files controls align, while
terminal insets, native control styling and other parity rows still differ. The
[native ARM report](https://github.com/YondFane/uTerm/actions/runs/43037565487/artifacts/13865611496)
passes actual pane swap/zoom/close focus and cross-workspace paste with removed-source rejection,
then fails SSH search-focus acceptance. That failure does not accept Quick SSH or the full native
matrix. New PDF and search-focus changes require their own current-source CI.

Editable files open in the main workspace. When files are open, the tab row includes the selected
terminal, ordered file names, unsaved indicators and close controls. Reopening selects the retained
WK editor; returning to the terminal retains its view and generation.

Left/Right and Home/End move between tabs. Editors receive focus after their AppKit view attaches,
and keyboard tab navigation retains tab focus. Dirty close, repository operations and quit
preparation keep the existing editor confirmation and conflict guards.

Font shortcuts in file editors and Git diffs adjust their own saved content size through the scoped
content channel. Invalid or stale events are ignored; save failures remain visible and can be
retried. Command-F in an active file stays in its editor rather than revealing the terminal.

Standalone previews and detached regression windows retain separate presentation. Persistent
tab/window restoration, wrapping, embedded workbenches and complete settings styling still require
alignment.

The toolbar footer and app menu open complete settings. Save/reload/reset and unsaved drafts remain
available when the settings window is hidden; Return saves an edited draft and Command-W hides it.
The local CLI control switch remains an immediate service control in Local control.

Candidate capture records the contract SHA-256, actual toolbar height/top position and responsive
side/tool widths in both real apps. Collection rejects stale vectors, old height, titlebar insets or
stale panel widths. Linux passes 463 Node checks (11 platform skips), type checking and focused
SVG/side-panel regressions; these do not establish complete native parity.

Real Personal-window checks click file/tab/close controls, send AppKit arrows, retain exact
recovered Unicode drafts with existing autosave, cancel a dirty close and discard one file while
retaining its sibling and external bytes. Packaging requires its source-bound report and
`personal-<phase>-embedded-files.png`.

Native menu shortcuts preserve Shift for letter chords: Command-F opens terminal search and
Command-Shift-F opens project search. The custom shifted palette shortcut rejects the unshifted
event. Synthetic AppKit events retain Shift in `charactersIgnoringModifiers`, matching actual letter
events; reports retain the live menu binding. These event-routing checks still require
current-source native execution.

Another real-window check clicks font controls and their bounds, types Unicode into native search,
checks case/match navigation, exercises Command-F/Escape and restarts an exited shell. Packaging
requires its source-bound report and `personal-<phase>-terminal-search.png`. The restarted shell
must reach the same writable condition used by its input entry point before QA sends the output
probe.

Linux restart tests exercise actual PTYs, rejected stale generations, read-only/live-process
requests, failed-launch replay, closed-session history and an old-host capability probe. The Core
end-to-end check verifies writable output after restart with unchanged workspace descriptors. The
ordinary collector explicitly loads the measured font size and waits for the document font set
before checking readiness and character width; failures retain the requested face statuses.
Ordinary-window QA also clicks the actual Restart button and verifies a new generation, parsed
Unicode output and the retained terminal element. Current-source macOS execution remains pending.

The ordinary capture contract requires all 32 matching workspace/settings scenes plus one
`terminal-restart` scene. Missing, duplicate or unknown scenes and incomplete restart assertions
fail; the paired artifact includes the 64 matching PNGs and the additional restart original.

JDK acceptance waits for the live Add control after rejected input before clicking it. Sidebar
acceptance checks actual section order and disclosures while retaining shared revision, selection
and generation; Agent acceptance also exercises polling before catalog loading. These candidate
checks, Swift vector geometry and complete real-window acceptance still require the latest macOS CI;
earlier-source results cannot accept new code.

Session context menus add pin/unpin, move up/down, Group with, Ungroup and Copy session link.
Grouping existing sessions and ungrouping select the moved session while retaining its descriptor,
PTY generation and terminal view. Reordering stays within the same roster, Worktree and pin group;
local sidebar drags capture a revision and reject external sources or stale writes. Native menu QA
checks pin/order/group/ungroup and a racing settings write, and captures
`native-session-ungrouped.png` and `native-session-grouped.png`. Shared-core tests cover nested
layouts, scope failures and reopen; an actual native drag gesture and current-source screenshots
remain pending. Linux passes 448 Node regressions (11 platform skips) and 236 shared-core tests (17
explicitly ignored), including five session tests and the Rust/TypeScript grouping comparison.

Projects show their sessions and Worktrees as nested rows. Use the project disclosure control or
context menu to collapse children while their terminals keep running. The context menu includes
rename, pin/unpin, move up/down, move to another workspace and removal of an empty project. Manual
project order supports local dragging within the same pin group; name sorting disables manual
reordering. Pinning, collapse and order write shared state with revision checks. The workspace menu
adds create/rename/delete; deletion is available only for an empty workspace when another remains.
These candidate interactions require their new native CI checks; drag acceptance remains pending.

[Two-client acceptance](native-ui-parity.md) covers the full matching scope, including remaining
checks for drag/group operations, layout persistence, content tabs and workbench integration. Both
screenshot collectors share project data and collect matching language/appearance/size grids. PR CI
assembles their same-source original PNGs and comparison reports in a downloadable artifact; source,
OS, architecture, fixture hash and scene mismatches fail collection. Native window-owned commands
remain available while complete settings blocks external CLI writes. The candidate still requires
same-source paired screenshot acceptance; Linux regressions do not establish complete functional or
visual parity.

Real-window CI prepares a display of at least 1280×900 before the matching screenshot grid; the
required 720-pixel content height is still checked against actual window bounds. Personal smoke
failures retain the raw report and available original captures before validation, including an
attempted failure-window capture. The ordinary collector waits for real terminal input ownership
before inspecting the host. Linux passes 12 Personal package/evidence policy tests and 13
paired-evidence policy tests; these fixtures do not represent native window execution.

The Personal collector adjusts the real window frame against measured content bounds, with at most
five attempts and recorded geometry. It also executes the project context menu and disclosure
control, checks durable pin/collapse/order, rejects a stale reorder after a settings write and
verifies the selected terminal generation remains unchanged. Both clients use the same literal
workspace name as well as matching project data.

Settings use left-side categories for General, Appearance, Terminal, Workspaces, Shortcuts, Agents,
Usage, Local control, Database components, Maven settings, Java development tools and Software
updates. Appearance includes file font/tab preferences; workspace management offers shared
create/rename/delete operations. Agent commands/hooks and quota open their existing complete native
window. Java development tools has a standalone section; its source-bound native checks are recorded
under Optional JDK and Maven tools.

Interface and terminal font selectors share the ordinary client's preset catalog and localized
labels. Existing custom font strings remain a selected custom entry until a preset is chosen; simply
opening or switching categories does not replace them. Selection retains the exact fallback-family
string, and the existing settings save/conflict rules apply. Native QA checks both actual AppKit
selectors, custom draft retention, no implicit write and a save/read round trip; it also captures
`native-settings-custom-font.png`. Current-source macOS execution is still required.

The toolbar includes file opening, the command palette, pane zoom and a tools menu for files/search,
Git/GitHub, Java/Python, SSH, database and Redis entry points. Commands retain their existing focus,
busy-state and selected-project guards.

The same-source comparison includes 24 settings navigation pairs: twelve shared categories at
English dark 900×640 and Chinese light 660×640. Both collectors activate actual navigation controls
and reject missing/stale captures, changed drafts or unverified navigation. The combined artifact
holds 64 matching PNGs and the ordinary restart original; collection does not establish complete
functional parity. The sidebar updates existing disclosure buttons when busy state ends, so
persisted collapse does not leave expansion disabled.

**Settings → Maven settings** edits global distribution, Maven home, `settings.xml`, local
repository and Wrapper preference without requiring a project. Changes remain a draft until **Save
Maven settings**; global saves preserve project overrides. On a concurrent configuration change, the
draft stays visible and an explicit reload reads the current values. Hiding settings retains this
draft, and quitting guards unsaved Maven changes. Native reads use an independent bridge so JDK
discovery does not serialize terminal input. Display preparation uses a login-session configuration,
and a second process verifies both CoreGraphics and AppKit bounds in `display-verified.json` after
the configuring process exits.

Candidate QA presses the actual Maven navigation/save controls, verifies exact literal paths and
unchanged project configuration, rejects a stale global save and captures
`native-settings-maven-conflict.png`. Matched Maven scenes must show loaded controls matching the
shared defaults. These new native checks still require CI execution.

**Settings → Database components** lists detected Java and the driver catalog. Install/resume,
manual HTTPS download, offline import, uninstall confirmation and local Java selection use the
existing shared component service. Existing connections prevent component changes; active downloads
show progress and can be cancelled. Opening the page does not download packages. Read failures have
an explicit refresh action, and an obsolete hidden-page read cannot replace a newer result.

Saving or removing a database connection can proceed while its component catalog is being read.
Mutating component operations, live connection use and revision conflicts retain their existing
protection. The profile guard regression checks a suspended catalog read alongside install/import,
remove, Java selection and cancellation. SSH QA waits for parsed, writable remote-shell readiness;
Windows updater QA validates and explicitly selects its isolated CI Java runtime before launching.
Linux passes 445 Node regressions (11 platform skips), 237 core tests (17 ignored), six FFI tests,
18 backend tests (one ignored) and 28 macOS/evidence policy tests, plus type/build/format/i18n/docs
checks. The ordinary screenshot harness inherits the production main-window chrome before overriding
its isolated identity and size, retaining the actual 720-pixel viewport. Failure reports include
measured viewport geometry. Native SSH QA also waits for an authenticated remote prompt before
key/password session input; PTY ownership alone does not prove authentication. Screenshot scene
names retain ASCII locale letters and numeric dimensions while rejecting path separators, dots,
streams, empty names and names over 50 bytes. The ordinary screenshot runner validates the exact
workspace/settings scene names derived from the shared fixture at both phase and full-grid exit;
missing, duplicate, substituted or extra scenes fail, including the old three-scene fallback. All 20
QA-enabled backend tests pass (one ignored). Current-source platform reruns are still required
before publishing.

The settings page and existing database workbench receive component events from one shared event
drain. Candidate native QA checks read-only catalog rendering and captures
`native-settings-database-components.png`; the PostgreSQL fixture checks that a verified import
notifies both the native observer and actual WebKit window. At source `d44086b`, both Personal
architectures and the native matrix failed compilation because the component view exceeded Swift
type-checking limits. The candidate splits that view into smaller expressions; these new
interactions still await complete current-source macOS execution. At `72c168b` (tested merge
`6783ae0`), ARM compiled and passed 43 Swift tests, then captured 21 settings scenes. The collector
failed by clicking the next navigation while a repeated Maven read disabled it. It now waits for the
actual button to become enabled and checks loaded controls after window layout. Maven settings reuse
an already loaded draft until explicit reload. The incomplete run remains a failure.

#### Configure personal updater signing

Run these commands locally from the checkout, using a new key directory outside the repository. Keep
an offline backup of the private key. Do not paste it into issues, logs or chat; losing or replacing
it requires a manual bootstrap installation for clients that trust the previous key.

```sh
node scripts/personal-updates.mjs keygen "$HOME/uterm-personal-update-key"
gh secret set PERSONAL_UPDATER_PRIVATE_KEY --repo YondFane/uTerm < "$HOME/uterm-personal-update-key/private-key.txt"
gh variable set PERSONAL_UPDATER_PUBLIC_KEY --repo YondFane/uTerm < "$HOME/uterm-personal-update-key/public-key.txt"
```

The private key is a base64 Ed25519 seed, and the public variable is a base64 32-byte public key.
They are separate from the existing Tauri signing credentials. The release workflow checks the pair
before building, embeds only the public key, verifies both architectures' exact source and package
evidence, signs their ZIPs, and updates the personal feeds only after public archive verification.
Missing or mismatched signing configuration fails the release instead of publishing an unusable
personal feed. Production releases require this configuration; PR verification packages use
temporary test keys.

#### Build and validation

On a Mac with the documented Node/pnpm, Rust and Xcode tools, run
`bash scripts/macos-native-build.sh personal`, `bash scripts/macos-native-test.sh personal`, and
`python3 -B scripts/macos-personal-package.py --smoke` in a graphical session. Without
`PERSONAL_UPDATER_PUBLIC_KEY`, local builds retain manual updates and cannot initialize Sparkle,
even with injected feed metadata. Set this public key to build an updater-enabled app. QA command
arguments remain disabled in personal executables; tests use an owned temporary embedded profile.

The **macOS personal packages** workflow uses an ephemeral test key for PRs and the configured
public key for release builds. It retains reports, original window captures and verification
packages for 90 days; these artifacts require GitHub sign-in. PR packages use a test key and are for
verification, not the production update channel. Run
`python3 -B scripts/macos-updates-smoke.py --personal` to exercise the actual personal SDK with
loopback feeds. It verifies Node-generated signatures with Sparkle's official signing tool and
covers good/bad signatures, architecture/channel/version rejection, cancel, offline/interrupted
retry, automatic checks/downloads, installation and profile/session retention. User decisions are
simulated; SDK downloads, signature verification and app replacement are real.

Current Linux checks passed 11 signing/release tests and 14 macOS packaging/capture policy tests.
Windows-drive regression coverage checks a checkout on D: with key storage on C:, while still
rejecting checkout descendants. The full Linux suite passed 444 tests with 11 platform skips.

Native source head `647b3d77d9c3b23bdd2ec0dd04dd9b9cb9795596`, tested at PR merge
`d783fab0b707f77ae8f0998a1453d1787e545c52`, passed 43 Release Swift tests, app packaging and exact
English/Chinese no-update status checks on both ARM64 macOS 15.8.2 and Intel macOS 15.7.9 using
Xcode 16.4, Swift 6.1.2 and Rust 1.99.1. The
[native verification](https://github.com/YondFane/uTerm/actions/runs/42591096958) passed all 10
actual SDK scenarios on each architecture, including actual automatic install-on-quit and
installation with profile, drafts and terminal session retention.

[ARM64 evidence](https://github.com/YondFane/uTerm/actions/runs/42591096958/artifacts/13663280744)
and
[Intel evidence](https://github.com/YondFane/uTerm/actions/runs/42591096958/artifacts/13662381794)
contain `personal-package.json`, `updates/sdk-summary.json`, per-case reports and original captures.
`personal-initial-settings-zh-Hans-light.png` shows the Chinese automatic-update setting and current
status; `personal-initial-settings-en-dark.png` covers English and dark appearance. The ARM64
package hashes and source identity were independently checked, and its settings screenshot was
inspected.

The automatic smoke case waits for cycle completion, an idle updater and the actual scheduling
callback before checking opt-out. Prepared installation alone cannot complete this wait, and the
90-second deadline is unchanged. Reports record `completedSDKCycleAndSchedulingBeforeOptOut`; the
Python verifier requires it alongside actual scheduler and opt-out evidence. Both native runs passed
this correction. The minimum remains macOS 14.0; runtime coverage is 15.x. Apple
signing/notarization and the full stable native cutover remain separate.

DMG creation records full tool output and retries explicit DiskImages busy responses or silent exit
code 1, with at most five attempts and the existing 120-second timeout. Only this attempt's partial
image may be removed. Invalid arguments, timeouts and checksum verification errors remain failures;
verification does not retry silent errors. The new regression covers silent creation recovery,
exhaustion and non-retryable verification. The personal workflow runs all 14 macOS Python policy
tests. The corrected creation, image verification, real-window checks and all ten SDK scenarios
passed on both native architectures at the source and tested merge listed above.

### Native macOS QA client

An experimental native SwiftUI/AppKit QA application is built separately from the shipping Tauri
client. It requires macOS 14.0 and uses the isolated identity `sh.uterm.desktop.qa.native`. The
development implementation connects the shared workspace/session operations to native lists, a
hideable sidebar, a 40pt toolbar, basic language/appearance/font settings and cached SwiftTerm
terminal views. A bundled standalone Rust helper owns real PTYs; quitting detaches, whereas **Close
session** matches the selected generation before terminating it; a missing or stale generation
requires reconnecting before close. Splitting and selecting sessions preserve each terminal view.
Reconnecting replays retained output with the existing process generation.

SwiftTerm 1.20.0 is pinned for Xcode 16.4 compatibility. Output crosses the C ABI as binary frames,
with one unacknowledged frame per attachment and a bounded Swift queue. Swift decodes sequence and
activity sequence as `UInt64` and encodes acknowledgements without passing through `Double`.
TypeScript uses generated `bigint` sequence fields and preserves integer tokens before JSON can
round them. Acknowledgements use legacy safe numbers or exact decimal strings, both validated by
Rust up to u64::MAX. The host binary frame format is unchanged. Boundary tests cover actual values,
not only type names. Native and legacy platform CI passed this precision change at head
`d3dcd09a69bcdd66798e2f4aaa4b67b99187cf77`, tested merge `3a012173e7f27639c7dbe40188354b8348c1affa`
([native](https://github.com/YondFane/uTerm/actions/runs/41422419793),
[legacy](https://github.com/YondFane/uTerm/actions/runs/41422419819)).

The Unix slow-consumer regression holds one unacknowledged real PTY frame, rejects an incorrect ack,
then checks 1,000 Unicode records in order. A detached attachment cannot ack its replacement. After
90,000 rows exceed the host's 1 MiB raw history, recovery explicitly resets to the bounded retained
screen; it does not promise unlimited raw history. Native QA additionally injects 150 ms before
SwiftTerm consumption, executes the native sidebar menu while output waits and renders and
acknowledges over 113 KB. These cases passed on both Mac architectures at the source below. The
controlled delay tests correctness, not performance gains. Windows retains its existing regression
suite; this Unix load scenario does not run there.

#### Isolated candidate packages

After the native QA build, `bash scripts/macos-candidate-package.sh` creates an
architecture-specific App ZIP and read-only DMG. It audits the app/helper architectures, minimum OS,
ad-hoc signatures, dependencies and read-only resources, then mounts the image and installs into a
private temporary Applications directory. The installed app starts its bundled helper, renders real
Unicode PTY output, explicitly closes the fixture session and stops the idle host before removal.
The native QA version remains the bundle's recorded `0.0.1`; this is not a stable release package.

The image checksum verifier retries only explicit temporary-busy responses, up to five attempts;
each exit code and diagnostic remains in the report. Invalid images and exhausted retries fail.
Three Linux simulations cover busy-then-valid, invalid images, persistent busy and timeout. The
79872ba ARM candidate failed its original busy response; the unchanged report remains in
[artifact13543080480](https://github.com/YondFane/uTerm/actions/runs/42295306002/artifacts/13543080480).
Actual image creation, checksum validation and installation still require the macOS run.

The candidate wrapper disables Python bytecode writes so importing its image verifier cannot create
an untracked `scripts/__pycache__` before the clean-source gate. At source `6ef8dba`, both Mac
upgrade/rollback jobs passed all seven scenarios, and Intel passed the 37 Swift tests and 21 real
content assertions. Its later candidate and interaction gates correctly failed on that generated
cache;
[the original artifact](https://github.com/YondFane/uTerm/actions/runs/42305932312/artifacts/13546679529)
remains unchanged. The wrapper correction requires a fresh native CI run; these partial results do
not claim that the entire native workflow passed.

On Windows, `./scripts/windows-candidate-package.ps1` builds a current-user QA NSIS installer with
embedded WebView content and production deep links disabled. It installs into an owned temporary
directory, checks the x64 executable and read-only resource files, runs the installed real app,
captures its owned HWND, and uninstalls. Only the isolated `sh.uterm.desktop.qa.sharedstate` profile
is redirected; private data remains until fixture cleanup, and production protocol/uninstall
registry fingerprints must stay unchanged. The QA installer requires the CI image's existing
WebView2 runtime. Its resource attributes are restored by QA-only install/uninstall hooks.

Both checks archive SHA256 sums, exact source head/tested merge SHAs, platform/toolchain evidence,
installation reports, logs and original window captures under `candidate/`. Source
`8aacbb3b09925fe16f2bda24e66563eed9f27a31`, tested merge `0e9a3aa9c1d10b4ecad0127e922df760fcf195cc`,
passes candidate installation on macOS arm64 15.8.2, Intel 15.7.9 and Windows x64 NT10.0.26100. All
five actual package hashes were independently recomputed and the three original installed-window
captures inspected. Mac uses Xcode16.4, Swift6.1.2 and Rust1.99.1; Windows uses Node24.22.2,
pnpm11.22.0, PowerShell7.6.9 and Rust1.99.1. Reports, artifacts and the exact checks are linked in
[#44](https://github.com/YondFane/uTerm/issues/44#issuecomment-6686879466), now accepted on the task
branch. At that candidate source, separate #41/#45 checks failed; candidate success is not an
overall workflow pass. #41 is separately accepted at source949e4c2; #42/#45 are accepted at
sourceec1a49d, with the simulation/manual-waiver boundaries in their completion comments.

Native Apps are ad-hoc signed, their Sparkle framework retains its vendor signatures, and neither
Apple Developer signing nor notarization is available. Windows candidates are unsigned; these base
candidates have no updater signature. Windows candidate identity compares every executable byte
after Tauri's single expected `__TAURI_BUNDLE_TYPE_VAR_UNK` to `__TAURI_BUNDLE_TYPE_VAR_NSS`
transform. Missing/duplicate markers or any other change fail. The Candidate Windows QA workflow
runs this installer scope independently. Source-bound signed private SDK fixtures and upgrade/data
rollback evidence are accepted in #45/#46; stable cutover remains gated by #47. These checks do not
publish or change production sources.

#### Reproducible client measurements

The Client performance evidence workflow runs native and Tauri clients sequentially on the same Mac,
with three repetitions per client, and records a separate Windows Tauri baseline. Version4 of
`shared/fixtures/client-performance.json` fixes one real PTY, a 120×30 grid, 14pt text and
5,000-line scrollback. Both clients use their ordinary renderer-to-PTY resize paths; a mismatched or
clipped grid fails the report. Twenty cycles exercise 1,024 ordered ANSI/Unicode records, 64KiB CAS
file save/read and actual attachment replay without replacing the process generation. The first five
cycles are excluded from latency summaries.

The workload also includes twenty synthetic alternate-screen TUI redraws, an actual consumer delayed
by 200ms per frame, and twenty real PostgreSQL queries through Core/JDBC. Each query verifies 128
rows of ordered text containing 128 ASCII characters and Unicode. An initial render gate holds a
real frame for at least 50ms; another frame or premature acknowledgement fails the slow-consumer
check. The gate is released before draining and checking all 1,024 records. These are controlled
terminal redraws, not an interactive Vim benchmark; query timings include row serialization, not
table painting.

After the native build, run `python3 -B scripts/client-performance-database.py` (`python` on
Windows). The wrapper owns one loopback PostgreSQL cluster across all sequential measurements,
supplies private credentials to the client runners and invokes `scripts/run-client-performance.sh`.
It verifies the original database fixture remains unchanged, connections close, the owned server
stops and evidence contains no credential. `node scripts/client-performance-report.mjs` audits all
three repetitions. The inner native/Tauri runners require the wrapper's private database context.

The comparison report records a clean-source check and three equal elapsed-time idle windows. Both
consecutive median RSS increases above the larger of 16MiB or 3% of initial RSS flag growth and fail
the measured-scope acceptance. Sparse/empty or nonmonotonic samples fail analysis. This detector
does not establish multi-hour leak freedom. Per-metric medians across three repetitions record
native slowdowns above 10% and 1ms as explicit #13 profiling follow-ups; they are not hidden behind
an aggregate improvement claim. `performanceAcceptanceComplete` applies only to this fixed one-PTY
workload and bounded observation, while stable cutover remains a separate gate.

macOS may report a zero-RSS descendant while the owned app and host remain resident. The analyzer
retains and counts those records, requires nonnegative per-process RSS and a positive aggregate, and
still rejects empty/all-zero samples. Source `79872babd29afe81815bf29ee7ec103bda6e955e`, tested
merge `a540065570287b0d7bf6798612fc56405dad1382`, passes all 15 workloads across ARM, Intel and
Windows; raw trends, cleanup and original windows were inspected.
[#43 acceptance](https://github.com/YondFane/uTerm/issues/43#issuecomment-6696979756) records
commands, machines, artifacts and scope. Native bulk, replay and database regressions remain
explicit
[#13 profiling follow-ups](https://github.com/YondFane/uTerm/issues/13#issuecomment-6696879766),
with no whole-app improvement or multi-hour leak claim. Newer source runs keep their own provenance.

Idle sampling lasts 120 seconds in each of the first two repetitions and 600 seconds in the last.
Raw samples, per-cycle metrics, source/workload hashes, original terminal/TUI windows and cleanup
reports are archived as CI artifacts. CPU/RSS cover the app, its descendants and the authenticated
host tree; unattributed WebContent/GPU/XPC processes and the external PostgreSQL server remain
excluded. Setup and screenshots use separate phases. Resource phases still include warm-up and
instrumentation costs, and summed RSS is not proportional memory. Native input uses
NSTextInputClient; Tauri uses DOM paste/Enter in the real app. Response timing ends at parsed-output
acknowledgement, not physical keyboard/display latency. A ten-minute sample does not establish
multi-hour leak freedom.

#### Measurement validation

Local report tests reject stale source/workload, imprecise sequence, missing rows/TUI samples,
insufficient soak, missing slow-consumer evidence and unequal grids. Source-specific version4
Mac/Windows results and acceptance remain in [#43](https://github.com/YondFane/uTerm/issues/43); no
improvement percentage is claimed. Earlier workload versions are not accepted as version4 evidence.
Native fitting records each actual window/view/grid attempt. The ARM CI display remained capped at
684px even after CoreGraphics reported a larger mode; those failed runs are retained. Version4 uses
the same 120×30 grid on all clients, fitting the original CI desktop without changing screen modes,
fonts, workload volume or clipping checks. Windows receives the real Git Bash path and handles Git's
mingw64 layout. SQL orders the numeric series through a distinct output alias. Corrected platform
measurements require the exact source-bound reports in #43.

The c24d81a Intel run reaches the real 120×30 grid and completes its first native/Tauri pair; the
second native workload completes but its coordinator checks the endpoint before asynchronous host
exit finishes. That failure remains in
[artifact13538810238](https://github.com/YondFane/uTerm/actions/runs/42282798481/artifacts/13538810238).
The native coordinator now waits up to ten seconds for both endpoint removal and the authenticated
fixture PID to exit, without terminating it or relaxing workload checks. A real child-process test
covers delayed unlink/exit; another checks that timeout never kills a running process. Mac
acceptance uses fresh per-source CI and the limits recorded in #43.

At sourceb904eaf the full Linux frontend regression passes 433 tests with 11 explicit skips. The
retained partial Intel v3 data shows slower native bulk output and database queries; the latter
includes the native adapter's asynchronous completion polling. These are recorded regressions, not a
claim that polling alone explains the difference. Two-minute RSS observations are stable, while the
current v4 comparison and longer-trend evidence are maintained in #43. Exact old-source numbers and
limits are in [#43](https://github.com/YondFane/uTerm/issues/43#issuecomment-6694081032).

The Windows contract test now waits for its Core process and streams to close before deleting owned
data, with bounded retries for released Windows handles. A failed preceding desktop step still
produces an interaction-matrix failure report instead of losing it to a missing directory. These
failures remain failures; retrying cleanup does not convert skipped scenes to passes.

Explicit detach releases its authenticated input lease before returning, including when the old
consumer is blocked. A per-link lock prevents late heartbeat/takeover from reclaiming a stopped
view; old cleanup cannot release its replacement. The real-host blocked-consumer regression passes
locally. Performance settings are seeded before shared-state initialization; QA observers retry
bounded read-only observations on writer contention, without retrying mutations. Capture selects
only the owned QA window and fails if that window cannot be captured. These checks preserve actual
failed runs rather than replacing their images or treating earlier timings as a comparison result.

#### Native QA validation

Migration acceptance remains open in [#13](https://github.com/YondFane/uTerm/issues/13). M3 #17 was
closed at the user's direction, retaining persistent-layout/PDF-mark and Windows run-panel/picker
coverage gaps. Database, Redis, Agent and settings acceptance is recorded in #38–#41. #42
interaction recording is accepted with labelled simulations and user-waived final human checks. M4
source-specific performance results and remaining scope are tracked in
[#43](https://github.com/YondFane/uTerm/issues/43) and the
[phase tracker](https://github.com/YondFane/uTerm/issues/18). M5 packaging #44 and updates #45 are
accepted; actual upgrade/rollback evidence and final gate results are maintained in
[#46](https://github.com/YondFane/uTerm/issues/46),
[#47](https://github.com/YondFane/uTerm/issues/47) and their
[phase tracker](https://github.com/YondFane/uTerm/issues/19). Original implementation gaps remain
visible and prevent a stable-cutover claim.

Redis paging, deletion, TTL, quit-cancellation and OS-credential checks are accepted at source
`940f8d1`, with platform reports and screenshots in
[#39](https://github.com/YondFane/uTerm/issues/39). Work remains on `feat/native-macos-shared-core`
in [Draft PR #12](https://github.com/YondFane/uTerm/pull/12), without merging or publishing a
release.

Head `4c502ab0c5f39b1d4f43ec4e72f0c7f35b285cca`, tested merge
`df2690d89433974653ff5426bab07be371f455c7`, passed all four jobs in
[native CI](https://github.com/YondFane/uTerm/actions/runs/41468220264) and
[legacy CI](https://github.com/YondFane/uTerm/actions/runs/41468220189). Native execution used macOS
15.8.2 ARM64 / 15.7.9 Intel, Xcode 16.4, Swift 6.1.2 and Rust 1.99.1. Windows Server 2025 x64 and
legacy macOS ARM64 passed frontend, core/FFI/contracts, host, backend, format/docs and desktop
checks. Native QA uses temporary projects/data/hosts and `sh.uterm.desktop.qa.native`; Tauri QA uses
`sh.uterm.desktop.qa.sharedstate`.

Real native checks cover Unicode/ANSI/alternate screen, retained split views, sidebar arrow-key
focus, native Settings menu/Return, wide/narrow windows, language/theme changes, sidebar hide, full
screen, ordinary quit/relaunch with retained generation/replay and generation-matched close. The
toolbar measures 40pt. Original NSView cache images omitted compositor layers and are excluded;
current screenshots use WindowServer.

Native Settings offers **Allow local CLI control** through a normal AppKit checkbox and displays the
explicit data directory. The shared authenticated loopback service passes bundled CLI status/list/
new/focus/send/close, modal-write rejection and queue draining. Accepted connections explicitly use
blocking mode with bounded timeouts; completed storage transactions unlock even if a copied
descriptor survives PTY creation. Canonical Windows file identity avoids restarting an unchanged
idle host. Table selection/focus deferral avoids NSTableView delegate reentrancy; current smoke
rejects that warning.

`pnpm test:legacy-host` compiles the unchanged recorded release
`4f10848868ac09a3667e140938c345b265f9dd58` helper with its lockfile and a separate target. All four
jobs verify binary replay/ack, literal input, active PID/generation preservation, detach and idle
upgrade only after explicit close. Source and binary digests stay unchanged. A separately labelled
incompatible endpoint fixture verifies refusal without replacing the host or endpoint; it is not a
historical incompatible binary. The native helper and QA App are ad-hoc signed and checked with
`codesign --verify --deep --strict`. Formal signing/notarization and installer upgrade/rollback are
separate, unaccepted gates.

Artifacts are
[ARM](https://github.com/YondFane/uTerm/actions/runs/41468220264/artifacts/13154462292),
[Intel](https://github.com/YondFane/uTerm/actions/runs/41468220264/artifacts/13153229460),
[Windows](https://github.com/YondFane/uTerm/actions/runs/41468220189/artifacts/13154148989) and
[legacy Mac](https://github.com/YondFane/uTerm/actions/runs/41468220189/artifacts/13154152640). They
contain head/tested merge, platform/OS/architecture/toolchain, reports, logs, actual system window
screenshots and the native QA App. Images include the empty window, eight language/theme/ width
scenes, sidebar hidden/full-screen/settings, `native-terminal-slow-consumer.png` and two
`native-control-*.png` files. ARM load/narrow/full-screen/control, Intel narrow/control and Windows
Tauri control images were visually inspected. Tauri's 12-scene save/recovery/control report passed
without cleanup errors.

M0 #14, M1 #15 and tasks #20–#30 are accepted, unmerged. M2 #31/#32 use the user-approved simulation
scope described below; their source-bound results and acceptance are tracked in the Issues. Real
provider tasks, manual IME/clipboard/mouse and physical sleep/multiple-display checks remain
unexecuted under the authorized simulation/manual-waiver boundaries. Persistent layouts/PDF marks,
full Windows run-panel/picker coverage, multi-session/multi-hour performance, macOS 14 runtime and
stable-cutover conditions remain uncovered. Automatic native actions are not human acceptance;
Windows and legacy macOS retain the existing full feature set. See
[native migration status](native-migration.md) and Issue comments for evidence and unexecuted steps.

The native terminal smoke launches installed `/usr/bin/vim` in the actual PTY. Native key events
enter/leave insertion, `NSTextInputClient.insertText` supplies Chinese/combining characters/emoji
and the native `paste:` action uses the system clipboard with actual bracketed paste. The renderer
leaves automatic terminal negotiation replies to the shared host; keyboard, paste and CLI input
remain distinct. [Native CI 41834172198](https://github.com/YondFane/uTerm/actions/runs/41834172198)
passed both macOS 15.8.2 ARM64 and 15.7.9 Intel at source `1fd91cf7422b34546440e21ddadd4d69361db457`
/ tested merge `dde20cbbf9d35c3dd0885148ad5ad1edf90b0276`. Each run verifies the exact 44 saved
UTF-8 bytes, alternate-screen return, same view/generation and resumed shell; 35 renderer-reply
bytes are suppressed. Artifacts contain `vim-toolchain.txt`, `native-vim-edit.png`,
`native-vim-saved.txt` and `terminal-live.json.realVim`; both real Vim captures were inspected.
[Reports and the retained initial failure](https://github.com/YondFane/uTerm/issues/31#issuecomment-6631702456)
distinguish scripted native input from unexecuted manual IME, actual Agent CLI and performance
acceptance.

### Shared input and size control

When another current client owns a session, its terminal shows **Read-only attachment** and a **Take
input control** button. Reading, selection and copying remain available. Explicitly press this
button to move input and window-size control to this view; focusing a window never takes control.
Passive views follow the host grid without resizing it. Losing control discards queued input,
including clipboard data, so it cannot be sent after a later takeover. Both clients wait for the
first host frame before enabling input or sending size changes, so a new passive attachment cannot
race its initial control metadata. Task logs remain readonly and do not show takeover controls.

The development host/Core assigns one input/resize lease per live session generation. Other
attachments keep reading and acknowledging output. Explicit takeover revokes previous writes and
resizes; a late release cannot revoke the new owner or a replacement generation. Releasing or
closing a client detaches its control without stopping the process. A 30-second lease expires if
renewal stops; the stream renews every five seconds even while waiting for rendering
acknowledgement.

A concurrent claim causes a pending read to reread its original cursor with current control state,
with a bounded retry count. Input is never replayed. Current host support is detected explicitly;
unmodified old hosts keep their existing behavior and do not gain control arbitration retroactively.
Rust generates the optional control metadata for Swift/TypeScript; raw terminal bytes and exact u64
sequence/ack representations remain intact.

Linux checks use a real isolated host, independent TCP/Core clients and a PTY. They cover takeover,
rejected old input/resize, passive output/ack, late release, stale generation, detach/quit, same
process/generation reattachment and exact close. A TCP gate delays an old readonly request until
after takeover and verifies that its response cannot overwrite the new control state. Clock-driven
policy checks cover expiry/renewal and legacy fallback without waiting for the lease in real time.
`input-control-host.json`, `input-control-core.json` and test logs retain source/platform metadata;
CI runs host checks before unrelated Java task checks. Pull-request CI continues independent
contract, build and real-app checks after a Core test failure, then explicitly fails the job; the
original failing log and additional artifacts are both retained. Direct branch checks still stop at
the failed Core step. Native CLI sending uses the current app attachment and its existing lease; it
cannot implicitly take over another client's control. A real host regression checks accepted CLI
input, rejected input after takeover and stale-generation refusal.

An explicitly confirmed idle helper upgrade waits for both endpoint removal and release of the old
process's OS lock before starting its replacement. Deterministic OS-lock regressions cover the gap
between those events and a bounded timeout without stealing a live lock. A successful probe
explicitly unlocks before returning, so a descriptor inherited by a concurrent PTY fork cannot
retain the probe's lock and block the replacement host.

The duplicate-descriptor regression reproduces the former retained lock and passes with explicit
unlock on Linux, together with all three shutdown-lock checks and ten host integration tests. The
Intel `3990ebf` CI failure in idle-host replacement is retained: its new mock CLI test passed, but
the job failed before native window smoke. Platform acceptance of the unlock fix requires its own
source-bound CI evidence in #32.

The shared u64 fixtures also carry owned/passive/unowned metadata through the real Rust encoder and
Swift/TypeScript decoders; malformed roles are rejected without rounding sequence or acknowledgement
values.

The native ownership wrapper checks Git source cleanliness before launch and after each process,
matches both embedded source identities, then records `testedMergeSHA` and `sourceTreeDirty` in each
report. The c15f1bb ARM workflow passed its actual scenes, but its two raw ownership reports omitted
the clean-source field; the strict readiness audit rejects that missing metadata.
[The original artifact](https://github.com/YondFane/uTerm/actions/runs/42309000560/artifacts/13548990662)
is retained. A focused regression keeps such reports blocked; fresh Mac evidence for the wrapper
correction is tracked in #47.

`bash scripts/macos-input-control-smoke.sh` drives two concurrent, isolated native app processes,
the native take-control button, passive input/resize rejection, output/ack, ordinary viewer exit,
reacquisition and exact close, with four WindowServer captures. `pnpm qa:shared-state` includes two
concurrent real Tauri processes and six ownership scenes using actual terminal input and takeover
buttons. Before its first command, QA waits for the actual xterm input field to become writable and
the shell prompt to appear in parsed terminal rows; takeovers also wait for writable input. The
report retains that initial readiness evidence. Commands are sent once, without changing the
application shell or replaying input. The isolated QA build permits concurrent app processes and
gives the viewer a separate temporary CLI-control endpoint while both processes retain the same
shared store, host and session. The Windows fixture explicitly writes UTF-8 marker files through
actual PowerShell terminal input, matching the text reader without changing the application shell.
Its compile-gated observer reads the actual Tauri session host, and failure cleanup closes only the
disposable QA root's exact session generations before idle shutdown. Real native ownership checks
passed on macOS ARM/Intel at source `670f421354150e112f71d0ac3c94f29681296993` / tested merge
`c5e4c54dfa4acbe381c64a81b113b4d5c659a97b` (Native run 41818643260), including four WindowServer
captures per architecture and the standalone CLI regression. Tauri source
`b7a5e60f6252aab6b829a8e0659a35c8e5509637` / tested merge `3029133cd9dd7433a06d31cb1ea76db885df94aa`
passed 46 scenes on Windows and transitional macOS, including six ownership scenes and
cleanupErrors=[]. Windows output was visible, but visual inspection found blank macOS terminal
areas. Source `1fd91cf` additionally confirms actual xterm accessibility rows contain the expected
shell markers with nonzero terminal/canvas dimensions; its macOS GPU captures remain blank. Input
side effects and parsed text do not establish GPU display acceptance.
[Source-bound reports/artifacts](https://github.com/YondFane/uTerm/issues/32#issuecomment-6631153924)
retain this gap. Manual keyboard, IME and system-clipboard acceptance remain unexecuted.

Tauri ownership QA retains baseline GPU captures before explicitly losing the actual WebGL context
through `WEBGL_lose_context`, then requires xterm's existing DOM fallback to display the same shell
marker. Both app processes retain the same session/generation through recovery, takeover and output.

Source `1a30d7d90b08fedf9e16c0b695658a963b575037` / tested merge
`321cce8300f8abc8e95b07e731baf40259b54885` passed all 50 actual application scenes on Windows Server
2025 x64 and macOS 26.6.2 ARM64, dirty=false and cleanupErrors=[]. Both reports retain the actual
writable-input/shell-prompt readiness, WebGL2 loss and DOM recovery. The corresponding Mac
owner-returned and Windows viewer-owned captures show real shell output.
[Reports, screenshots and preserved earlier failure](https://github.com/YondFane/uTerm/issues/32#issuecomment-6646250139)
remain source-bound. DOM output does not establish GPU capture/display acceptance; that gap and
manual keyboard, IME, clipboard, sleep/display and full lifecycle acceptance remain open.

The shared stream also forwards control-role changes when no new output bytes have advanced the
cursor. An in-flight read can report passive state at the new owner's sequence before the claim
reply updates its local lease. Deduplicating that later owned frame solely by sequence used to leave
the view read-only; the stream now compares control metadata as well. Byte sequences,
acknowledgement rules and raw output remain unchanged.

A real Core/host/PTY regression reproduces the previous timeout and checks four peer exits with
explicit reacquisition through the original attachment, ordered role updates, rejected stale input,
unchanged host PID/generation/grid, a real file write after each exit and exact close.
`input-reacquire-core.json` records source/merge/platform and any observed control-only changes at
the same cursor. Linux passed the targeted regression, full Core/FFI/Host/backend checks, 408
frontend tests (10 skipped), types/production and desktop builds, formatting and documentation. The
final working tree also passed all 53 real application scenes (dirty=true, cleanupErrors=[]).

At source `29516c6dd78399d305099611cddebac7f825d46c` / tested merge
`dcb2332a60bc712c0fb86ba6aa32bd946b88964a`, all four clean Core/PTY reports passed, and each native
architecture observed one control-only change without a new byte cursor. Both native application
handoff/Vim/slow-consumer reports passed; macOS Tauri passed 53 scenes. Windows application QA
stopped earlier at its short/long path comparison, so its UI acceptance is still incomplete. The
real-app QA retains control-click/read-only diagnostics on failure. Platform reports remain bound to
their own source/merge in Issue #32. Agent authentication/tasks, manual IME/clipboard/mouse and
sleep/display acceptance remain open.

M2 simulation uses a custom Python Agent CLI fixture launched by the real host/Core PTY through
normal Agent definitions. The fixture emits alternate-screen, color and bracketed-paste sequences;
checks preserve literal arguments and Unicode bytes over two turns, a recoverable mock error and
cancel, client detachment/reconnection, prior-output replay, stale-input refusal, callback cleanup,
exit code 7 and exact close. `m2-simulation-core.json` explicitly records `mockAgentCLI=true`,
`actualAgentProvider=false`, `actualOSPowerSleep=false` and `guiAcceptance=false`. Client suspension
is modeled by detachment; clock-driven lease checks model expiry/renewal. These checks are the
user-approved simulation scope for #31/#32, not real provider authentication or OS power testing.

The Linux fixture passes through actual processes and validates the saved UTF-8 files. Native
SwiftTerm parser/mouse-mode and frontend composition/clipboard/renderer simulations remain separate
from the actual native Vim and Windows window evidence. The optional installed Codex 0.163.0 plus
loopback-model activity test still fails with `thread/read: list_turns is not supported yet`; that
failure is retained and is not counted as passing the mock CLI test. M3–M5 acceptance is unchanged.

### Shared saved state

The development client imports workspace and settings data through its existing WebView on first
launch. Rust validates and retains the original export, then owns `shared-state-v1` in the app-data
directory. Subsequent saves use an atomic snapshot and revision checks; workspace and settings
changes share a serialized queue. The old workspace/settings keys are retained for recovery and are
no longer written. Editor drafts then initialize a separate shared store; other WebView preferences
retain their existing owners.

Settings changes use the initiating view's baseline, so an older view cannot revert unrelated
committed fields. Quit drains writes added during an earlier save. Explicit reloads use the same
queue. Failed settings remain as drafts when Settings is closed and reopened. **Reload saved
settings** reads external changes while retaining the draft, including a conflict on the same field;
**Retry saving settings** explicitly writes it, and **Discard unsaved settings** reloads before
discarding. Quit remains blocked while a failed draft needs handling. These drafts are held in
memory; they are not crash-recovery storage.

Ten real Rust-process contract tests passed on Linux x86_64, including retained same-field conflict
drafts, publication after commit and quit protection after reload. Real isolated Tauri runs checked
save/conflict/reload/retry, normal quit and reopen, corrupt snapshot recovery and retained
original/damaged bytes. Save/recovery acceptance passed at head
`56ce724043d0ea4ebdf8a929aef76ecbc9c9e313`, tested merge `e98be01cd195e6427c9824727a0221e596ea1132`
([legacy CI](https://github.com/YondFane/uTerm/actions/runs/41448284276),
[native CI](https://github.com/YondFane/uTerm/actions/runs/41448284447)). Windows Server 2025 x64
and macOS ARM64 each uploaded ten actual window scenes and a successful report without cleanup
errors. The
[Windows artifact](https://github.com/YondFane/uTerm/actions/runs/41448284276/artifacts/13142824964)
and
[macOS artifact](https://github.com/YondFane/uTerm/actions/runs/41448284276/artifacts/13143776890)
include original/damaged-byte retention results and source metadata. QA cleanup errors fail the run
and remain in its report without hiding earlier scenario images.

An unreadable snapshot opens a recovery view without resetting data. **View recovery copies** lists
valid saved snapshots; an explicit restore retains the damaged bytes. Up to eight previous snapshots
and the original import are retained. Existing recovery copies must match their expected bytes;
wrong checksums or occupied backup paths stop a save without replacing the snapshot. The recovery
list includes only copies whose filename digest matches their actual content. **Settings → General →
Export legacy-compatible data** saves the current workspace/settings and original auxiliary values
as JSON. This export is a recovery artifact. A real Rust-process test reads the exported
workspace/settings with unchanged release readers, preserving split/session IDs and opaque
draft/backup bytes after repeated import. Automatic downgrade into an unmodified old client's
WebView storage is not verified. Export refreshes workspace/settings, adopted Git favorites and
current PDF highlights; other auxiliary values retain their first-import bytes. Before replacement,
retain a fresh old WebView profile and the complete canonical store as well. Editor/PDF, Git
favorites and Agent notification migration belong to #34, #35 and #40; full installation rollback
remains #46.

For operators preparing rollback, the Core `rollback.export` method accepts the current
`expectedRevision` and optional `expectedDraftRevision`. It reads canonical state, adopted Git
favorites, current PDF highlights and current editor drafts under one writer lease, returning
schema1 `RollbackArchive` with source revisions, original auxiliary strings, every current draft and
per-document old-format candidates. A single current draft fills the old slot; cleared drafts remove
it; multiple drafts leave the slot empty and require an explicit choice while retaining every draft
in the archive. The existing UI's `legacy.export` keeps its original semantics. Export never
installs, restores or automatically authorizes a downgrade. Keep the complete data backup and
validate the old reader; credential stores and live host endpoint files remain outside this archive.

Linux checks pass 33 targeted storage/rollback tests (three existing permission cases ignored), two
real-process reader tests, generated TS/Swift contract checks and type checking. They cover latest
Unicode/BOM/CRLF bytes, multiple and deleted drafts, stale state/draft revisions, malformed
arguments, corrupt/unsupported stores, writer contention/retry, idempotence and no config/source
writes. CI records `rollback-export-core.json`. The actual Swift C ABI case initially failed because
its draft setup omitted `expectedDraftRevision`; setup now sends explicit null for a new document,
retaining strict rejection of missing fields. The corrected actual C ABI check passes both Mac
architectures at source949e4c2.

`python3 -B scripts/client-upgrade-smoke.py` prepares a historical Tauri QA client from the fixed
published `uTerm-v0.2.4` source, with an isolated identity shared only by its native test successor.
The full historical rehearsal requires an owned GitHub Actions Mac because unchanged historical OS
adapters retain fixed development labels. All original source hashes are retained: only the two
startup/command entry files and recorded QA additions differ. It does not run the unmodified
published installer. The historical GUI, readers, services, source manifests and lockfiles remain
unchanged; initial draft input and credential/hook references are labelled fixtures.

A restored historical editor keeps its unsaved draft visible. Recovery checks actual retained xterm
replay and visible CodeMirror text without hiding the editor or re-selecting the project: both
navigation actions trigger that version's autosave. The first old app and both native phases still
produce fresh PTY output, with fresh DOM input and replay-only checks recorded separately. Fresh
input waits for the actual historical xterm's `disableStdin=false`, since its textarea can exist
before attachment enables input.

Regressions execute the actual QA script with real React, xterm and DOM state plus a labelled
navigation/autosave simulation. Both recovery paths must preserve the original file and stored
draft; the real xterm reference is checked in disabled and ready states. The packaged native
transition identity can use only its embedded private temporary data root, as for isolated updater
fixtures. The bdb56fc ARM run confirms the exact legacy Core draft bytes, but its actual native
window still shows disk text because Foundation changed the document root from `/private/var` to
`/var`.
[Artifact13544688991](https://github.com/YondFane/uTerm/actions/runs/42302307767/artifacts/13544688991)
retains both real native failure windows, DOM text and UTF-8 diagnostics, plus the preceding old-app
recovery evidence. The fix separates logical draft identity from resolved filesystem boundaries.
Three Swift regressions cover a real alias/sibling/escape, macOS temporary aliases and recovery
through the actual Core ABI with original file bytes retained; their execution and complete rollback
still require the new Mac CI source. The native content smoke also makes a fresh WebKit read after
actually retargeting a selected alias, rejects the alternate root and records
`native-content-alias-root.png`; its 21 checks and four original windows require actual Mac
execution. No native pass is inferred from Linux checks.

The Mac rehearsal downloads a native QA archive from its owned loopback server, verifies a pinned
one-time Ed25519 manifest and architecture, rejects a bad signature before replacement, and tests
interruption after moving the old program. After each durable export and window capture, the
coordinator kills the historical UI without bypassing its quit guard or deleting its draft. The
actual old app restarts before repeat Core import. The native app restores the old draft, edits
through its real CodeMirror window, persists changed settings, survives SIGKILL and reopens.
Explicit rollback restores the old program and applies the latest compatible data into its actual
WebView; unchanged historical readers must recover that latest draft/settings and the same live
host/generation. Original files and canonical stores are checked, with complete canonical fixture
backups archived before each handover. Multiple draft choices remain refused rather than being
selected automatically.

Client upgrade and rollback runs on both Mac architectures and uploads `upgrade-rollback.json`,
source/overlay hashes, old/native QA packages, public manifest/signature, canonical backups,
original application windows and logs. Linux checks pass two interruption/isolation tests plus the
historical frontend's types/build and historical Rust compilation. Actual Mac execution and
acceptance are recorded per source in #46; these local checks alone do not establish them. The first
ARM run42282798468 built and launched the actual old application but failed its marker check because
canvas output was read as DOM textContent. The isolated QA now reads the unchanged component's real
React xterm ref; a real React/xterm regression passes when the DOM text is empty and the buffer
contains wrapped output. Failed windows are captured, and owned-host shutdown waits for endpoint
removal. The old failure artifact is retained. A subsequent 8f23169 ARM run verifies the real
historical PTY marker but fails its separate window probe;
[artifact13537749822](https://github.com/YondFane/uTerm/actions/runs/42286080719/artifacts/13537749822)
contains that failure without a successful screenshot. Capture now uses the existing compiled
owner-checked helper: auto-selection requires exactly one eligible window, private QA explicitly
shows/focuses it, and failure diagnostics retain only owned window metadata. Historical checkpoints
are retained before capture, while the top report lists completed scenarios. Corrected outcomes
remain source-bound in #46. This is a private manual package-replacement rehearsal; it does not
configure a production cross-client feed. Actual credential approval/hook execution and OS
deep-link/login registration are not represented as tested; references are simulated and production
schemes stay disabled.

#47 tracks final source-bound evidence and current stage gaps; neither task authorizes merging or
publishing. The Migration readiness audit runs for updates to migration PR #12 or manual dispatches,
reading GitHub task/PR/ref state and current-head workflow artifacts. It checks exact
source/tested-merge identities, clean reports, failures, incomplete acceptance flags and PNG
signatures, and publishes migration-readiness.json. Open prerequisites, missing/failed CI, stale
artifacts or unequal tested merges fail the gate. The report inventory does not replace
original-window inspection or task acceptance. The audit has read-only repository permissions and
does not close issues, merge, tag, publish or change feeds. Run
`python3 -B scripts/migration-readiness.py --head SOURCE_SHA` with authenticated GitHub read access;
its nonzero result and artifact describe current blockers, not a successful release.

Rust storage/FFI tests and real-process TypeScript compatibility tests cover repeat import,
conflicts, corruption, recovery, ownership and callback draining on Linux and in Windows/macOS CI. A
real-helper C ABI test also blocks a binary callback while another thread unsubscribes or closes,
verifying that its borrowed context remains valid until delivery drains and that callback reentry is
rejected. This added check passed on Linux and both native macOS architectures at the validated head
above. Swift bridge tests run in macOS CI; source-specific native Swift migration and recovery
evidence is maintained separately in #28/#46. The Tauri acceptance above is separate. Both legacy
platform jobs also run shared-core tests and generated-contract drift checks, uploading command
logs, source head, tested merge SHA and platform/toolchain metadata as `legacy-checks-*` CI
artifacts.

#### Shared editor draft storage

The development core owns `editor-drafts-v1.json`, separately from workspace/settings, with up to
100 revision-checked documents. Legacy import retains exact source bytes before parsing, accepts
repeat imports of the same source and refuses to replace newer drafts from a different source. Text
and saved-text limits match JavaScript's 2 Mi UTF-16 code units; BOM/line endings survive. Up to
eight valid prior snapshots and 16 original sources remain. Invalid recovery bytes are retained; a
full source collection rejects another import. Relative paths reject absolute paths and parent
traversal.

The native QA client's **File → Open file…** uses the shared CodeMirror editor and project-scoped
recovery. Acknowledged unsaved text restores when reopening its file; recovered text needs explicit
Save before autosave resumes. Saves retain root/link, expected-version, BOM and line-ending checks
and wait for draft delivery. Editable windows have no readonly force-close timer. Explicit discard
waits for dispatched writes and preserves another writer's newer draft. Content may save only its
selected file and cannot import old sources. If its source disappears or becomes unreadable,
retained text opens readonly with a notice and survives close.

Native file windows retain the selected project path spelling as the Core draft identity, including
`/private/var` aliases. Resolved paths remain separate for file-picker boundaries and window
grouping; picker targets outside the root, including symlink escapes, are rejected. File opening
from the project menu, inspector, recovery and Git retains that logical root. Existing windows are
reused only for the same logical root and relative file, so distinct stored aliases are not silently
merged. The draft format and revision/byte checks are unchanged. Reads and saves use the resolved
root pinned when the window opens; retargeting an alias cannot redirect them.

The queue coalesces waiting text, bounds pending data and keeps flush/retry failures visible,
including initialization with no waiting writes. Different documents advance independently; stale
writes/removals for the same document fail. Lost replies require checking durable data. Close stops
delivery without promising host rollback. Escape closes the native file window after the shared
document-close guard. Native quit freezes and confirms all content documents, retains the app on
refusal/timeout/reload/stale replies and resumes prepared documents after cancellation. Quit errors
reveal the main window.

If recovery delivery fails, **Retry recovery draft** explicitly retries the retained queue without
saving the file. Text stays in the editor, writes do not replay automatically, and file autosave
remains paused until explicit Save. The same control is available in the Tauri and native content
editors. A failed retry retains the error and text.

A missing draft snapshot with existing backup/damaged files now blocks automatic import. The
development APIs `editor.drafts.recovery.preview` and `editor.drafts.recovery.restoreMissing` expose
verified backups and explicit absent-file restoration. The latter requires `expectedMissing: true`
and installs without overwriting a newly created snapshot. Existing restore/null behavior is
preserved; damaged bytes, originals and invalid copies remain.

**File → Recover editor drafts…** previews retained text, copies the full text without writing files
or opens its latest draft. Reopening an existing file focuses its current window. Drafts with
unavailable or differently spelled project locations can still be copied.

**File → Restore editor recovery copy…** previews verified backups and explicitly restores the
selected copy, retaining damaged bytes. A changed snapshot rejects the restore; an absent snapshot
uses non-overwriting installation. Cancel does not change recovery data. Open editors retain their
current text; reopen files to load restored drafts.

Editable native files from the same canonical project open as AppKit window tabs in opening order.
Opening an existing file selects its existing tab. Different projects, read-only previews and Git
windows stay outside that editable group. Each tab keeps its own document-scoped bridge, recovery
queue and close guard; cancelling a conflicted close retains both drafts and the external file.
Closing one tab continues to guard and acknowledge only its own document.

The real editor smoke edits two recovered files in native tabs, leaves both open for SIGKILL, then
explicitly reopens and checks exact drafts, order/reuse, project/preview isolation, conflict/Keep
editing/discard and sibling Save. Source `e06168dbe9491c3c862977dc931c6b7ad098a4ee` / merge
`e48ce2f886987f92b17f77a42637f6b692bf6da2` passes both ARM/Intel flows and the configured dark
native chrome check. Actual WindowServer captures are `native-editor-tabs-checkpoint.png`,
`native-editor-tabs-reopen.png` and `native-editor-tabs-conflict-640.png`; the current reopen image
was inspected and its tab chrome matches the dark editor.
[ARM artifacts](https://github.com/YondFane/uTerm/actions/runs/41984445494/artifacts/13395713575)
and
[Intel artifacts](https://github.com/YondFane/uTerm/actions/runs/41984445494/artifacts/13396400420)
include editor-live.json, both phase reports and system/toolchain data. #34 is closed in the
user-approved scope. Persistent layout/window geometry and shared PDF marks remain explicit #13
implementation gaps; final human keyboard/IME/focus checks were waived, not executed.

#### Tauri editor draft handoff

The development Tauri client initializes shared drafts before opening its workspace. It keeps the
old draft key unchanged, verifies a versioned WebView backup and retains exact source bytes in Core.
A versioned acknowledgement binds those frozen bytes to the shared source, so restarting does not
reimport an old draft over newer shared text. Subsequent editing, save and discard use the same
revision-checked queue as the native editor.

A different old source opens **Recover editor drafts**. **Copy old draft source** retains its full
original JSON; **Continue with shared drafts** requires the old source to have been archived and
keeps the shared documents. A changed old source requires a reload. Storage/quota, backup and
acknowledgement failures keep the old bytes and block handoff. Corrupt/missing shared snapshots can
be previewed and explicitly restored from verified recovery copies; a stale selection cannot replace
newer bytes. There is no empty-data fallback.

The old draft's file reopens with the latest shared draft when that document is still retained.
Recovered text requires explicit Save before autosave. Other retained files restore when opened. The
old key and versioned copies remain recovery data; they are not live mirrors of later shared edits.
Full installed-version downgrade still requires #46 acceptance.

#### Shared draft validation

Head `c475567da41e6840dc76f1197f8b5ea183bb0865`, tested merge
`c5c63cb41a2843cb70e0bc95fbb19511c535ff65`, passed all four jobs in
[native ARM/Intel CI](https://github.com/YondFane/uTerm/actions/runs/41566088010) and
[legacy Windows/macOS CI](https://github.com/YondFane/uTerm/actions/runs/41566088020). The native
reports verify exact NFD/Chinese/CRLF/BOM bytes, durable drafts, SIGKILL/relaunch, external
conflict, close protection, discard, save, 640px controls, guarded Escape window close and
missing-source readonly retention. Twelve `native-editor-*.png` images include these scenes plus
recovery selection, accurate copy, cancel, window reuse, stale restore refusal, damaged-byte
retention and absent-store restore. English/dark, Chinese/light and backup preview images were
inspected. Reports record source/merge/platform/toolchains. Artifacts:
[ARM](https://github.com/YondFane/uTerm/actions/runs/41566088010/artifacts/13198977763),
[Intel](https://github.com/YondFane/uTerm/actions/runs/41566088010/artifacts/13199306983),
[Windows](https://github.com/YondFane/uTerm/actions/runs/41566088020/artifacts/13199842022),
[old macOS](https://github.com/YondFane/uTerm/actions/runs/41566088020/artifacts/13199777170).

Both native jobs passed 13 Swift checks, including backup preview/missing restore through the C ABI.
Both Tauri state QA reports passed without cleanup errors; those checks do not establish Windows
editor draft UI parity. Linux checks pass 378 frontend tests (ten skipped), 129 backend (ten
ignored), core/FFI and filesystem failure/retry, contract drift, types and desktop compilation.
Twenty-one real Rust-process contracts cover missing sources, non-overwriting missing-store restore,
preview and unchanged null semantics. DOM input in the real native app is separate from manual
keyboard/IME/focus acceptance.

Both native architectures passed the real recovery controls above. Both Tauri clients passed 16
actual application scenes, including old-source import, frozen keys/versioned backups, durable
unsaved text, forced SIGKILL, reopen with the exact newer draft and explicit BOM/CRLF save. Process
reports record the forced signal and normal reopen exit; original/draft-byte checks and four editor
screenshots are in each legacy artifact. Windows recovery and macOS saved images were inspected.
Tauri's boot conflict/damaged recovery UI has real Rust/React contracts but still needs
corresponding platform screenshots. Tabs/window order, PDF marks and full manual editing/focus
remain open.

### Shared Git and Worktree service

The development core's `git` and `worktrees` modules own status, diff, commit history,
branches/references and Worktree rules. The same 15 Git and four Worktree operations use `git.*`
requests and Rust-generated TypeScript/Swift DTOs. Tauri keeps its existing command names and Git
interface and delegates to the same functions.

With a local project or Worktree selected, the native QA application's **File → Git…** opens the
shared Git panel in a separate window. Core resolves the selection against the current workspace
revision. Git requests bind to that repository and project; file windows cannot invoke Git.
Diff/name copying uses the system pasteboard. A separate bridge keeps repository work off the
terminal bridge.

Both clients support the same existing operation set:

| Operation                                                           | Native macOS entry                             | Windows entry                                      | Shared service                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Status, working/staged diff, commit details/history and comparisons | File → Git…                                    | Git inspector                                      | `git.snapshot`, `fileStatus`, `diff`, `history`, `files`, `workingComparison`                  |
| Branch catalog, switch and remote discovery                         | Git tree/context menu                          | Git tree and branch picker                         | `git.branch`, `branches`, `references`, `remoteBranches`, `switchBranch`, `switchRemoteBranch` |
| Create/rename, upstream, fetch, pull/update and push                | Git context menu                               | Same shared Git context menu                       | `git.referenceAction`, `branchAction`                                                          |
| Revert a selected file                                              | Git change menu                                | Same shared change menu                            | `git.rollbackFile`                                                                             |
| Suggest/create/list Worktrees                                       | Git context menu and project sidebar           | Git context menu and project sidebar               | `git.worktrees.suggestion`, `create`, `list`                                                   |
| Confirm/remove a registered Worktree                                | Native sidebar menu and default-Cancel NSAlert | Sidebar menu and default-Cancel application dialog | `project.worktrees.delete` plus shared Git deletion rules                                      |

Commit creation/staging is not an existing panel action; commit rows show details/history. Native
content cannot directly call raw Worktree deletion or global recovery; trusted AppKit controls
perform those operations. Windows uses its application dialogs for the same guarded actions.

Before a write, open editable file windows save and freeze until completion. A file conflict blocks
Git and retains both file and recovery draft. The Git window refuses to close during a write. Clean
editors reload repository changes; dirty or busy editors retain their text. Cancelling or timing out
a dispatched write does not establish rollback; inspect the repository before retrying. Both Tauri
and WebKit retain the caller's busy/editor protection until the actual dispatched write finishes,
then report the cancel/timeout/closed error without delivering a late success. A native cancel
acknowledgement alone does not release this protection. Read cancellation remains immediate. Native
favorites use the shared recovery controls described below.

The Tauri backend independently retains queued/running Git, Worktree and local-file writes, plus
mutating shared-store requests. Normal quit visibly refuses while they run, even if WebView state is
lost. Final exit and new-operation admission share one lock, preventing a write from starting after
exit has been approved. Known read-only queries do not hold the write guard, so a background
favorite/snapshot reply cannot spuriously refuse the final quit. New or unknown methods remain
guarded, and approval rejects new requests including reads. A real Core snapshot reply and a
committed settings write check these distinct lifetimes; the new policy requires its own platform
CI.

`project.worktrees.refresh` discovers the stored project's repository and atomically updates its
Worktree list with an expected revision. Both clients use these rules for registered projects: keep
IDs/custom names, update branch-derived names, retain missing Worktrees with sessions, drop
unreferenced entries no longer discovered and preserve valid selection. A stale revision or Git
discovery failure retains saved state. A subdirectory project excludes its own main root from child
Worktrees.

The native sidebar displays Worktrees below projects. Select a row to use its directory; right-click
the project or Worktree and choose **Refresh Worktrees** to rescan. Git mutations synchronize the
bound project's list before publishing success. If Git completed but list storage failed, the error
says so; refresh the project instead of blindly repeating the Git write. Canonical Tauri project
Worktree updates use the same Core operation; browser fixtures retain their compatibility path.

Literal directory endings and Unicode branch whitespace are preserved, including the source branch
for automatic Worktree creation. Windows extended drive/UNC destinations are translated for Git;
extended paths whose dot/space endings cannot be preserved are rejected visibly. A real Windows
creation/dirty-refusal/deletion regression passed in CI. Native diff colors use theme text/canvas
colors; the Chinese/light narrow screenshot was inspected.

Right-click a native Worktree and choose **Delete Worktree…**. The native confirmation defaults to
Cancel; confirmation freezes/saves editable windows and calls `project.worktrees.delete` with the
captured revision. Tauri's application confirmation shows the project and Worktree directories and
defaults to Cancel. It pins the reviewed snapshot instead of adopting a revision updated later by
the queue; changed queued or external data refuses deletion. **Reload workspace** reads saved data
through the editor save/close guard before a new confirmation. Deletion errors remain visible until
explicit retry/reload, and normal quit waits for dispatched deletion. Cancel does not save or
delete. Both clients delegate to the same service. Core derives the path from saved IDs, rejects
stale state, saved session references, live host sessions/tasks launched inside the folder and dirty
Git data. Host inspection neither starts nor restarts it; an unreadable endpoint blocks deletion.
Raw Web content cannot invoke native deletion. If Git removes the folder but metadata saving fails,
the error requires explicit **Refresh Worktrees**. These guards use saved references and host launch
directories; they do not track a shell's later `cd` or arbitrate every legacy host client. Complete
ownership/cancellation acceptance remains pending.

Draft list/document reads retry only `WRITER_BUSY`, at most six times over 620 ms. Close cancels
backoff; writes and conflicts do not retry automatically. A failed initial open can be retried.
Actual OS-lock regression uses a separate Rust process; it failed before the error-code correction
and passes afterward. QA observation reads also wait for that lock within their existing 30-second
deadline and record `observerBusyReads`; they never retry writes.

#### Shared Git favorites

Both clients' branch context menus use `git-favorites-v1.json` in the canonical store. Favorites
belong to the real Git common directory, so the main repository and its Worktrees share them. Writes
check that repository's revision; stale replies cannot replace newer selections. Rename updates a
loaded favorite after the Git operation; a preference failure stays visible.

Tauri retains the exact old `uterm.git.favorites:*` key, a verified versioned WebView backup and a
Core source archive before handoff. A receipt binds the old bytes to the shared source; reopening
cannot replay old choices over newer shared favorites. A different source offers **Copy old Git
favorite source** and **Continue with shared Git favorites** after archival. With an invalid old
source and no shared entry, **Keep old source and create empty shared favorites** requires an
explicit choice. A concurrently changed old key requires reload; backup/quota/receipt failures
retain data and block editing. The native window imports only Core's frozen canonical legacy source
and cannot submit arbitrary old WebView sources. Its file windows cannot read or write favorites.

The store retains up to eight prior snapshots and 16 original source contents, with at most 1,000
repositories and 1,000 references per repository. Invalid/corrupt/missing data and occupied recovery
paths block replacement; recovery files stay intact. **Reload Git favorites** explicitly resumes
after a failure. Read-only lock waits are bounded and cancelled on close; writes do not retry
automatically. Legacy export overlays current shared favorites under canonical and original client
path keys while retaining archived bytes; it does not perform an installed client downgrade.

The branch toolbar's **Recover Git favorites…** action opens verified snapshot and original-source
previews. The native client also provides **File → Recover Git favorites…**. Cancel is the default;
copy keeps the complete preview even when the displayed text is truncated. Original sources can be
copied but cannot directly replace favorites. **Restore all repository favorites** replaces the
global favorite snapshot, retaining damaged bytes and the immediately preceding valid copy. A
changed current file rejects the write and requires a fresh catalog; a missing file is installed
without overwriting newly created data. Open Git views reload after successful restoration. Tauri
shared content uses the native clipboard-manager plugin with write-text permission for the main
window; failures remain visible. Browser-only fixtures retain the Web clipboard path. Copy failure
never changes recovery data. Once application quit begins, new restores are refused; a dispatched
restore retains its quit guard until acknowledgement. Global recovery stays in the trusted
application; scoped content can request its native dialog but cannot read or restore other
repositories' recovery data.

#### Git and editor concurrency validation

The accepted Git/Worktree implementation is source `e06168dbe9491c3c862977dc931c6b7ad098a4ee` /
actual CI merge `e48ce2f886987f92b17f77a42637f6b692bf6da2`. Merge parents were verified as this
source and release `ca65aa9ca76abcc510124427398789ba01635c4d`; this is a CI test merge, not a merged
PR. Both [native jobs](https://github.com/YondFane/uTerm/actions/runs/41984445494) and both
[Tauri jobs](https://github.com/YondFane/uTerm/actions/runs/41984445471) pass with clean-source
reports. The [Java matrix](https://github.com/YondFane/uTerm/actions/runs/41984445509) and
[six-job Maven matrix](https://github.com/YondFane/uTerm/actions/runs/41984445498) also pass.

Each platform's `git-operations-core.json` records actual Git processes, all 19 Core JSON methods,
selected repository/Worktree isolation, distinct staged/working diffs, stale-reference/branch
refusal, checkout conflicts, targeted rollback, upstream/push and dirty/clean deletion. Native macOS
15.8.2 ARM64 and 15.7.9 Intel each pass 35 Git/window assertions and save 16 real WindowServer
captures. Windows Server 2025 x64 and transitional macOS 26.6.2 ARM64 each pass 53 real isolated app
scenes with no cleanup errors. Source, merge, OS, architecture and toolchains are in the reports.

Artifacts:
[native ARM13395713575](https://github.com/YondFane/uTerm/actions/runs/41984445494/artifacts/13395713575),
[native Intel13396400420](https://github.com/YondFane/uTerm/actions/runs/41984445494/artifacts/13396400420),
[Windows13396047301](https://github.com/YondFane/uTerm/actions/runs/41984445471/artifacts/13396047301),
[Tauri Mac13396081499](https://github.com/YondFane/uTerm/actions/runs/41984445471/artifacts/13396081499).
Native `git-live.json`, `git-operations-core.json`, Tauri `tauri-state-qa/report.json` and test logs
index each scenario. `native-git-favorites-writer-busy.png` proves a real independent Rust writer,
visible read contention and one explicit reload after release. The separate
`native-git-bootstrap-writer-busy.png` proves the startup error uses the cached application language
and a compact Retry button; retry remains disabled while pending and can recover after another
failure. Both owned writers exit 0 and favorite bytes remain unchanged.

`native-git-cancel-frozen-editor.png`, `native-git-editor-conflict.png` and Worktree confirmation/
refusal captures show write/editor protection. Windows `git-git-worktree-delete-dirty.png` and
`git-git-write-quit-blocked.png` show retained dirty data and an actual in-flight IPC quit refusal.
The Core-backed Tauri/WebKit abort/timeout/close tests use a paused real Git hook and keep the
caller protected until completion. Native and Windows current-source images were inspected. Earlier
failures and their original artifacts remain in Issue #35; they are not treated as passing runs.

Run the focused contract with
`cargo test --locked --manifest-path crates/uterm-core/Cargo.toml --test git_operations`,
frontend/transport checks with `pnpm test`, and the macOS window flow with
`bash scripts/macos-git-smoke.sh`. Automation uses actual AppKit controls and DOM events in the real
applications, not manual keyboard/IME acceptance. The full M3 file/layout/PDF, authenticated SSH,
runtime-panel and manual acceptance gaps remain tracked separately without claiming the whole
migration or release is complete.

## Project website

### Website preview

The independent GitHub Pages website in `site/` uses a light introduction and an actual dark
workspace screenshot. A three-step start leads into five preview tabs: terminals and agents,
projects and Git, Java/Python build and run, SSH/SFTP, and Redis/databases. The tabs are labeled
illustrations with sample content, not live desktop sessions or server connections.

The build and run illustration shows Java and Python output side by side. The feature overview
explains project-specific configuration and logs, the toolbar's started-task lists and colored
running-project icons. Download cards and command installation follow the workflow overview.

Six interface palettes change only the preview. English/Simplified Chinese switching updates
content, accessible labels, metadata and documentation links; a blocked browser storage setting does
not prevent switching.

Keyboard users can navigate tabs with arrow keys, Home and End.

### Repository guides and presentation media

The repository opens with an English README; its language link opens `README.zh-CN.md`.
`README.en.md` remains an identical English compatibility copy. Both languages use the same product
introduction, actual screenshot, platform download table, three-step quick start and four-workflow
overview. Java/Python setup, installation commands, development and licensing link to the detailed
guides. A link opens the screenshot tour.

The README and website show an actual isolated Windows app screenshot with a disposable project, two
real local shells and a Git Worktree. The website's video and interactive five-step tour explain
that screenshot; the 30-second GIF/MP4 are annotated screenshot tours, not continuous recordings.
They do not demonstrate model requests or remote connections.

Reusable media and its provenance live in `site/media/`. The editable social card and PNG support
website sharing metadata; GitHub's repository social preview must be uploaded separately.

### Downloads and installation commands

Windows x64, macOS Apple Silicon and macOS Intel download links initially open the stable GitHub
release. When the public latest-release API succeeds, they resolve to the exact matching installer
assets from this repository.

Missing assets, rate limits or network failure retain the release-page fallback. Installation tabs
expose the existing npm/macOS/PowerShell commands; copying reports success or selects the command
with visible manual-copy guidance when clipboard access fails.

SQL and MongoDB use require Java 17+ and the selected drivers; Elasticsearch requires no additional
runtime, and macOS first launch may require Privacy & Security approval.

### Local preview and publication

Run `pnpm site:dev` for a loopback-only preview under `/uTerm/`; `pnpm site:check` runs focused
interaction checks. The Pages workflow uploads only `site/` from `release`; repository Pages must
use GitHub Actions and the `github-pages` environment must allow that branch.

Publication requires the reviewed website changes to reach `release`. Local browser checks do not
establish hosted Pages deployment or desktop runtime acceptance.

#### Website checks on Windows

- Website interaction checks on Windows cover language switching (including image descriptions), all
  five preview tabs, keyboard navigation, six palettes, independent installation tabs, clipboard
  failure/races and stable-installer URL validation. The seven focused checks pass.

- The local `/uTerm/` page returns HTTP 200. Changed-file formatting, script syntax, local
  documentation links and documentation metadata/index checks pass. The preview serves the explicit
  website/media allowlist and rejects repository-file paths.

- Visual inspection uses the installed Windows Chrome with isolated profiles and bounded
  screenshots. Chinese/English desktop views and 320/390 CSS-pixel iframe viewports show no page
  overflow. The Java/Python preview is inspected with Paper and Clear Sky palettes, alongside the
  mobile download area. The English/Chinese READMEs are rendered locally at wide and narrow widths.

- These checks cover website layout, not mobile-device or desktop-app runtime acceptance. README
  rendering uses a local Markdown renderer rather than GitHub's hosted renderer. Current screenshots
  use the release-page fallback; focused tests cover exact installer resolution. Media playback and
  assistive-technology acceptance are not revalidated by these screenshots.

- An isolated Windows native QA app provides the screenshot using actual product components and
  disposable sessions. Its frontend and desktop builds pass, with the existing large-chunk warning.
  The media does not establish macOS/Linux, authenticated Agent, SSH or database acceptance.

- The Pages workflow publishes the presentation from `release`; local checks alone do not verify
  hosted publication or GitHub's separately configured social preview.

## Installation

### Stable releases

Release drafts are published by their verified numeric ID. An explicit recovery dispatch can restore
the five feeds from an already public version after all five source builds pass; it preserves the
tag and archives a source-bound recovery report. Eight local release-policy tests and YAML/docs
checks pass. The [actual recovery run](https://github.com/YondFane/uTerm/actions/runs/42974125671)
passes for published source `a0b865e32a57a78d9cbab76c744ae4a01edd393a`; its
[report](https://github.com/YondFane/uTerm/actions/runs/42974125671/artifacts/13833859633) records
five successful source builds, five restored feeds, five public installers and Latest. The original
failed publication run is retained as failure evidence.

The repository sidebar’s Latest entry points to the stable installer release. The release workflow
marks a version Latest only after public downloads are verified and the stable update feed is
published.

The prerelease update channel is never marked Latest.

The release skill requires notes to start with `# uTerm MAJOR.MINOR.PATCH`, followed by matching
Chinese and English feature highlights and usage instructions. Release preparation checks that this
heading matches the application version, notes filename and release tag; publication verification
also checks the heading in the release body and stable update feed.

After an authorized stable release passes CI, public-download, stable-feed and Latest verification,
the release skill requires merging its published commit into `main` and pushing it. The workflow
preserves both histories, excludes later unpublished commits and checks remote ancestry. Branch
protection or unresolved conflicts leave synchronization explicitly incomplete.

#### Build dependency caches

Desktop CI uses the same macOS 15 ARM64 and Windows x64 runner families as stable builds; releases
also build macOS 15 Intel. Their Cargo caches cover all four separate workspaces: `src-tauri`,
`crates/utermd-local`, `crates/uterm-core` and `crates/uterm-ffi`. Rust debug/test and release
dependencies remain separate. Cache keys retain compiler, build-environment, architecture and
manifest/lockfile checks. Desktop tests still use four Rust test threads; only the cache action
clears this runtime setting so it can restore the prewarmed compiler cache.

Desktop, Windows candidate/updater and personal package jobs restore Cargo dependencies without
saving large copies under each PR, branch or version tag. Desktop and personal package jobs also
restore the pnpm store. The default-branch prewarming workflow owns these cache writes, reducing
space pressure and removing dependency-cache compression/upload from release jobs. No existing cache
is deleted by these workflows. GitHub can still evict caches; missing or expired entries fall back
to normal compilation.

The `uTerm build cache` workflow runs after pushes to `main`, or manually with `main` selected. It
checks out `release`. Three desktop jobs compile host/core/FFI/backend test targets and the release
desktop application without running tests or packaging installers. Two personal jobs compile Release
Rust FFI/helper dependencies and the debug Core contract helper, and resolve locked SwiftPM
packages. Native cache keys also include Xcode 16.4, Swift, SDK and the macOS 14.0 deployment
target.

Personal SwiftPM caches contain dependency repositories, checkouts, downloaded artifacts and
resolution state only. Swift build products, app bundles, updater keys, QA data, screenshots and
reports are rebuilt or generated from the actual source. The personal job still runs Swift tests,
real-window/package checks and every actual Sparkle update scenario.

The prewarming workflow must be available on `main`; run all five jobs successfully before a
subsequent version tag to populate the new caches. This uses the default branch's cache scope, which
later tags can read; GitHub does not share caches between different tags. Prewarming consumes
additional runner time and does not sign or publish a release. Cache hits never skip frozen
dependency installation, formatting, documentation checks, tests, source/tag validation, signing or
public-download/update-feed checks. Cold starts and compiler/SDK changes still require compilation;
there is no fixed build-time guarantee.

##### Cache validation

The supplied [release baseline](https://github.com/YondFane/uTerm/actions/runs/42599125208), at
source/tested commit `2349b3b4721f1b7750d873ccea49da745c97b2e0`, passed but missed both Intel Cargo
caches. Desktop backend tests took 372 seconds, installer compilation/packaging 782 seconds, and
Cargo cache cleanup/compression/upload 134 seconds. The personal app build took 951 seconds. The
repository cache inventory was approximately 10 GiB, including repeated branch/tag copies; earlier
same-key default-branch caches were no longer available. These measurements precede the optimization
and are not evidence of its speedup.

Linux checks pass actionlint 1.7.12, workflow/Bash syntax and structural comparisons of the cache
identities and preserved acceptance steps. The existing suite passes 444 tests with 11 platform
skips; all 14 macOS Python policy tests, TypeScript/production build, repository/workflow and
feature-guide formatting and documentation checks pass. Native cache save/restore and optimized
warm-build timing comparisons require validation on GitHub-hosted macOS/Windows runners. The results
above are local checks and do not establish a build-time improvement.

#### Stable-release checks

Release and Windows candidate installer builds run through `node scripts/tauri-build.mjs`. Only the
official NSIS archive and Tauri NSIS plugin downloads followed by HTTP 429/502/503/504 bundler
errors retry, with at most three attempts separated by five seconds. Compiler, signing, permanent
HTTP and other errors retain their exit status. Every attempt still uses Tauri's tool verification
and installer signing.

The isolated Windows SSH fixture uses `curl.exe` against the official release URL, falling back to
GitHub's official asset API for the same pinned archive if transport retries fail. Each endpoint has
three retries, a 120-second retry budget and a 120-second per-attempt timeout. Both routes must pass
the same OpenSSH SHA-256 before extraction; a checksum mismatch fails without fallback. An anonymous
Linux download through the API matched the pinned digest and published 6,021,393-byte asset.

All four child-process regressions passed, covering NSIS archive/plugin recovery after HTTP 504,
exhausted attempts, literal arguments and errors that must not retry. The full Linux suite passed
444 tests with 11 platform skips. At source head `8264545a8d3f439fd5f301591206843e5c5d4a7f`, tested
PR merge `6d260c22b9914c0e6f2e5b945d76867a62137f4d`,
[Windows candidate verification](https://github.com/YondFane/uTerm/actions/runs/42583766437) passed
actual isolated NSIS installation, launch, screenshot and uninstall.
[Candidate evidence](https://github.com/YondFane/uTerm/actions/runs/42583766437/artifacts/13658212771)
contains `candidate-windows.json` and `candidate-installed-windows-window.png`.

Windows source and tested commit `2fb5ef8e68d7a90b8741da8354d554d8da362fc3` passed the
[complete desktop verification](https://github.com/YondFane/uTerm/actions/runs/42587567055),
including real SSH, frontend/backend tests, all 73 native scenes, input control and
installer/uninstaller checks.
[Windows evidence](https://github.com/YondFane/uTerm/actions/runs/42587567055/artifacts/13660962048)
contains `tauri-state-qa/report.json`, `candidate/candidate-windows.json` and original captures,
including `input-owner-input-owner-ready.png`. An earlier PR-merge attempt at
`302588271bffbd0189449f0c977448d5ec96fb7d` timed out waiting for the terminal window; its failure
remains available in run `42584992744`, and the same-source repeat passed without changing the UI or
acceptance. Windows SSH execution passed; the API fallback was independently downloaded on Linux and
was not forcibly selected on Windows.

The input-ownership QA waits for queued project-selection writes and two rendered frames before
activating New terminal, then drains the resulting write before checking the actual selected view.
Its 30-second terminal deadline and all running-session, input-control and rendering assertions are
unchanged. Failures include the observed workspace/project/session IDs, prior session IDs and view
geometry. Five existing real-Core queue/flush regressions, type checks, the full 444-pass Linux
suite and production build passed for this sequence;
[PR #50](https://github.com/YondFane/uTerm/pull/50) records its current native execution and exact
source evidence.

- Release preparation on macOS passes frozen dependency installation, 284 frontend/build-helper
  tests (ten skipped), 114 backend tests (nine ignored) and 46 host tests (two native CLI tests
  ignored). TypeScript/production build, desktop compilation, repository formatting, localization
  and documentation checks pass. This does not establish Windows/Linux runtime acceptance.

- Latest validation: six release-helper tests, workflow formatting, step-order and shell syntax
  checks, and documentation checks pass. The live latest-release API resolves to a published stable
  release, with its name, notes and all 11 uploaded asset records intact.

- Release skill structure, Markdown formatting and documentation checks pass. Version-heading
  matching is reviewed during release preparation and publication verification.

### One-line installation

The [README](../README.md#one-line-installation) provides one-line Terminal and PowerShell commands
backed by `scripts/install/install.sh` and `scripts/install/install.ps1`. They read the platform
stable update feed and download the matching versioned installer over HTTPS from this repository.
macOS selects Apple Silicon or Intel, including Rosetta detection, mounts the DMG read-only and
installs to `~/Applications/uTerm.app` without sudo or launching the app.

Existing user/system installations are preserved; use in-app updates. Windows x64 opens the
installation wizard and reports unsuccessful exit codes.

Installer payloads make at most three download attempts. With installer size and SHA-256 in the
stable feed, interrupted payloads are retained and resumed, and complete cached files are verified
before reuse.

Older feeds remain usable through fresh downloads without persistent payload reuse. Temporary
mount/staging files are cleaned up; verified installer caches retain up to four files and remove
inactive files older than seven days on subsequent use.

Windows uses a cache lock; macOS uses a lock directory that may need manual removal after a forced
termination. Failures print the official manual-download page.

GitHub access is required; no development toolchain is needed. Apple notarization is unavailable,
and first launch may require Privacy & Security approval.

The commands require the scripts to be published on `release`.

### npm installation command

The standalone npm package in `scripts/install` exposes `uterm-install` through npx, pnpm dlx or a
global installation. Node.js 22.13 or newer is required.

It invokes the bundled platform script with separate arguments and no shell interpolation,
preserving installer exit status. Help and invalid arguments never start installation.

There are no install lifecycle hooks; installing/removing the npm package only manages the command,
not the desktop application. The package is published on npm as `@yondfane/uterm-install`.

#### Installer checks and pending acceptance

- Validation: all 150 frontend/build-helper tests, 39 backend tests, local-session service tests,
  locked dependency installation, formatting, localization, documentation checks and
  TypeScript/production and desktop builds pass on macOS. Shell syntax and mocked macOS installer
  tests cover native/Rosetta architecture selection, paths with spaces, unsupported platforms,
  malformed versions, download failure and existing-install protection.

- The npm entry test covers platform dispatch, separate arguments, help, invalid input and failure
  exit status. A locally packed tarball passes both npm exec and pnpm dlx help smoke tests on macOS;
  npm pack confirms both platform scripts are included.

- The published npm 0.1.0 package also passes npx and pnpm dlx help checks. These tests do not
  download or install an application.

- Actual macOS installation and Windows PowerShell/runtime acceptance remain unverified.

## Workspaces and sessions

### Project and Worktree rows

Project and Worktree rows keep their folder icons when hovered or focused, with no separate dropdown
button. Their inline actions show New terminal and enabled Agents, without a More actions (ellipsis)
button; right-click the row for its existing menu.

When inline space is insufficient, the terminal/Agent capsule opens to the right of the row and can
extend beyond the sidebar. Folder icons and names retain their space; wider rows keep the capsule
inline.

Left-click the icon, name or remaining row-label space to expand or collapse the children;
Enter/Space on the focused row performs the same action. Existing project/session selection and
editor transition guards remain in effect.

Right-click menus, dragging and the row's quick-action buttons do not toggle folding. Active-tree
folding stays in memory, while inactive project/Worktree folding retains its existing saved setting;
activity rings remain visible when folded.

#### Project-action checks on Windows

- Project-action validation on Windows: six existing sidebar checks, changed-source formatting,
  localization/documentation checks and TypeScript/production build pass. An isolated native
  Tauri/WebView2 host (`sh.uterm.desktop.qa.hidemore`) renders the real Sidebar with temporary
  state.

- Visual inspection covers absent ellipsis buttons on active project, Worktree and inactive project
  rows, Chinese/dark 248 px and English/light 176 px layouts, correct right-click target callbacks
  and retained terminal/Agent quick actions. The fixture does not launch sessions; full-application
  menu integration and macOS/Linux runtime acceptance remain unverified.

- The production build retains its large-chunk warning.

#### Folder-row checks on Windows

- Folder-row validation on Windows: both focused sidebar regressions pass, covering row toggling,
  independent Worktrees, retained activity rings, unchanged active-tree saved settings,
  inactive-folder persistence, drag-click suppression, right-click/quick-action isolation and
  pending-transition guards. Changed source/style/test formatting, localization,
  TypeScript/production build and documentation checks pass.

- An isolated native Tauri/WebView2 QA host (`sh.uterm.desktop.qa.sidebarmenus`) renders the real
  Sidebar with temporary state and verifies icon/name clicks, no hover arrow, Enter/Space,
  right-click and quick actions, saved inactive folding, dark/light appearance and a 176 px sidebar
  in Chinese/English. This verifies Sidebar layout and callbacks without starting real sessions or
  restarting the installed app.

- Full-application editor transitions and macOS/Linux runtime acceptance remain unverified; the
  production build retains its large-chunk warning.

### Close and Remove buttons

Sidebar session Close Session buttons and SSH/Redis/database Remove buttons appear only while their
row is hovered or contains keyboard focus. Selection alone does not keep them visible.

Hidden buttons ignore pointer input and retain their space, so row labels do not shift; keyboard
navigation still reveals the controls.

#### Close-button visibility checks

- Close-button visibility validation: two focused sidebar/connection regressions, changed-source
  formatting, localization/documentation checks and TypeScript/production build pass. An isolated
  Windows Tauri/WebView2 host (`sh.uterm.desktop.qa.sidebarclose`) renders the real Sidebar and
  verifies all five fixture rows hiding/showing on pointer entry/exit, unchanged label bounds, a
  selected mouse-focused row hiding after pointer exit, keyboard focus/Enter activation, disabled
  connection controls and dark/light appearance with both languages.

- Callbacks use temporary fixtures without launching or terminating sessions or connecting to
  servers. macOS/Linux runtime acceptance remains pending; the production build retains its existing
  large-chunk warning.

### Connection context menus

Right-click an SSH connection row for New SSH terminal and Edit SSH connection; right-click a Redis
or database connection row to edit its profile. These actions no longer appear as inline
plus/ellipsis buttons.

Section Add buttons and row Remove buttons remain available. Opening a menu does not select or
connect its target.

Existing session, transfer, connection and draft protections still disable editing. Shift+F10 or the
Menu key opens the focused row's menu; arrows and Home/End navigate available actions, and Escape
returns focus to the row.

Menus stay within the window and close on outside input, scrolling, resize, loss of window focus,
hiding/folding the section, changing workspace or removing the target.

#### Connection-menu checks on Windows

- Connection-menu validation on Windows: the focused regression and three existing sidebar
  regressions pass, covering target identity, no selection on right-click, live edit guards,
  bilingual labels, keyboard focus/navigation and stale-target dismissal. Changed-source/test
  formatting, localization, documentation and TypeScript/production build pass.

- An isolated native Tauri/WebView2 QA host (`sh.uterm.desktop.qa.sidebarmenus`) renders the real
  Sidebar with temporary profiles and verifies hidden inline actions, right-click menus, all four
  action targets, arrows/Escape and returned focus, Chinese/English labels, dark/light appearance, a
  176 px sidebar, window-edge placement and protected editing. This covers WebView layout and
  callbacks; it does not connect to servers or validate the complete application lifecycle.
  macOS/Linux menu acceptance remains incomplete.

- The existing large-chunk build warning remains. The installed application was not restarted.

### Resource activity rings

Sidebar project, Worktree, SSH, Redis and database icons keep their normal colors while in use; only
their outer ring and soft glow turn green. Projects count all unclosed terminal/Agent sessions,
including those in Worktrees; each Worktree counts only its own sessions.

- SSH profiles count unclosed SSH sessions. Idle or exited sessions still count until closed.

- A registered Worktree without sessions and a merely selected profile do not light up. Redis and
  database rings require a successful connected state; opening, disconnected, busy or dirty state
  alone does not qualify.

- Rings disappear after the last session closes or a connection disconnects, remain visible when a
  project is folded, and use a darker green in light mode. Accessible descriptions identify open
  sessions or a connection.

- This steady indicator is separate from the blinking unread-completion hint on session icons.

#### Resource-ring checks

- Resource-ring validation: 217 frontend/build-helper tests pass, with eight optional Java/database
  checks skipped; the final focused sidebar regressions also pass. Changed source/test formatting,
  localization, documentation checks, TypeScript, the production frontend build and an isolated
  macOS desktop build pass.

- Native QA (`sh.uterm.desktop.qa.resourcerings`) renders the real Sidebar with isolated fixture
  state and verifies green rings for all five resource types, dark/light contrast, retained
  indication when folded, disappearance after sessions/connections close, and single-line name
  truncation at 176 px. The fixtures do not connect to servers; live SSH/Redis/database and
  Windows/Linux runtime acceptance remain pending.

#### Ring-color checks on Windows

- Ring-color validation on Windows: the focused activity-state regression, changed-style formatting,
  documentation checks and TypeScript/production build pass. An isolated Tauri/WebView2 host
  (`sh.uterm.desktop.qa.sidebarclose`) verifies all five resource types in dark/light mode: active
  icons and Redis glyph borders retain their inactive colors, while only the outer ring and glow are
  green.

- Folding retains the ring and original icon color. The fixture uses no real sessions or server
  connections; macOS/Linux runtime acceptance remains pending.

### Section folding and bulk actions

Sidebar section headings, including Active, Pinned, SSH, Redis, Databases and Projects, let you
click the name, arrow or remaining blank space across the full heading height to expand or collapse
the section independently. Enter/Space on the focused heading performs the same action.

- Right-side Add, database-component and bulk expand/collapse buttons act independently without
  toggling the section. Sections start expanded; folding is kept for the current app run and
  retained when the footer hides and shows a section.

- Folding only hides the sidebar entries, preserving SSH sessions, connected workbenches, selection,
  drafts and transactions. Add buttons and database-component management remain available while
  folded.

- The bulk expand/collapse button appears only when its section contains project or Worktree
  folders; an empty Projects section retains its heading and Add project entry.

#### Bulk-action visibility checks

- Bulk-action visibility validation: rendering the actual Sidebar component confirms that the action
  is absent with no projects, appears enabled after adding a project, still folds its folders, and
  disappears after the last project is removed. Five sidebar tests, TypeScript and changed-source
  formatting pass.

- Native visual acceptance of this visibility rule remains pending.

#### Section-heading checks on Windows

- Section-heading validation on Windows: all six focused sidebar checks, changed-style formatting,
  localization, documentation checks and TypeScript/production build pass. An isolated native
  Tauri/WebView2 QA host (`sh.uterm.desktop.qa.sidebarmenus`) renders the real Sidebar with
  temporary state and verifies all six headings: blank-space clicks at the top/bottom of the
  full-height button, independent folding, name/arrow clicks, Enter/Space, right-click isolation,
  independent Add/component/bulk actions, retained sessions/profiles/selection and retained folding
  after hiding/showing.

- Chinese/dark 248 px and English/light 176 px layouts pass visual inspection. The fixtures do not
  start real sessions, connect to servers or open application dialogs; full-application integration
  and macOS/Linux acceptance of the expanded click area remain unverified.

- The focused suite retains existing Vite WebSocket-port warnings, and the production build retains
  its large-chunk warning.

### Connection categories

The sidebar icon rail always offers SSH, Redis and database categories. Selecting a category filters
the list without changing profiles, sessions, connections, drafts or transactions. Settings →
Appearance → Icon highlight sets the selected navigation and inspector icon color.

### Adding connections from the footer

The rail's + menu offers New terminal, Add project, enabled Agent chats, Add SSH connection, Add
Redis connection and Add database connection. All three connection actions remain available,
including while a section is folded or the content list is hidden. Choosing an item closes the menu
and opens the existing connection dialog. Long labels wrap within the menu.

#### Connection-category and Add-menu checks

Automated checks cover folding, all eight legacy visibility-setting combinations, retained
profiles/sessions/selection, bilingual labels and a single correct Add callback with menu dismissal.
See [Sidebar styles](#sidebar-styles) for current platform validation.

### Middle-click to Close Session

Middle-click a sidebar session row or a terminal pane's title to Close Session, terminating that
session's process through the existing close flow. This works for project, Worktree, pinned and
standalone terminal/Agent sessions.

Middle-click does not select the sidebar target or trigger its context menu; terminal content
retains its existing mouse behavior. Close failures remain visible and retain the session for retry.

#### Validation and limits

- Windows validation: 158 frontend/build-helper tests pass, with two platform-specific tests
  skipped; 40 backend tests, 16 local-service tests, locked dependency installation,
  TypeScript/production build, localization and documentation checks pass. Component regression
  coverage includes project terminals, Agents, Worktrees and standalone terminals/chats,
  default-event suppression and right-button exclusion.

- Native Windows/macOS mouse acceptance remains pending. The production build retains its
  large-chunk warning.

### Active project tree

The sidebar’s Active section shows complete project trees for projects in the current workspace with
unclosed terminal or Agent sessions, including idle and Worktree sessions. Each project appears only
once, with its sessions and all Worktrees beneath it; no session count is shown.

- Pinned projects, Worktrees and sessions join the same active tree while retaining their pin flags
  and ordering. Closing the last session returns the project and its children to their original
  Projects/Pinned sections.

- Active is hidden when no projects have sessions; standalone terminals and chats stay in their own
  sections. Active projects and Worktrees with sessions initially expand, with separate in-memory
  folding that does not overwrite the original folder settings.

- Section-wide folding affects only that section; project dragging stays within the same section and
  pin status. Selecting an active project retains its selected session or opens its first stored
  session; selecting a session or a Worktree with sessions uses the editor save/close guard and is
  disabled during pending transitions.

- Project removal stays disabled until every session closes. Session and workspace changes update
  the tree immediately.

### Project paths and workspace moves

Project context menus offer Copy project path for the absolute local directory and Move to
workspace, whose submenu lists other workspaces by name. Hover, click or Right Arrow expands it;
Up/Down selects a destination and Left Arrow/Escape returns to the parent menu.

- The submenu displays above the parent menu without being clipped by its scroll area. It opens
  toward the available space near window edges and scrolls for long lists. With no other workspace,
  moving is disabled.

- Moving changes workspace membership only, preserving project files and sessions. New Worktree
  remains in the project menu; New terminal and Refresh Worktrees are not offered there.

- Terminal creation remains available through the toolbar, welcome page and shortcuts, and Worktrees
  are discovered automatically when projects load. Clipboard failures remain visible.

### Next and Previous workspace

Use Next workspace and Previous workspace in the command palette or Settings → Keyboard shortcuts.
The defaults are Cmd+Option+] / Cmd+Option+[ on macOS and Ctrl+Alt+] / Ctrl+Alt+[ on Windows. macOS
also lists both commands in the Workspace menu. Shortcuts can be customized or disabled; an existing
custom binding takes precedence over a new default that uses the same keys.

Switching follows the workspace list order, includes empty workspaces and wraps at either end. Each
workspace remembers its project, Worktree and session selection. With fewer than two workspaces,
both commands are unavailable.

Switching from a file uses the existing save/conflict and draft protections. Dialogs and pending
editor transitions block the shortcuts; switching is also available from Redis/database views.
Sessions remain running. Storage failures show an error and retain the current workspace.

#### Workspace shortcut checks

- Focused regression checks cover both platform modifiers, custom/disabled bindings, existing
  binding precedence, list order, empty workspaces, wrapping and selection restoration. App checks
  exercise actual keyboard events, native menu commands, dialog/repeat/composition guards and
  storage failures with mocked desktop services.

- On macOS, all 40 focused checks and 276 frontend/build-helper tests pass, with ten
  optional/platform checks skipped in the full suite. Formatting, localization,
  TypeScript/production and isolated desktop builds pass; the production build retains its
  large-chunk warning.

- Native QA (`sh.uterm.desktop.qa.workspaceshortcuts`) verifies both shortcuts and wrapping between
  two empty workspaces, disabled menu commands with one workspace, the Chinese shortcut settings
  layout and settings-dialog blocking. Windows/Linux runtime and native file-save/Redis/database
  switching remain unverified.

### Closing a session in another workspace

Close Session brings its target workspace and session into view before requesting termination,
including targets in other workspaces. Each invocation closes only one session; a failed close
retains the target for retry.

#### Validation and limits

- Regression tests cover draining another workspace's project, Worktree, standalone terminal and
  chat sessions. Native cross-workspace shortcut acceptance remains pending.

### Next and Previous session

Next session and Previous session cycle across all workspaces in stored workspace order, visiting
project sessions and then standalone terminals/chats within each workspace. Empty workspaces are
skipped and both directions wrap around.

- Navigation selects the destination workspace, project and Worktree together and remembers the
  previous workspace selection. With no active session it selects the first/last session in the
  current workspace, falling back to all workspaces.

- Editor and pending-transition guards remain active.

#### Validation and limits

- Regression tests cover cross-workspace navigation, wrapping, empty collections and selection
  restoration; native shortcut acceptance remains pending.

### Agent exit and close failures

Agent chats close automatically only on a successful exit (code 0), removing the chat pane and
sidebar entry after final output acknowledgement and successful host cleanup. Failed or unknown
exits retain diagnostics, as do ordinary shell terminals.

A failed Close Session retains the attachment and retries must confirm termination before removing
it; disconnected sessions may require reconnection first. Disconnection alone does not close a chat;
acknowledgement or cleanup failures remain visible.

Native Claude/Codex exit acceptance remains pending.

### Close Session shortcut order

Close Session closes one session per shortcut invocation: the active session in the selected
project, then its remaining sessions (including Worktrees), then other projects in stored order and
finally standalone sessions across workspaces. With no project selected, an active standalone
session takes priority.

When a file is displayed, the same Close Session shortcut (Cmd+W on macOS, Ctrl+W on Windows by
default) closes that file tab first, saving changes through the existing conflict/draft guard
without terminating a session. It is disabled during a pending file transition/dialog, or when
neither a file nor sessions remain.

#### Validation and limits

- Sequence tests cover draining all collections; an App shortcut regression test covers saving and
  removing the active file while preserving sessions. Native shortcut acceptance remains pending.

### Adding multiple projects

Add Project supports selecting multiple folders in the native chooser. Review the selected paths and
confirm Add to insert them into the workspace selected at confirmation.

All directories are validated before the batch is saved; existing projects in that workspace are
reused. Manual path entry replaces the multi-selection with a single path.

Native multi-selection interaction remains pending runtime acceptance.

### New chat working directory

New chat from the welcome page, command palette or shortcut uses the selected project's directory
(or selected Worktree directory) and belongs to that project. Without a selected project it uses the
standalone chat directory.

This routing uses the existing project-session creation flow; live Agent working-directory
acceptance remains pending.

### Background session discovery

Background local-session discovery retries every two seconds after each attempt. Connection timeouts
do not show an error banner; other synchronization failures remain visible.

A timeout does not clear saved sessions. Discovery results are reconciled against the latest state
inside the write queue, so a poll cannot replace sessions or selection created while it was pending.
A real Core-process regression holds a session-creation write, queues discovery of an older closed
session, then verifies that the new session and selection survive and unchanged polls do not write.

#### Validation and limits

- Focused automated tests cover timeout suppression and visibility of other failures; live timeout
  recovery remains unverified.

### Session grouping

Workspaces contain projects, standalone terminals and chats. Projects can contain Git worktrees.

Sessions support pinning, ordering, grouping, ungrouping, split resizing and directional focus.
Groups cannot cross project, worktree or standalone collection boundaries.

### Detachment and reconnection

The Rust local service owns PTYs and output replay. Quitting detaches the UI; Close Session
terminates a process.

Reconnection retains session identity and acknowledges replay in order. The service requires
authentication and binds only to loopback.

Running sessions prevent replacement of their service executable.

### Saved workspace data

Workspace storage uses schema version 7, accepts versions 3, 4, 5 and 6 and retains each original
version backup before saving upgraded data; settings accept version 1 and require valid current
fields. Invalid or unsupported saved data produces an error without overwriting the original value.

Startup reads only this application's workspace, without importing another application's state.

### Agent detection in shell sessions

Ordinary shell sessions on macOS and Windows recognize descendant Claude/Codex executables and
display their Agent icon in the sidebar. Unix process snapshots retain full executable paths even
beyond the default ps column width; a real subprocess regression covers a long path with spaces.

Detection refreshes at most once per second; exiting the Agent restores the terminal icon. Only
executable names `claude`/`codex` (or their Windows `.exe` names) are recognized; Node.js wrappers
and custom Agent names are not identified.

#### Validation and limits

- Process-tree tests cover session isolation, ambiguous matches, paths with spaces and clearing
  identity after exit; all local-service tests, formatting, documentation checks and
  frontend/desktop builds pass on macOS. Native icon switching and Windows runtime acceptance remain
  unverified.

### Removing a saved connection

Removing an SSH, Redis or database connection opens a confirmation dialog showing the connection
name and explaining that its saved profile and remembered password will be deleted. Only Confirm
removal starts removal; Cancel or Escape keeps the profile and password and returns focus to the
entry.

Cancel receives initial focus. Existing session, file, transfer, connection, draft and
SSH-dependency protections still apply.

A pending confirmation is cancelled if the profile changes, becomes protected, disappears, the
workspace changes or the sidebar/connection section is hidden.

#### Connection-removal checks

- Connection-removal validation: five connection-related frontend regressions pass. Focused
  component coverage includes all three connection types in Simplified Chinese and English,
  cancellation, Escape, initial/returned focus, a single callback after confirmation, live
  protection changes and invalidated targets.

- An isolated Windows desktop app (`sh.uterm.desktop.qa.connectionremoval`) verifies both languages,
  Cancel/Escape preserving saved profiles, returned focus and confirmed profile removal for all
  three types using disposable profiles without credentials or server connections. Dark/light
  dialogs and long-name wrapping pass visual inspection.

- Frozen dependency installation, changed-file formatting, localization/documentation checks,
  TypeScript/production build and the isolated desktop build pass. The full frontend suite
  encountered a Vite SSR module-loading timeout.

- Remembered-credential integration and macOS/Linux runtime acceptance remain unverified; the
  production build retains its large-chunk warning.

## SSH and remote files

### Connection setup

The sidebar’s SSH connections belong to the current workspace. Add a connection using a host
address, port (default 22), username, remote system (Linux/macOS or Windows) and optional file root.

- Choose Host address or OpenSSH configuration. Authentication defaults to OpenSSH automatic
  selection. More settings contains the optional connection name, remote system and file root; a
  blank name uses the host. Save only stores the profile; Save and connect stores it before creating
  a terminal. Failed storage never authorizes a new login.

- Show effective configuration runs the system client's configuration resolution without opening a
  remote login. It shows the effective username, address, port and whether a jump host or proxy is
  configured. Explicit username/port values override inherited configuration; blank values in alias
  mode remain inherited.

- A blank username uses OpenSSH configuration or the local account; a blank root uses the server
  login directory. Host alias mode retains existing profiles and reads `~/.ssh/config`, including
  Include files, without rewriting it.

- Blank port/username in alias mode inherit OpenSSH values. Authentication supports OpenSSH
  automatic selection, a private-key file/ssh-agent, or a password entered in the connection dialog.

- System OpenSSH must be installed; Windows users can install the OpenSSH Client optional feature.
  No SSH executable, JVM or new runtime dependency is bundled for these connection options.

### Shared SSH configuration service

The development clients share OpenSSH configuration discovery and resolution through
`uterm-core::ssh`. Existing Tauri commands use the same service; `ssh.info` and `ssh.resolve` also
expose read-only Core/FFI results with generated Swift/TypeScript types. Discovery reads at most 1
MiB per file, 128 files and 16 Include levels, and does not execute Match rules. Explicit resolution
retains the system client's `ssh -G` behavior, a 15-second timeout and bounded output. The results
contain endpoint metadata; password/private-key content fields are rejected.

`uterm-core::ssh::paths` also owns the existing SFTP lexical path rules. Tauri imports the same
functions: POSIX/Windows server-root normalization, validated relative paths, component containment
and joining. Server rules are independent of the local OS. Drive/slash handling, literal Unix
backslashes, Unicode names, the 4,096-byte relative-path limit and existing error codes stay
unchanged. The transport still validates roots and resolves server symlinks before containment;
these helpers do not authorize a connection or resolve filesystem links.

`cargo test --locked --manifest-path crates/uterm-core/Cargo.toml --lib ssh::paths::tests` passes
two Linux x86_64/Rust1.99.1 checks, including the migrated boundary cases and exact UTF-8 byte
limits.
`cargo test --locked --manifest-path crates/uterm-core/Cargo.toml --lib ssh::files::tests -- --nocapture`
passes four actual OpenSSH `sftp-server` subprocess checks: conflict-safe save, symlink/original
retention, streaming cancellation and confirmed overwrite, recursive deletion and root refusal.
These use the real SFTP subsystem over pipes; they do not test SSH authentication, host trust or
network reconnection. Platform CI retains the Core/backend test logs for the actual source. No new
FFI or JSON path endpoint is claimed.

The shared `ssh::auth` service owns password-reference binding, temporary credentials,
remember/forget and bounded one-use askpass servers. Both clients can supply a host-trust
confirmation callback and a credential-store port. The shared system adapter retains macOS Keychain
and Windows Credential Manager service/reference names; Tauri still supplies its existing
application identifier and native dialog. Redis/database credential callers reuse that same system
adapter without changing their namespaces. Credentials remain bound to the connection and effective
OpenSSH endpoint; renaming a connection does not invalidate them, while an endpoint change refuses
reuse. Corrupt credential data returns a fixed error without exposing its contents.

The two Linux `ssh_auth` integration checks use an in-memory credential port, real OpenSSH
configuration resolution and loopback askpass. They cover changed targets, retention conversion,
forgetting, malformed storage and proxy-password refusal. Platform checks use unique QA references
before creation, after writing and after deletion; repeated deletion is safe. The SSH port maps only
OS not-found to an absent reference, leaving other errors visible and the legacy Redis/database
adapter unchanged. Actual login and platform evidence appear below.

The shared `ssh::files` and `ssh::tunnels` services own remote roots, serialized safe writes,
streaming transfers, cancellation/quit protection, listener readiness and owned OpenSSH processes.
Tauri delegates its existing commands to them and retains native pickers and progress channels.
Generation-aware cancellation/stop refuses stale requests; the existing Tauri command signatures
remain compatible. Cancelling a pending tunnel also releases its authentication future. Quit blocks
new transfers while waiting for active cancellation; abandoning that wait releases the temporary
block so the client can continue.

Final client shutdown stops its owned SFTP processes even when a pending reader retains the remote
root. It refuses late spawns without stopping another client's SFTP processes or hosted SSH
terminals. The Tauri exit callback uses this cleanup; ordinary quit guards still run first.

`cargo test --locked --manifest-path crates/uterm-core/Cargo.toml --lib ssh:: -- --nocapture` passes
21 Linux checks. Real isolated `sshd`/internal-sftp cases cover Unicode transfers, originals
retained after cancellation/interruption, explicit reconnect, host keys/CAs, sibling tunnels/stale
stops and owned-process shutdown while a reader retains its remote root. Unix fixtures require
`/usr/sbin/sshd` and `ssh-keygen`; macOS requires noninteractive sudo for the isolated server. An
interrupted upload may leave a hidden temporary file; the original stays intact and retry is
explicit. Automatic remote orphan cleanup is not claimed. The TCP proxy and tunnel-echo fixtures
explicitly restore blocking mode on accepted connections, retaining read timeouts so macOS
nonblocking inheritance cannot cause premature EOF.

`PYTHONDONTWRITEBYTECODE=1 python scripts/ssh-core-qa.py CORE_BINARY EVIDENCE_DIRECTORY` drives the
public Core client against a real service. Windows AMD64/macOS ARM64 reports pass at source
`721fd5ae84ac1c80694cea78b6eb9b72d26d5362` / tested merge `5e4f2fc737a07b850408d16bfcdbff1d2d1b085f`
in [CI 42022428501](https://github.com/YondFane/uTerm/actions/runs/42022428501), dirty=false and
cleanup=true. The reports are `ssh-core-live.json`, in artifacts
`legacy-checks-windows-latest-721fd5ae84ac1c80694cea78b6eb9b72d26d5362` and
`legacy-checks-macos-latest-721fd5ae84ac1c80694cea78b6eb9b72d26d5362`. These accept the service
only; that overall GUI run failed.

All 13 service checks pass: actual password/OS-store authentication, stale saves, exact Unicode
bytes, real key-authenticated ProxyJump, changed-key refusal, correct/wrong CAs, generation
cancellation, interrupted overwrite/reconnect, sibling tunnels, quit, actual first-host
rejection/approval followed by authentication, single-use responses and secret exclusion. Service
reports do not replace actual-window screenshot acceptance.

The Windows fixture downloads a pinned, checksum-verified Win32 OpenSSH server, runs an owned SYSTEM
task and creates a temporary account with explicit generated-key ACLs. It prepends unique aliases
only to the disposable GitHub CI user's configuration and restores the original bytes. macOS uses a
short-lived account/home and adds/removes only that account in an existing SSH access group.
Production SSH services are untouched. Secret-exclusion checks read server logs after shutdown to
avoid Windows exclusive log handles.

`PYTHONDONTWRITEBYTECODE=1 python scripts/ssh-tauri-qa.py` runs saved-profile, authenticated SFTP
listing/preview, remote-terminal and actual quit/reopen scenes in the isolated real Tauri app,
retaining existing ownership/recovery checks. The terminal must be the visible panel selected by the
shared snapshot. It waits for a running attachment before reading the host endpoint and confirming
SSH host/connection identity. Reopening verifies the same session, generation, host PID and replay.
Output from a hidden local terminal cannot satisfy remote acceptance. The ownership fixture creates
its terminal through the enabled, visible project-home action after runtime readiness, avoiding
closed sidebar popovers.

SSH-output captures exercise the application's shipped fallback through actual WebGL context loss.
They require a visible DOM-rendered row containing the remote result, then wait for painting.
Reports record the initial renderer, injected loss and recovered renderer. This checks real-app DOM
fallback output; it does not accept default GPU capture. Blank canvases, hidden accessibility text
or a runtime report alone cannot establish visible output.

Screenshots carry source/platform metadata. The Windows helper uses Win32 PrintWindow on the actual
owned QA HWND, recording each image’s method, dimensions and visibility samples. Screen-copy
fallback requires unobstructed samples and restores the topmost flag. Process reports distinguish
main-process exit from output-handle closure. Source-specific platform reports, valid images and
remaining checks are tracked in [#36](https://github.com/YondFane/uTerm/issues/36). Manual
picker/IME checks are unexecuted; Unicode samples live in `shared/fixtures/ssh-qa.json`.

### Native SSH workspace

In the isolated native QA app, **File → SSH connections…** opens the connection window; SSH sidebar
rows open it too. Select a profile from the current workspace or add a host address/OpenSSH alias,
port, username, authentication, remote system and file root. A blank alias port inherits system
configuration. **Show effective configuration** resolves metadata without starting a login.

**Save connection** before **New SSH terminal** or **Connect files**. Revision conflicts retain the
form; failed profile storage attempts to remove a newly created credential reference and reports
cleanup errors. Restoring an existing SSH terminal only reattaches; new terminals and splits are
explicit login actions.

The file area offers directory/hidden-entry browsing, read-only text preview, uploads, confirmed
replacement, downloads and cancellation; download other preview types to open them. Window-close
protection also covers local file selection. Background operations carry generations, rejecting
stale cancel/stop requests. Transfer byte counts cross Rust/Swift/TypeScript as decimal strings to
preserve u64 precision. Forwarding binds only to loopback; rules require explicit start and can be
stopped independently. Starting a transfer clears earlier feedback; selecting another profile or a
new draft clears the previous profile's transfer status.

Passwords use in-memory references valid for the application lifetime or the QA app's own
system-credential namespace. The native SSH Core client stays alive across terminal transport
reopening, preserving temporary credentials; quitting the app closes it and clears those references.
Password connections to unknown hosts use a real native fingerprint confirmation sheet; declining
rejects the connection. Key/automatic authentication retains OpenSSH's strict known-host policy.
Closing the SSH window or quitting resolves configuration drafts, transfers and forwarding while
hosted SSH terminals remain running.

#### Native SSH validation and limits

Linux client contracts cover profile CAS, preserved sessions/dependencies, secret exclusion,
explicit resume and one-use trust. The common `shared/contracts/ssh-progress-v1.json` exercises
actual Rust/Swift/TypeScript JSON boundary values above `2^53` and at `u64::MAX` as decimal strings,
checking precision rather than only type names.

`bash scripts/macos-ssh-smoke.sh` uses the isolated native QA app, temporary
accounts/keys/known_hosts and real OpenSSH. Source `721fd5ae84ac1c80694cea78b6eb9b72d26d5362` /
tested merge `5e4f2fc737a07b850408d16bfcdbff1d2d1b085f` passes on ARM64 and Intel in
[CI 42022428571](https://github.com/YondFane/uTerm/actions/runs/42022428571), dirty=false and
cleanup=true.

The two `native-qa-macos-15[-intel]-721fd5ae84ac1c80694cea78b6eb9b72d26d5362` artifacts contain
`ssh-live.json`, `ssh-service-core.json`, toolchain/test logs and ten real WindowServer captures.
Scenarios cover retained conflict drafts, SFTP uploads/downloads, visible transfer
progress/cancellation, actual forwarding, key/password remote PTYs, detach/replay/independent close,
English/Chinese, dark/light and a 760px window. Real NSAlert rejection and approval followed by
authentication pass, as do remembered/temporary conversions, obsolete-reference deletion and
authenticated temporary-password reconnect after terminal transport reopening.

Visual review confirms password-terminal output and the connection window after native trust
approval. New source still requires its own CI evidence; previous SHAs cannot accept it. Manual
pickers, IME and macOS 14 interaction are unexecuted; minimum deployment targets/builds do not
replace acceptance. Issue #36 records source-specific acceptance separately from merge/release
status.

### Quick connections and host search

Choose **Quick SSH connection** in the SSH sidebar and enter a Host alias, `user@host:port` or
`ssh://user@host:port`. IPv6 addresses with a port use brackets, such as `user@[::1]:2222`. A plain
alias inherits OpenSSH configuration; explicit addresses default to port 22. Commands, embedded
passwords, URL paths and invalid ports are rejected. Both clients use the same address form and
parser. The native form opens over the main workspace. Cancel, Escape and Command-W close only the
form; existing terminal generations and editor views are retained. Background commands are disabled
while it is open. A pending submission blocks dismissal and quit until its actual result. Closing
restores the previous visible control or active document/terminal focus.

The shared core saves the temporary connection and first session in one revision-checked write. It
rejects a workspace changed after the dialog opened, duplicate IDs and stale revisions without
leaving half a connection. SSH login starts only after saving succeeds. Saving disables duplicate
submission and dismissal; failures retain the address for explicit retry. A later SSH launch failure
retains the saved connection and reports a separate error.

Quick connections use automatic OpenSSH authentication in the terminal. They appear as Temporary;
their local settings remain available for attachment after reopening the app. Closing the last
session removes a temporary connection after file channels, file tabs, transfers and tunnels have
been released. **Save connection** keeps the profile without changing existing sessions. Save it
before selecting it for a Redis or database tunnel.

**Search SSH hosts** filters the current workspace by connection name, host and username, ignoring
case. Clearing the search restores all hosts; filtering preserves sessions and connections. The
native search is available in All and SSH and retains its input focus when filtered rows reload.
Native temporary connections offer **Save connection** in their context menu and connection window.
Cleanup retains file/tunnel ownership and database/Redis dependencies, including legacy SSH-host
references; an unresolved native connection draft also defers cleanup.

SSH host filtering retains the mounted native search cell while inserting/removing result rows. An
empty query explicitly restores all hosts and external query changes synchronize the editor. At head
`1a9754a0f86acaf9178dbe65dd30e91957469627`, merge `e59b91c76512f176a5fe904a38c46311a3a31931`, both
native architectures pass the actual typed search/clear/focus and original Quick SSH
create/keep/prune flows. Reports and nine screenshots are in the
[ARM](https://github.com/YondFane/uTerm/actions/runs/43051436660/artifacts/13871301710) and
[Intel](https://github.com/YondFane/uTerm/actions/runs/43051436660/artifacts/13871038779) artifacts.
Those flows use a separate Quick SSH window and do not accept the new main-window modal. The ARM
matrix passes real PostgreSQL disconnect; Intel database QA remains unexecuted after its download
DNS failure.

At source `becc4e233a0354137fe8248486e8dd7fb0df29fa`, merge
`198238492c3f298999257b09bb3813468a1b11b3`, Intel Personal passes real install, initial/replacement
windows and the Sparkle SDK suite. Its
[artifact](https://github.com/YondFane/uTerm/actions/runs/43065251107/artifacts/13876314613)
includes English/dark 1100px and replacement Chinese/light 640px Quick SSH images. Both were
inspected: the form is in the main window and operations pass, but an opaque WebKit canvas hides the
workspace, so visual acceptance fails. Passing window identity alone is insufficient.

The candidate bounds WebKit to the measured form, paints the outer dimming with native views and
clips the form's corners. A ResizeObserver reports content height without changing saved data.
Acceptance requires actual centered form bounds in both clients, matching within one pixel, with the
live terminal retained around the form. Missing, oversized or clipped bounds fail collection; the
native test also clicks the actual backdrop and checks invalid layout arguments. At source
`760d433f319a0e95685e7dd4724a8b23b14b07ec`, merge `6e78c0fd82c2aeb6a760d939e97c420bf3488c1d`,
[36 paired scenes](https://github.com/YondFane/uTerm/actions/runs/43074768506/artifacts/13882103469)
pass the bounds policy; both Quick SSH original pairs were viewed and retain the surrounding
workspace. Actual backdrop Cancel and invalid layout checks pass the Intel native inspector. The ARM
Personal initial/replacement windows pass, but its full SDK suite fails in redundant outer cleanup
after the installed app has already reattached, retained its PTY/draft and explicitly stopped its
host. The second host-status query races shutdown. QA skips that query only after the internal
successful-cleanup flag, retaining fallback cleanup and all failures. The coordinator also uses the
shared process-exit observer to require the retained host PID to exit and its endpoint to disappear;
it never terminates the host to force a pass. Seven focused Linux updater/exit checks pass,
including delayed endpoint removal and a still-running process. Python syntax and documentation
checks pass; current-source Mac verification remains pending. Package/window success alone does not
accept the update scenario. The
[failure artifact](https://github.com/YondFane/uTerm/actions/runs/43074768643/artifacts/13881394081)
retains the actual reports. The full functional-parity flag stays false.

Twenty-seven targeted Linux UI/transport/grid checks, 20 paired-evidence policies and 14 Personal
policies pass. The complete frontend run passes 473 tests with 11 conditional skips; type/build,
contracts, i18n, format and documentation checks pass. Loading failures retain modal Retry/Cancel
and prevent duplicate reads. Two shared invalid-address scenes still require actual sidebar opening,
visible rejection, retained input, Cancel/Escape/Command-W and unchanged workspace/session
generations. The expanded strict grid requires 39 ordinary captures / 38 pairs (77 originals
including restart and two PR scenes), without accepting the opaque historical images as proof of the
new renderer.

Linux validation passes six targeted core tests for atomic creation, rollback, stale revisions,
private fields, retention and cleanup; the complete core, FFI and desktop-backend suites also pass.
These core results belong to the existing implementation; this modal phase changes no Rust code.

At the same `becc4e2` source, the
[ARM native matrix](https://github.com/YondFane/uTerm/actions/runs/43065251099/artifacts/13878942719)
passes completely, including GitHub switching, real SSH trust and PostgreSQL. Its JDBC provenance
retains the pinned 42.7.14 digest and primary Central URL. The
[ARM Personal artifact](https://github.com/YondFane/uTerm/actions/runs/43065251107/artifacts/13877484403)
also passes package, initial/replacement and SDK checks; its Chinese Quick SSH original was
inspected and shows the same opaque background. Intel SSH trust remains unresolved. The ordinary Mac
job executed no steps:
[GitHub reports](https://github.com/YondFane/uTerm/actions/runs/43065251386/job/130678363243) that
no hosted runner acquired it after multiple attempts, with macOS ARM capacity notices. No paired
artifact exists for that run; a fresh ordinary run remains required.

### Jump hosts

In **More settings → Jump host (optional)**, choose an OpenSSH alias or enter one jump endpoint,
such as `ops@bastion:2222`. Leaving it blank inherits OpenSSH configuration. The effective
configuration preview includes the jump setting without logging in.

The same jump setting is used by terminals, SFTP, port forwarding and Redis tunnels. The jump host
uses its own OpenSSH configuration or ssh-agent; a saved target password or target-specific key is
not automatically applied to the jump host. Password mode does not support jump hosts. Multiple
jumps and ProxyCommand remain available through existing OpenSSH aliases. Older session hosts must
be safely restarted before creating sessions with an explicit jump setting.

### Local port forwarding

Open **Port forwarding** in the SSH connection header. Enter a local port, a remote address and a
remote port, then select **Add forwarding**. Rules are saved with the connection and start only when
**Start forwarding** is selected. The SSH server accesses the remote address, so `127.0.0.1` refers
to that server. Local listeners bind only to `127.0.0.1`.

Startup, listening, failure and stopped states are shown independently of terminals and SFTP. A
listening status confirms the local SSH listener, not remote service availability. **Stop
forwarding** releases the process and port; active rules cannot be removed. Hiding the panel keeps
forwarding active. Quitting stops these forwards; reopening does not restart them. Terminal
attachment continues to follow its existing lifecycle.

Opening Port forwarding hides the remote file panel while preserving its connection. Opening Remote
files hides the forwarding panel while leaving active forwards running.

- Up to 16 rules can be saved per connection, with no duplicate local ports within that connection;
  up to 16 forwards can run across the app. Ports must be 1–65535. Occupied ports and authentication
  failures remain visible; startup waits up to 60 seconds.
- Automatic/key authentication requires trusted hosts and noninteractive keys/ssh-agent. Password
  authentication follows the existing password and fingerprint policy. The connection remains
  protected from editing or removal during startup or forwarding.
- Local TCP forwarding is supported. Remote forwarding, dynamic SOCKS forwarding and automatic
  startup are not exposed. Profiles that already contain OpenSSH forwarding rules are rejected for
  this panel; use an alias without those rules to avoid opening unintended listeners.

### Connection workspace

Selecting a host returns to its last selected session in the current app run, or shows the
connection overview if it has no sessions. The overview lists the remote system, authentication and
file root. Selection does not open an SFTP connection.

The connection header shows the current session's target, resolved endpoint, terminal process status
and file connection status. New SSH terminal, Remote files and Edit SSH connection stay nearby.
Editing remains disabled while sessions, file connections, retained file tabs, transfers or
dependent workbenches use the connection.

Terminal status describes the local SSH process or attachment, not successful server authentication.
Complete fingerprint and interactive authentication prompts in the terminal. Ended sessions retain
their output; reattaching restores an existing local attachment, while a new terminal starts a new
remote login.

### Passwords and host verification

Passwords last for the current app run unless Remember password is selected. Remembered SSH
passwords are stored in macOS Keychain or Windows Credential Manager; workspace/session data
contains only an opaque reference.

Editing can keep a password by leaving its field blank, or move it between temporary memory and the
system store. Passwords bind to the connection and resolved endpoint, so target changes require
reentry.

Storage failures roll back only newly created credentials and preserve the old profile. Secrets are
not returned from the store to the frontend or placed in process arguments, environment variables,
workspace files or logs.

A short-lived authenticated loopback helper supplies the password once through OpenSSH askpass; the
helper reuses the app executable. Password mode supports ordinary password authentication, with a
native confirmation for unknown host fingerprints.

It rejects ProxyJump/ProxyCommand, verification codes and password-change prompts. Automatic/key
modes retain OpenSSH jump-host behavior; add encrypted keys to ssh-agent before using files or
tunnels.

### SSH session lifecycle

Each connection supports multiple terminal sessions, pinning, ordering and splits within that
connection. SSH runs inside the existing local PTY service with normal terminal input, resizing and
output replay.

Automatic/key modes retain terminal fingerprint and interactive authentication prompts; password
mode uses the configured password and native fingerprint confirmation. Quitting detaches while the
local SSH process continues; Close Session terminates that SSH process.

Remote process survival depends on the server. Reopening attaches to existing sessions without
silently starting new network logins.

Restart creates a new session and retains the old output. A network failure does not restore the
original remote shell; persistent server tasks require a tool such as tmux.

Older background services must be safely restarted after closing their sessions to enable SSH.

### Opening remote files

Open Remote files, then choose Connect files to start SFTP using the profile's host, port, username
and authentication. Connection progress and errors are separate from terminal status. Closing the
panel retains its cached connection; Disconnect files passes through editor save protection and
releases only file channels. Reconnect also passes through that protection and keeps the previously
resolved endpoint and root as its expected target. Neither selecting a host nor disconnecting files
starts a login automatically.

Automatic/key modes require a trusted host and noninteractive key/ssh-agent authentication; confirm
an unknown host in an SSH terminal first.

Password mode can also confirm a new host in a native dialog. File roots are independent of shell
`cd`; Windows roots must use local drive paths, not UNC shares.

Remote Git, GitHub, local directory tools, full-tree search, directory transfers and transfer resume
are unavailable.

### Editing within the remote root

The file tree supports hidden files, text editing, supported image/PDF previews, creating
files/directories, renaming and deleting files or directories with all their contents. Deletion
requires confirmation and cannot remove the selected root. Text retains the existing 2 MB limit,
UTF-8/BOM and line-ending handling, conflict checks, save/close guards and local recovery drafts.

A file’s identity includes its SSH connection, resolved endpoint and canonical root, so drafts
cannot silently move to another server after configuration changes. Symbolic-link reads stay inside
the root; mutations through links are rejected.

Paths are interpreted using server rules. Remote filenames containing backslashes, colons or control
characters are excluded.

### Safe saves and conflicts

Saves use a same-directory temporary file, content version checks and the server’s
`posix-rename@openssh.com` extension; the original is never deleted as an overwrite fallback.
Servers without safe replacement allow reading, downloads and new-file uploads but open existing
files read-only.

Normal permission bits are retained when available; uTerm does not preserve Windows ACLs. Conflict
checks are optimistic and do not lock out other server writers.

Network failure after a commit can leave its result uncertain; retain the draft and reread before
retrying.

### Transfers and connection protection

Upload files from the toolbar or a directory’s context menu; download an ordinary file from its
context menu into a native save dialog. Transfers stream bounded chunks and show byte progress,
completion, errors and cancellation.

- Upload overwrite is off until explicitly selected; directory and link transfers are rejected.
  Cancellation attempts to remove temporary files, while disconnection may leave a `.uterm-*`
  temporary file for manual cleanup.

- Quitting with active transfers offers waiting or cancelling transfers before the editor save
  guard. Updates are blocked during transfers.

- At most four transfers and sixteen cached remote file connections are allowed; Reconnect releases
  that connection’s previous file channels. Editing and removal are disabled while a connection has
  sessions, retained file tabs, active transfers, starting/running port forwards or a
  connected/busy/dirty Redis workbench using it.

- Removal also requires removing dependent Redis profiles. Saving an idle SSH profile updates
  dependent Redis profiles; remembered Redis credentials remain bound to their original endpoint.

- Existing sessions retain their target.

#### SSH and SFTP checks

Commands and source-bound reports for configuration resolution, paths, authentication/credentials
and real services appear in Shared SSH services above. Native SSH workspace records Swift windows,
screenshots and unexecuted checks. Service and actual-window reports are accepted separately;
process fixtures/builds do not establish authenticated login.

`pnpm test`, `pnpm test:backend` and Core checks cover quick-address validation, temporary-profile
promotion/cleanup, configuration upgrades, workspace/session isolation, remote draft identity,
attach-only restoration, credential target binding and failed-save cleanup. Process fixtures cover
readiness, startup failure, timeout, cancellation and owned cleanup. Real-service checks separately
cover authentication, certificates, path boundaries, stale saves, streaming transfers, cancelled
overwrite, network reconnection and preserved sibling tunnels.

System-credential checks use unique QA namespaces and verify reads before creation, after writing
and after deletion, including repeated deletion. Passwords pass only through bounded, authenticated
one-use askpass; workspace exports, status summaries and test logs exclude them. Password-mode jump
hosts and OTP are unsupported. Linux native GUI, manual pickers/IME and interaction on the minimum
macOS version remain unaccepted.

Current SSH authentication options add code without new runtime dependencies. Current release
installer sizes have not been measured; the isolated debug application build is validation evidence,
not an installer-size estimate.

## Redis connections and workbench

### Shared Redis services

`uterm-core::redis` owns connection/credential binding, TLS/SSH transports, binary key/member
identity, bounded queries and read-only/write/TTL/conflict rules. Tauri supplies its application
identifier and existing SSH authentication adapter, retaining native CA selection and application
exit. State clones share connection, opening and draft protection. Shutdown rejects late handshakes;
cancelling authentication releases its opening slot and socket. Existing credential namespaces and
connection configuration remain compatible.

The Core JSON interface returns operation IDs/generations without blocking the caller on Redis I/O.
At most eight running or unread business results are admitted, with separate capacity for
disconnect, write-permission and draft/quit controls. Result lists omit values and parameters. Reads
check the generation and consume a completed result only once. Profile save/removal uses
revision-checked storage and refuses active/dirty profiles. Quit freezes new work; resume retains
hidden draft protection. Client close drains cancelled async tasks as well as owned sockets and SSH
processes; it does not retry writes with an uncertain outcome.

The isolated native app opens **Redis connections** from its sidebar or **File → Redis
connections…** and reuses the connection form and workbench through the scoped content transport.
Temporary passwords match canonical configuration values; changing an inactive target recreates its
workbench without the previous password. Profile conflicts retain input.

Redis handlers explicitly include structured error codes without changing generic error-string
formatting. Profile conflict messages do not need to repeat the code for the form to retain input
and request a reload.

Closing the window hides it while retaining its connection/draft; quitting freezes the view, checks
pending operations and confirms draft loss. Cancelling quit resumes it with draft protection. CA
selection uses AppKit; content cannot choose a picker path. Language/theme updates use shared
settings without saving defaults.

#### Shared-service validation and limits

Linux x86_64 / Rust 1.99.1 passes all 11 Redis service regressions with real Redis 7.4.7/TLS and
OpenSSL, including binary values, TTL, stale snapshots, read-only enforcement, TLS name/CA rejection
and uncertain writes without retry. Two public host-port regressions cover late authentication after
shutdown and cancelled authentication. Full Core/FFI, host, Tauri backend (41 passed / two ignored),
frontend (419 passed / ten skipped), types, production/desktop builds and contracts pass.

Five additional async/contract regressions pass: unread-result backpressure with disconnect still
available, generation/single-consumption checks and parameter exclusion, quit/resume with hidden
drafts, closing during authentication, profile CAS/secret rejection and exact text/binary JSON. The
authentication/close race passes 20 repeated runs after draining cancelled tasks on close.
TypeScript fixture checks pass. Swift exact-value, actual C ABI guards and the real writer-lock
read-retry/mutation-refusal checks pass on macOS ARM64 and Intel at source `7306f74` / tested merge
`5bc1ec99a1e61007dc75687a644087011556bc69`.

`pnpm test:redis` explicitly enables the seven real-server checks, each using temporary loopback
servers. The normal Core suite runs the other four service checks and the two host-port checks.
`node scripts/redis-core-smoke.mjs /absolute/temporary/evidence-directory` records toolchains,
actual test names, logs, source/merge SHA and source-tree state. Shared Redis CI builds the verified
7.4.7 source with TLS and uploads those reports. Native Redis and platform credential evidence is
archived in [#39](https://github.com/YondFane/uTerm/issues/39); service tests alone do not establish
UI acceptance.

Linux manager regressions cover profile conflicts, password exclusion, modal freeze/resume,
configuration key ordering and clearing a password after editing the target. Connection forms and
the native draft guard use secure random UUIDs in custom-scheme contexts without `randomUUID`.

`bash scripts/macos-redis-smoke.sh` requires a macOS graphical session, Homebrew and Python 3. It
starts an owned temporary loopback Redis server, checks data again after the application exits and
records six WindowServer images. The Tauri harness records six real Redis scenes. Windows uses the
portable community redis-windows 8.10.3 Cygwin archive, verified against SHA256
`8000848c48668c8cd32f21386ce951d0e02c1aefae39443ab9d3de11ff8ebf9e`; macOS records its actual
Homebrew version and binary digest. Neither harness installs a Redis system service.

Redis acceptance uses source and actual tested commit `940f8d130114c366077015d82bb33114e2734fb1`;
the workflows directly test the branch with `workflow_dispatch`, rather than a synthetic PR merge.
Native Redis checks pass on macOS 15.8.2 ARM64 / Redis 8.10.3 and macOS 15.7.9 Intel / Redis 8.10.1.
Each native report records six WindowServer images, exit code 0, a clean source tree and data
verified again after app exit.

Tauri passes on macOS 26.7.2 ARM64 and Windows Server 2025 x64, both using Redis 8.10.3. Each report
contains 63 successful application QA scenes, including six real Redis scenes, with no cleanup
errors. Independent service reports verify final data, stopped owned processes, readable evidence
and no leaked credential. All 24 Redis images have been inspected. Artifacts:
[native ARM](https://github.com/YondFane/uTerm/actions/runs/42143907577/artifacts/13469139024),
[native Intel](https://github.com/YondFane/uTerm/actions/runs/42143907577/artifacts/13470210542),
[Tauri Mac](https://github.com/YondFane/uTerm/actions/runs/42143901906/artifacts/13469443317),
[Tauri Windows](https://github.com/YondFane/uTerm/actions/runs/42143901906/artifacts/13469723539)
and
[Linux service tests](https://github.com/YondFane/uTerm/actions/runs/42143911635/artifacts/13468882766).

The Intel job and Native workflow fail a separate database editor-input check tracked in
[#38](https://github.com/YondFane/uTerm/issues/38#issuecomment-6674618606); their independent Redis
and bridge checks pass. Redis acceptance does not establish that the whole PR or migration passes.
Earlier failures and their corrections remain linked in the
[#39 completion evidence](https://github.com/YondFane/uTerm/issues/39#issuecomment-6674752428). QA
waits for visible, enabled controls and clicks once without retrying server writes; Python fixture
imports use `-B`, retaining the clean-tree guard.

The expanded cases browse a real 20,001-member list with 200 rendered and returned rows per page;
the missing edit snapshot keeps member update/delete controls disabled above the 10,000-member
limit. Final checks confirm the large list is unchanged. Separate cases use 401 editable list
members and require 200 rendered rows per full page. They cancel then confirm deletion at index 400,
verify the remaining last value independently, change TTL to 1,800 seconds, and cancel then confirm
deletion of a separate key. Final server checks verify the 400 remaining members, expiration and
unchanged binary sibling. Real disconnect and application quit are cancelled while a draft exists,
then the connection/draft is checked. Native QA captures the actual quit alert and activates its
Cancel button; this automated action is separate from #42's manual keyboard/IME acceptance. These
automated platform cases pass at the source above; human #42 acceptance remains unperformed.

Tasks without a required human check can close once implementation and source-bound automated
platform evidence satisfy their acceptance criteria. #39 does not wait for #42's separate human
interaction checks; missing implementation, reports or screenshots still keep it open.

A platform-only Rust test and the expanded application checks use unique QA credential references in
macOS Keychain or Windows Credential Manager. They check binary CRUD/replacement without changing a
neighboring item, authenticate to real Redis using only a saved reference, reject a changed target,
remove the credential and reject subsequent reuse. An absent item is reported as missing; permission
and other access errors remain failures. Linux runs no OS credential cases. The macOS/Windows checks
pass at the source above; Linux results do not replace OS credential evidence.

Current Linux checks pass Core/FFI, all 11 real Redis/service regressions, backend (41 passed / two
ignored), frontend (419 passed / ten skipped), types and QA/desktop builds. Builds sharing `dist`
run sequentially so one build cannot remove assets while another embeds them. Evidence inspection
runs after owned SSH/Redis services close; transient exclusive handles are bounded, and persistent
unreadable files or detected passwords produce a failed report. Key navigation opens the actual
drawer and requires an on-screen row. Manual picker, keyboard/IME and the remaining M4/M5 acceptance
remain pending; automated Redis acceptance does not establish those results.

### Redis connection setup

Redis connections belong to a workspace. Add a name, host, port, database number and optional ACL
username/password from the sidebar.

- Test connection performs authentication and PING, then releases its temporary connection. Profiles
  are restored without connecting automatically.

- Connections support direct TCP, TLS, or a system OpenSSH tunnel selected from an existing SSH
  connection. In tunnel mode the SSH server connects to the configured Redis host; `127.0.0.1`
  refers to that server.

- Tunnels reuse the selected profile’s host, port, username and automatic/key/password
  authentication and require TCP forwarding permission. Legacy alias-only Redis profiles remain
  supported.

- The SSH selector references saved profiles, including their jump setting. Opening the Redis
  connection editor or selecting a workbench resolves the current profile; saving an idle SSH
  profile also updates dependent Redis settings. Active workbenches retain their protected target
  until disconnected. Temporary SSH connections must be saved first. Redis owns its tunnel process
  independently of terminal, SFTP and local port forwarding processes.

- Password-mode host confirmation and credential lifetime follow the SSH profile. TLS can also run
  inside a tunnel and always verifies the Redis server name; use an optional PEM CA certificate and
  server-name override.

- System trust is used when CA is blank. Mutual TLS is unavailable.

### Read-only mode and connection lifecycle

The workbench shows server version, role and PING latency when permitted; unavailable metadata does
not prevent browsing. Select DB explicitly; server restrictions remain visible.

Each connection starts read-only, including after Reconnect. Rust enforces the write switch
independently of the UI, while Redis ACLs remain authoritative.

Multiple workbenches retain their connection and in-memory editor state when hidden or when another
workspace is selected. Cmd/Ctrl+W hides the Redis view without closing a local terminal.

Explicit Disconnect closes the database connection and SSH process. Reconnect creates a fresh
connection, retains the selected DB and verifies the original endpoint before reusing the in-memory
password.

Quit releases Redis connections and tunnels; terminal sessions keep their existing detach behavior.

### Toolbar and narrow-window layout

The compact workbench keeps the connection name, endpoint, DB and read-only/editing switch in its
toolbar. Reconnect and Disconnect are always visible side by side in the connected toolbar, without
an actions menu.

- The two buttons stay together if a narrow toolbar wraps. Connection information retains its own
  menu.

- Key navigation starts at 280 pixels and supports pointer or keyboard resizing; grouping and width
  stay in memory for this run. Below 720 pixels of workbench width, Browse keys opens a drawer with
  search focus, trapped Tab navigation and Escape/backdrop dismissal.

- Selecting a key closes the drawer. Small windows scroll the detail area independently.

- Controls, menus and dialogs use the current interface theme and language.

#### Redis toolbar checks

- Connection-toolbar validation: all nine existing Redis UI regressions, formatting, localization
  and TypeScript/production build checks pass. The isolated macOS app
  (`sh.uterm.desktop.qa.redistoolbar`) uses simulated Redis replies and verifies directly visible,
  side-by-side Reconnect/Disconnect buttons at 900 and 640 pixel workbench widths, Simplified
  Chinese/English labels, and both actions.

- This checks WebView interaction rather than a live Redis connection. Windows/Linux runtime
  acceptance remains pending; production builds retain the existing large-chunk warning.

### Key search and refresh

Key search accepts the entered Redis glob pattern without adding wildcards; Enter or Search starts a
new scan. Refresh keys restarts with the current input and retains the selected detail and draft,
including when that key is absent from the current scan batch.

Group counts describe loaded keys, not database totals. The footer distinguishes
incomplete/completed scans, empty batches and the 10,000-key limit.

Empty batches remain resumable until the cursor reaches zero. There is no background scanning or TTL
polling.

### Collection browsing and drafts

Hash browsing retains its current member batch and pattern while a separate lower pane opens a
field. Changing fields, member searches/pages, reloading or closing the field editor protects
unsaved changes.

Successful field saves update a loaded row; initial Hash creation reads the server's member count
and TTL without closing the saved field. List tables show index/value, Set tables show members and
ZSet tables show member/score; range-based collections provide previous/next navigation.

String metadata reports bytes, collection metadata reports member counts, and field metadata reports
value bytes rather than Redis memory usage. TTL displays an explicit duration or No expiration, with
the millisecond snapshot available on hover.

New keys, added fields, renames and TTL changes use dialogs; delete actions identify the connection,
DB and target. Creation dialogs open an unsaved value draft; Save writes it.

Rename, TTL and deletion dialogs use a single final confirmation. Dialogs and field panes restore
focus to their entry points.

Binary keys keep their original bytes; copying a key is available only for text names. Binary and
oversized values retain their bounded read-only previews.

The Console starts collapsed and continues to accept only the registered read-only commands.

#### Redis layout checks

- Redis layout validation: nine focused UI regressions cover retained dirty drafts and collapsed
  groups during refresh, resumable empty batches, Hash batch retention and save/discard/cancel
  guards, failed mutations, single confirmations and DB targeting, binary identities, type-specific
  tables, bounded large-value paging, initial Hash metadata and drawer/resizer keyboard behavior.

- On macOS, the full frontend suite passes 208 tests with eight skipped; 73 regular backend tests
  pass with four opt-in tests ignored, and explicitly running the Redis suite passes all seven tests
  including real Redis integration. Formatting, localization, documentation, TypeScript/production
  build and isolated desktop build checks pass.

- Native QA (`sh.uterm.desktop.qa.redislayout`) connects to disposable loopback Redis and verifies
  1440×900 and 1024×768 layouts, the 640×420 drawer and scrollable editor, Simplified Chinese/dark
  and English/light interfaces, Hash editing/formatting and save guards. Windows/Linux runtime
  acceptance of this layout remains pending.

### Scan and value limits

Keys use cursor-based SCAN with a COUNT hint of 200, optional glob patterns, deduplication and colon
grouping. Empty scan pages return without a metadata request or timeout and do not imply completion;
continue until cursor zero.

- At most 10,000 keys are retained per workbench; narrow the pattern at the limit. String values
  support 1 MB byte-range previews and editing when the complete value is valid UTF-8 and no larger
  than 1 MB.

- Hash fields support incremental browsing and individual editing. Lists and sorted sets use
  200-member ranges; sets and hashes use cursor scanning with member patterns.

- Collection cells show at most 64 KB; unusually large scan batches are marked partial and require a
  narrower pattern. Keys/field names are limited to 4096 bytes.

- Binary keys retain their original byte identity, and invalid UTF-8 values show a hexadecimal
  preview. A 16 MB protocol-read budget closes oversized responses rather than retaining an
  unbounded reply.

### Binary and Java serialization previews

Binary String values and individual binary Hash fields show serialization information below the
first 256 hexadecimal bytes. Java Object Serialization previews identify the stream version and,
when readable, the first ordinary class descriptor, serialVersionUID and field names/types; expand
Fields to inspect them.

- Readable UTF-8 text preserves visible strings, replaces control characters with · and invalid
  bytes with �, and is limited to the current page’s first 64 KB. Metadata inspection is limited to
  256 fields and 4096 bytes per name/type string.

- Truncated or unsupported descriptors retain recognized information with a partial-information
  message; later String pages do not infer a stream header. The view remains read-only and does not
  reconstruct full objects, inherited/nested descriptors or custom codecs.

- No JVM or additional runtime dependency is required.

### Editing and write protection

Enable editing to create String, Hash, List, Set or ZSet data, edit a String or individual Hash
field, delete a Hash field, rename without overwriting another key, delete a key, or set/clear TTL.
Saves serialize WATCH/read/compare/MULTI/EXEC on the connection and reject stale or missing
originals.

For List, Set and ZSet, choose **New key**, enter a name and select the type, then choose **Create**
to open the initial member draft. Enter the value and choose **Save** to create the key. An empty
value is a valid member; creating an empty collection without a member is unavailable. An existing
key is never overwritten.

- Use **Add member**, **Edit member** and **Delete member** above or inside the member table. List
  additions go to the start or end, and edits/deletions target the displayed zero-based index,
  including when values are duplicated. Set edits replace a member. ZSet edits change the member,
  its score, or both; scores accept finite, representable decimal numbers and scientific notation.
  Nonzero inputs that underflow to zero are rejected. Adding or replacing a Set/ZSet member refuses
  an existing destination member.

- Adding and editing open a draft; only **Save** writes. Score-only changes also count as unsaved.
  Changing members, paging, closing the editor, switching targets, disconnecting or exiting uses the
  save/discard/cancel guard. Failed saves retain the value and score. Deleting a member uses one
  confirmation showing the connection, DB, key and member/index; deleting the last member also
  deletes the key.

- List index edits compare a complete snapshot, limited to 10,000 members and 1 MB of combined value
  bytes. Larger lists remain browsable and accept start/end additions. Set edits check the original
  member; ZSet edits also compare its original score. Existing collection TTLs survive additions,
  edits and deletion of a member when the key remains.

- Complete UTF-8 members shown in the 64 KB table previews can be edited; binary or truncated
  previews cannot be edited. Complete binary members can be deleted. Each new member value is
  limited to 1 MB. Successful writes reread the collection and refresh keys; Set filters and ZSet
  ordering can place the changed member outside the displayed batch.

- Existing String saves preserve their current TTL and require server support for KEEPTTL. Save
  failures retain the draft.

- Write timeouts close the connection and report an uncertain result; reread before trying another
  write. No write is replayed automatically.

- Key deletion and key/TTL mutations require confirmation. The console accepts only PING, restricted
  INFO sections, DBSIZE, TYPE, TTL/PTTL, EXISTS and length commands; it does not execute arbitrary
  commands.

- Cluster/Sentinel discovery, subscriptions, Monitor, scripts, bulk import/export and dedicated
  Stream/module views are unavailable.

#### Redis collection editing checks on Windows

- Four focused backend checks pass, including input/score limits and three checks against disposable
  loopback Redis 5.0.14 servers. They cover creation, read-only and DB protection, collisions,
  empty/Unicode members, duplicate list positions, stale snapshots, concurrent edits, TTL
  preservation, score changes, rejection of underflowing scores without changing the original
  member, and removal of the last member.

- On Windows, the full frontend suite passes 246 checks with 11 optional/platform checks skipped.
  All 17 Redis UI/logic checks pass; the two final regressions also pass after the last adjustment,
  covering guarded previous-page navigation and returning to a valid page after deleting a member.
  The regular backend suite passes 105 checks with nine optional checks ignored. Locked dependency
  installation, localization, TypeScript/production build, desktop build, changed-source formatting
  and documentation checks pass. The production build retains its existing large-chunk warning.

- An isolated native Tauri/WebView2 app (`sh.uterm.desktop.qa.redismembers`) renders the real
  workbench and CodeMirror editor with simulated responses. It verifies all five creation options,
  List/Set/ZSet creation and member operations, list insertion position, score-only drafts, retained
  conflict drafts and one deletion confirmation. English/dark and Chinese/light inspection covers
  the wide layout and a 640×420 viewport, including visible Save and save/discard/cancel protection.

- The native UI fixture does not connect to a database; real-service coverage comes from the
  separate disposable Redis checks. macOS/Linux runtime acceptance and authenticated TLS/SSH service
  acceptance remain unverified for these member operations. Existing app and database processes were
  not restarted.

### Credentials and unsaved changes

Passwords are temporary by default. Remember password stores a target-bound entry in macOS Keychain
or Windows Credential Manager; workspace storage contains only its opaque reference.

Changing the endpoint, username, TLS trust or resolved SSH target requires entering and saving the
password again. Passwords are not returned to the frontend from the credential store, added to
command arguments, or written to logs.

Redis values and editor drafts are not written to local storage. Save/discard/cancel guards protect
changing the edited value or DB, disconnecting and reconnecting; quitting also reveals a hidden
dirty workbench.

Active handshakes/writes delay quitting, and unsaved edits or active operations block update
installation. At most eight Redis connections are open at once.

Connected, busy or dirty profiles cannot be edited or removed.

#### Redis connection and write checks

- Validation: all six Redis-specific backend tests pass on macOS, including four opt-in real Redis
  tests executed by `pnpm test:redis`. They cover authentication, binary values, DB isolation, SCAN,
  collections, permissions, TTL retention, conflicting concurrent saves, name collisions,
  large-value limits, trusted/untrusted TLS and incorrect certificate names.

- A deterministic lost-EXEC-reply test verifies an uncertain write is never replayed. Frontend tests
  cover schema upgrades, secret rejection, byte identities, quoting, read-only defaults, retained
  hidden drafts, conflicts, reconnection, late connection cleanup and avoiding local-session
  closure.

- Isolated native QA (`sh.uterm.desktop.qa.redis`) with loopback Redis 8.8 and OpenSSH verifies
  direct/TLS/SSH connections, Keychain save/read, Chinese String editing, Hash-field editing,
  conflict retention, draft discard/reload, the exit guard and tunnel cleanup. Windows
  runtime/Credential Manager, Linux server runtime, Redis 6/7, external cloud services and
  credentialed ProxyJump remain unverified.

#### Binary-preview checks

- Binary preview validation: regression tests use a real ObjectOutputStream fixture and cover shared
  type references, modified UTF-8 metadata, signed serialVersionUID, every truncated prefix,
  malformed references/lengths, field/text limits, later-page detection and literal markup display
  without writes. An isolated macOS app (`sh.uterm.desktop.qa.redisbinary`) with loopback Redis
  verifies Java String and Hash-field previews, ordinary binary text and the 64 KB truncation
  message.

- Windows/Linux runtime acceptance of this preview remains pending.

#### Package measurements and scope

- Package measurement with the same macOS ARM64 QA identifier and build parameters: DMG size rises
  from 10,440,236 bytes (10.44 MB) to 10,866,289 bytes (10.87 MB), approximately +0.43 MB; the app
  bundle rises from 29,025,292 bytes (29.03 MB) to 30,484,572 bytes (30.48 MB), approximately +1.46
  MB. Both builds use the README's `CARGO_PROFILE_RELEASE_STRIP=none` workaround.

- No Redis/SSH executables, frontend runtime dependencies or second TLS cryptography backend are
  bundled by this feature. Final native checks additionally verify saved credentials after relaunch,
  read-only reset on reconnect, TLS-over-SSH connection testing and dialog button layout.

- Windows/x64 and signed installer sizes are unmeasured.

## Files and source control

### Shared content calls

File components use the same content contract through Tauri and WebKit adapters. Each request owns
its arguments, document ID and operation ID; the method/event allowlists and 32 MiB UTF-8 limit
apply before delivery. Timeout, cancellation, unload and document changes suppress stale delivery
and remove subscriptions. A dispatched write retains the caller's guard until Rust finishes;
cancellation does not roll it back. Shared editor/preview components do not call Tauri directly.

In native QA, **File → Open file…** opens shared CodeMirror/HTML/PDF content for the selected local
project. Text editing and recovery use the protected editable window; preview windows retain their
read-only mode. Its ephemeral WKWebView loads manifest-listed bundle resources and accepts only
main-document messages. The host rejects stale document IDs, another root and writes from the
readonly preview. Fonts use revision-checked shared settings; static HTML cannot run scripts or load
external resources. PDF previews expose the shared highlight controls; annotations are separate
metadata and never change the read-only PDF bytes. Writable-editor and interaction evidence is
recorded separately in the closed #34/#42 tasks, with their original gaps and user-approved human
waiver still visible in #13.

At source `8a72b00754c5580150546ea2ae104f5166e04a39` / tested merge
`ea3895ab1d8db65ad59159fc45f3deff7326baf6`,
[Native CI](https://github.com/YondFane/uTerm/actions/runs/41966239836) passed on macOS 15.8.2 ARM64
and 15.7.9 Intel with Xcode 16.4, Swift 6.1.2 and Rust 1.99.1. `bash scripts/macos-content-smoke.sh`
passed all 19 content/lifecycle assertions: actual CodeMirror, HTML and PDF rendering, exact denial
codes, scoped drafts, font persistence, document reload, native-menu/early close, stale quit replies
and timeout protection. Swift resource and quit-gate checks also passed. The bundle includes
frontend resources and license notices.

[Tauri CI](https://github.com/YondFane/uTerm/actions/runs/41966239844) passed 53 actual application
scenes on Windows Server 2025 x64 and macOS 26.7.2 ARM64, with clean source trees and no cleanup
errors. The actual file tree opens temporary HTML/PDF, renders the PDF canvas, closes previews and
restores the editor. `preview-resource-isolation.json` records zero forbidden requests to an owned
loopback HTTP observer and successful cleanup. Native content and Windows HTML/PDF captures were
visually inspected; reports, screenshot filenames and artifact links are in
[#33 acceptance](https://github.com/YondFane/uTerm/issues/33#issuecomment-6650215412).

`pnpm test` also passed both adapters' abort/timeout/close cases against real Rust/Git checkout
hooks: the caller stays protected until the write ends, final branch/file bytes are checked and late
success is suppressed. Protocol checks cover mismatched/reordered replies, late subscriptions,
failed writes, immediate read cancellation, unload, bounds and custom-scheme IDs. Windows ran 407
frontend checks with 11 skipped; macOS ran 408 with 10 skipped. Harness checks, real app actions and
unexecuted human IME/focus checks remain distinct. This accepts #33 without a simulation exemption;
#34–#37 are now closed in their recorded scope; M3 #17 was closed not_planned by the user. Original
layout/PDF/Windows panel gaps remain in #13. Earlier PDF, workspace/path and input-control failures
retain their source-bound reports.

### PDF highlights

Open a PDF in a workspace file tab. Choose **Box highlight** and drag on the page, or choose
**Highlights** in PDF navigation to jump to or delete a mark. Both clients use the same reader and
highlight controls. Language and appearance changes update an open native document without replacing
its WebView.

Desktop highlights are saved in the shared Rust store, separately for the project root, relative
file path and PDF byte digest. Reopening the same version restores its marks; changed PDF bytes
start a separate set. Up to 2,000 marks are allowed, with normalized double-precision coordinates.
The PDF itself remains unchanged. Browser previews retain their existing local-storage owner.
Original imported highlight strings remain intact; legacy-compatible and coherent rollback exports
include the latest adopted marks. Up to eight previous sidecar versions are retained. Corrupt,
unsupported or blocked stores, or missing current records with recovery copies, fail visibly without
resetting the original.

The viewer shows a mark as saved only after acknowledgment. A conflicting or failed write retains
the attempted operation and offers **Retry** or **Cancel**. Retry explicitly reads the latest marks
and reapplies only this operation, preserving marks from another window. It never automatically
replays a write. Cancellation of an already dispatched request does not undo it; close and quit wait
for its actual result. Failed attempts are held in memory until handled or the view is closed.

Linux checks pass eight targeted real-filesystem Core tests, all 471 frontend/build-helper checks
(11 platform checks skipped), 257 Core checks (17 ignored), six FFI checks, and 19 QA-enabled
backend checks (one ignored). The focused frontend/transport/evidence-grid suite passes 27 checks;
16 paired-evidence policy tests and 13 Personal package policy tests also pass. They cover stale
revisions, exact PDF bytes, independent writers, legacy retention, export, filesystem failure,
symlink rejection, corrupt/missing stores, canceled writes, delayed replies and explicit retry.
Policy fixtures test rejection rules and do not count as application screenshots. The candidate adds
English/dark 1100×720 and Chinese/light 640×720 real-window comparison scenes with shared PDF bytes
and seeded comparison marks. Actual deletion and close/reopen are required in both apps; native QA
also draws and deletes through window pointer events, rejects other document targets, and checks
persistence after same-source app replacement. At source `3d0217a9df8fb9c019c909187315ce71931ae0f1`,
tested merge `aa48cadf41f9c9b1a9a323b22d8862b235915676`, the
[ARM Personal artifact](https://github.com/YondFane/uTerm/actions/runs/43043946735/artifacts/13866689848)
passes initial and replacement PDF drawing/deletion/reopen, document-scope and original-byte checks.
Both `personal-initial.json` and `personal-replacement.json` were read; English/dark initial and
Chinese/light replacement PDF originals were inspected. The
[paired artifact](https://github.com/YondFane/uTerm/actions/runs/43043946739/artifacts/13867981101)
contains 34 pairs plus the restart image (69 PNGs); all 68 paired digests were verified, and the two
ordinary PDF originals were inspected. Reader/highlight content matches; surrounding session counts
and folder expansion differ. Updated collection closes the background ordinary session through its
actual control, opens native PDFs through actual file rows, and requires one retained session and
the expanded PDF folder in both captures. Those stricter surrounding-state checks need fresh CI. The
[Windows log](https://github.com/YondFane/uTerm/actions/runs/43043946739/artifacts/13866998454)
records all seven portable PDF storage tests passing; Unix symlink coverage remains
platform-specific.

### Shared local file service

Local listing, reading, saving, copying, mutations and search use the same Rust service in
`uterm-core`. Tauri keeps its existing command names and platform reveal/quit adapters. Root checks,
UTF-8/BOM/line endings, digest conflicts, atomic saves and bounded previews are retained. A force
save overrides a version conflict only; it cannot make a read-only mixed-line-ending file or PDF
editable.

Thirteen existing file-service tests now run in the core. Seven real-process contract tests passed
on Linux x86_64, including file CAS, original-byte preservation, invalid parameters and root/link
escape. These checks do not establish native file-editor interaction. Native file previews are
read-only; separate writable windows and shared recovery have their own #34/#42 evidence, while
historical-client root compatibility and full rollback remain #46. Existing WebView draft sources
retain their owner and path. [Native](https://github.com/YondFane/uTerm/actions/runs/41425620871)
and [legacy](https://github.com/YondFane/uTerm/actions/runs/41425620777) platform CI passed the
extraction at head `2f777f1824f203cba9d4654b3ec3f70c43c9fb74`; this pass does not validate later
content changes.

### Git change colors in the file tree

**Files → File tree** colors changed files and their parent folders in local Git projects, including
changes in the index and working directory. Collapsed folders also show changes inside them. The
letter on the right and the hover description identify the status alongside its color.

| Marker | Status                           | Color |
| ------ | -------------------------------- | ----- |
| M      | Modified, including type changes | Amber |
| A      | Added or copied                  | Green |
| ?      | Untracked                        | Green |
| R      | Renamed                          | Blue  |
| D      | Deleted item                     | Red   |
| U      | Merge conflict                   | Red   |

Mixed folders use this priority: conflict, modified, renamed, deleted, added, untracked. A renamed
file marks its new location and the old location's parent folders. Deleted files do not create
placeholder rows; their remaining parent folders carry the status. Untracked embedded repositories
mark their directory and ancestors. Clean files use the normal color.

Status refreshes about every four seconds after the previous read finishes, on window focus, with
Refresh files and after file operations. Updating colors retains expanded folders. Selecting a
repository subdirectory marks only paths inside that selection; Worktree roots are supported.
Repeated manual refreshes wait for an unfinished status read of the same root before querying again.

Only the first 2,000 selected-root Git changes are marked. A notice identifies truncated results.
Read failures clear stale colors and show an error while leaving the file list usable. Non-Git
directories, SSH files, Quick open and Project search keep their existing presentation.

#### Validation and limits

- Windows path/state checks cover both Git columns, conflict combinations, rename/copy handling,
  parent priority, selected-root boundaries, drive/UNC paths and case-sensitive POSIX names. Nine
  component checks cover shared reads, retained expansion, clearing/recovery, errors, truncation,
  stale-root responses, serialized manual refresh, view-switch isolation, focus/timer cleanup and
  canceling operations on colored rows.
- The regular backend suite passes 131 checks with nine optional checks ignored. Real temporary Git
  repositories verify non-Git/unborn repositories, staged/working/untracked/deleted files, selected
  subdirectories, untracked embedded repositories and unchanged index bytes. File operations, menus
  and bilingual UI regressions, TypeScript/production build, isolated desktop build, localization,
  formatting and docs checks pass.
- The isolated Windows app (`sh.uterm.desktop.qa.gittree`) reads real files and Git status. Native
  checks cover all six markers, collapsed/expanded ancestors, Chinese filenames, dark/light themes,
  English status descriptions, Windows extended-path subdirectories and automatic clearing after
  restoring files while keeping folders expanded. macOS/Linux runtime and real UNC shares remain
  unverified.

### Opening changed files

In Git → Changes, right-click a file under Staged or Working directory and choose Open file to open
its current working-directory content in the file editor. Clicking a file opens its staged or
working diff in the central workspace by default. Open file also returns from a diff to an already
open file tab.

The menu supports Shift+F10, arrow keys, Home/End and Escape. Opening uses the existing editor tabs,
save-conflict protection and file-size limits. Missing or unreadable files show an error and retain
the current editor. Files outside the selected project directory have Open file disabled, including
when the selected directory is a repository subdirectory.

#### Validation and limits

- Focused Windows regressions cover editor reads versus click diffs, staged/working and untracked
  files, bilingual menu labels, keyboard navigation, menu dismissal, read failures, draft conflicts
  and selected-root path conversion, including Windows extended and UNC paths. App regression also
  verifies returning from an expanded diff to the same cached file while retaining its draft.

- An isolated Windows Tauri/WebView2 app (`sh.uterm.desktop.qa.gitopenfile`) uses a disposable local
  Git repository and real file reads. Native inspection verifies the two-item Chinese menu, clicking
  for a staged diff, opening full current content including unstaged lines, and returning from an
  expanded diff to an existing editor tab. macOS/Linux runtime acceptance remains pending.

- Frozen dependency installation, repository formatting, localization, documentation,
  TypeScript/production and isolated desktop builds pass. The full frontend/build-helper suite
  reports 292 passed and 11 optional/platform checks skipped. The production build retains its
  existing large-chunk warning.

### Rolling back one file

In Git → Changes, right-click a file in Staged or Working directory (or focus it and press
Shift+F10), choose Roll back file, review the path and confirm. This restores both the file's staged
and working changes to HEAD.

- Added files, including untracked files and staged files before the first commit, are deleted;
  staged renames restore the original path and remove the new path. The prompt states that rollback
  cannot be undone and initially focuses Cancel.

- Compare and History do not offer rollback. Links, submodules, directories and paths outside the
  selected directory are rejected; a renamed file's original path with other changes must be
  resolved in a terminal.

- Other files are retained.

Rollback runs off the UI thread and is serialized with branch operations. The editor saves and
closes the directory's cached files first; save conflicts retain the draft and block rollback
through the existing Retry/Discard/Cancel flow.

Changing repositories while a save is pending cancels the deferred rollback. A changed file status
or HEAD rejects the request.

Completion refreshes the file, Git and GitHub panels; failures remain visible through background
refreshes.

#### Validation and limits

- Windows validation: 163 frontend/build-helper tests pass with two platform-specific skips, and all
  48 backend tests pass. Focused regression coverage includes bilingual confirmation/cancellation,
  menu dismissal and focus restoration, save conflicts, duplicate requests, delayed actions,
  persistent errors, staged/working content, deletion, additions, renames, literal Unicode paths,
  root boundaries, links, submodules and stale requests.

- Locked dependency installation, TypeScript/production build, localization, documentation,
  changed-file formatting, both Cargo formatting checks and the isolated desktop build pass. Native
  QA (`sh.uterm.desktop.qa.gitrollback`) verifies the right-click menu, the added-file warning and
  cancellation preserving its content.

- Native staged/rename rollback, editor-conflict interaction and macOS/Linux runtime acceptance
  remain unverified. The production build retains its large-chunk warning.

### Local and remote branches

The toolbar branch picker groups local branches under Local and server branches under Remote
(`remote/branch`). Opening the list queries every configured remote for all advertised branch heads,
including branches not fetched locally and branches outside a single-branch clone's fetch
configuration; tags and symbolic remote HEAD entries are excluded.

- Local branches refresh periodically and on window focus. Remote reads show a loading state and
  per-remote failures without hiding successful results.

- Network access and existing Git credentials are required; authentication or timeout failures
  remain visible and reopening retries the query. Non-Git directories have no picker.

- Detached HEAD and repositories without a first commit can select an available branch.

### Branch tree and reference previews

The Git panel keeps a branch tree beside Changes, Compare and History. At panel widths of 640 px or
more, the tree uses a 220 px column; narrower panels stack it above the content at 35% of the
content height. Use the tree heading to collapse or reopen it. Existing panel placement, resizing
and central diff tabs remain available.

- HEAD follows the current checkout. Local branches, remote branches and tags are grouped
  separately; names containing `/` form folders, and remote branches are grouped by remote first.
- Click a branch or tag to preview its history with the commit graph. Double-click also only
  previews. Use **Switch to this branch** or **Switch and track** in the context menu to change the
  checkout.
- Search matches the full name and expands matching paths. Clearing search restores the saved folder
  folds. Long names have full-name tooltips. Selection, search and folds are retained during this
  run.
- The current-branch dot is separate from the selection background. Local branches show upstream
  ahead/behind counts; branches in another Worktree show an occupancy marker and directory tooltip.
- Favorite local or remote branches from their context menu. Favorites sort first among siblings and
  are saved per repository, shared with its Worktrees. Storage errors remain visible.

Local references load before server discovery. Periodic and window-focus refreshes read local state;
Refresh branches also queries servers. Unfetched branches show **Fetch to preview** and support
fetching or switching and tracking. History, comparison and creation from that base become available
after fetching. Remote reads require the existing Git credentials and show failures without hiding
local references. Tags support browsing and creation bases.

Background reference refreshes retain the current Git view and diff selection. Selecting a reference
opens its history.

For a directory outside a Git repository, branch, change and history reads leave an empty view
without displaying Git's fatal diagnostic. Previously loaded repository data is cleared; the file
tree drops Git decorations and the top branch selector is hidden. Permission, repository corruption
and other read or action failures remain visible.

Windows regression checks cover plain-directory diagnostics, clearing stale Git/GitHub data,
repository recovery and preservation of permission errors, alongside branch operations, refreshes
and file-status lifecycle checks. An isolated native app (`sh.uterm.desktop.qa.java`) uses a bounded
Git-discovery fixture to verify the file view, hidden top branch selector, branch/Changes/History
views and GitHub empty list without fatal diagnostics. TypeScript/production and isolated desktop
builds, localization, formatting and documentation checks pass. This checks local reads and UI;
credential-dependent GitHub operations and macOS/Linux runtime acceptance remain outside this check.

Tree navigation supports arrows and Home/End. Right-click or Shift+F10 opens a menu headed by the
full target name. Menu actions use that target, including when another reference is previewed.
Escape returns focus to its tree row; menus stay within the window and close on outside clicks, tree
scroll, window resize or loss of focus.

### Branch and Worktree actions

Use a reference's context menu for these operations:

- **New branch** creates from the selected reference, selects the new branch and previews its
  history without switching the checkout. **Rename branch** changes only its local name and retains
  its upstream; another Worktree's occupied branch cannot be renamed.
- **Set upstream**, **Change upstream** and **Unset upstream** manage a local branch's tracking
  relationship. Choose the remote and target branch name to set or replace it.
- **Update branch** fast-forwards the current branch. For another local branch, **Switch and
  update…** confirms the target before switching and updating. An update failure retains the
  completed switch and reports that result. Divergent history is rejected.
- **Push branch** sends the selected local branch's committed content to its upstream, including a
  branch that is not checked out. For the first push, choose a remote and target name; tracking is
  established after success. Push never forces an update.
- **New worktree** creates a new branch from the selected reference. Enter the branch name and
  accept or edit the generated absolute directory. The Worktree joins the project tree while
  retaining the current project/session selection; no terminal starts automatically.
- Remote-branch menus provide **Fetch this branch**; remote-group menus fetch all that remote's
  branches. Folder menus also expand/collapse and refresh. Branch and tag menus can copy the full
  name.

Operations run in the background and are serialized with existing Git writes. Targets are checked
again before mutation. Switching and updating use the editor's save/conflict and draft protection.
After success or partial failure, the toolbar branch name, Git content and Worktree discovery
refresh together. Failures remain visible. Branch deletion, general merge/rebase and tag
creation/deletion are not available in the tree.

### Comparing a reference with the working directory

Choose **Compare with working directory** on a local branch, fetched remote branch or tag. The
**Working directory comparison** view shows the direct difference from that reference to disk,
including staged and unstaged content, additions, deletions and binary-file indicators. Untracked
files are listed separately and can be previewed. Save editor drafts first to include them.

The existing **Compare** tab continues to compare the selected base's common ancestor with HEAD.
Both comparison views retain file navigation, unified/side-by-side diffs and central expansion.

#### Branch tree validation and limits

Windows Git regressions use real temporary repositories and local bare remotes. Coverage includes
reference-specific history, creation without checkout, stale-target rejection, rename/tracking,
selected-branch first push and non-force rejection, fast-forward/divergent updates, Worktree
ownership and creation from a tag, and direct comparisons containing staged, unstaged, deleted,
untracked and binary files. Frontend coverage checks hierarchy, full-name search, favorites,
keyboard menus, preview without switching, stale history, save-conflict guards and operation
targets.

- On Windows the full frontend suite passes with 297 tests and 11 optional checks skipped, and the
  additional App Worktree integration regression passes. Backend checks pass with 118 tests and nine
  optional tests ignored; host checks pass with 38 tests and two optional tests ignored. Frozen
  dependency installation, TypeScript, localization, formatting, documentation, production and
  desktop builds pass. Versioned bilingual release-note headers and stable-release/feed guards also
  pass validation. The production build retains the existing large-chunk warning.
- An isolated Windows Tauri/WebView2 app (`sh.uterm.desktop.qa.gitbranches`) runs the real Git
  panel, toolbar selector and Git commands against temporary repositories and a local bare remote.
  Native checks and screenshot inspection cover Chinese/dark and English/light, 320/640/760 px panel
  widths, the 220 px tree, the 35% stacked layout, collapse, edge menus, keyboard focus,
  preview-only single and double clicks, working/untracked diffs and central expansion. Native forms
  verify creation from a tag, first push and upstream establishment, rename preserving upstream and
  Worktree creation with an edited branch/path while retaining the original checkout. A native first
  push with a single-branch fetch configuration also verifies that upstream counts are immediately
  available. A real background HEAD update retains the Changes view and its central diff.
- Frontend regressions cover late first pages and pagination, background reference updates without
  forced navigation, targets captured before external checkout changes, retained
  project/Worktree/session selection without starting a terminal, and visible
  Worktree-registration/storage failures. Credentialed network remotes and macOS/Linux runtime
  acceptance remain pending.

### Switching branches

Selecting a remote branch fetches it and creates a same-named local tracking branch, extending a
narrow fetch configuration when needed. An existing local branch is reused only if it tracks that
exact remote branch; conflicting names are rejected without resetting the branch.

Selecting an existing local branch uses Git's normal switch checks. The editor saves and closes
before switching or syncing; save conflicts retain the draft and block the operation until resolved
or explicitly discarded.

Git rejects switches that would overwrite file changes or use a branch occupied by another Worktree.
No force, automatic stash or file discard is used.

### Push, Pull, Fetch and Refresh

Right-click anywhere on the branch control (or press Shift+F10) for Push, Pull (fast-forward only),
Fetch and Refresh branches. Push explicitly targets the current branch's configured upstream without
force or automatic tag pushing.

- Pull fetches the upstream and fast-forwards without requiring a clean working tree. Unrelated
  staged, unstaged and untracked files are retained; Git rejects updates that would overwrite local
  changes. No automatic stash, merge commit or rebase is used, and divergent history is rejected.

- Toolbar Push/Pull are disabled for detached/unborn branches or missing upstreams. Use the branch
  tree to configure an upstream or perform a local branch's first push.

- Fetch updates all branch references from each configured remote and prunes deleted remote
  references without switching or merging. Refresh branches re-reads the Local/Remote lists.

- Git actions run off the UI thread and are serialized. The control keeps the current branch name
  during Push, Pull, Fetch and branch switching, and stays disabled until the operation finishes.
  Screen readers receive progress announcements; the context menu reports completion. Failures are
  displayed, and file/Git/GitHub panels refresh after operations, including partial failures.

- Menu navigation supports arrows, Home/End, Enter, Escape and outside-click dismissal; application
  shortcuts are suppressed while the menu is open. Switching blocks duplicate requests and editor
  transitions, and stale responses cannot replace newer branch state.

#### Branch-label checks on Windows

- The focused branch-selector regression passes, including retained branch names during switching
  and delayed Pull in Simplified Chinese/English, busy-state protection, completion, editor-save
  conflicts, stale responses and visible Git errors. Windows validation passes frozen dependency
  installation, repository formatting, localization, documentation, TypeScript/production and
  isolated desktop builds, 278 frontend tests (11 skipped), 110 backend tests (nine ignored) and 38
  host tests (two ignored). The production build retains its existing large-chunk warning.

- An isolated Windows Tauri/WebView2 app (`sh.uterm.desktop.qa.branchlabel`) renders the real
  selector with simulated Git replies. Native inspection verifies that a pending Pull retains
  `release` in Chinese/dark and English/light appearances, keeps the selector disabled, preserves
  screen-reader status text and enables the control on completion. This does not validate live
  remote operations or credentials; macOS/Linux runtime acceptance remains pending.

### Git commit history

Open Git → History and hover over a commit to see its full message, complete hash, author and
timestamp. Clicking the commit opens its details in the inspector: the message retains paragraphs
and line breaks, followed by the changed-file count and file list. Long messages scroll within the
details area, and text remains selectable.

- Click a changed file to inspect its diff. Existing unified/side-by-side views, file navigation and
  expansion remain available. Empty commits show an explicit message instead of an empty list.
- Back to history returns to the loaded commit list. Switching repositories leaves the old commit
  details, and late file-list responses cannot replace a newer selection. Read failures remain
  visible; returning to the list and opening the commit again retries the read.
- History loads 100 commits per page and supports Load earlier commits. A page of commit messages
  exceeding the 2 MB output limit shows an error and directs the user to `git log` in a terminal.
  Messages are displayed as plain text.

#### Commit-history checks on Windows

- Eleven focused Git/history/diff/refresh and content-font tests pass. Coverage includes full
  multiline and bilingual messages, plain-text rendering, metadata, file counts, diff references,
  empty commits, failed reads/retry, stale responses and repository switching. Backend checks report
  108 passed and nine ignored tests; Git regressions use temporary local repositories and cover
  message preservation, pagination, root commits and the output-size limit.
- An isolated Windows Tauri/WebView2 app (`sh.uterm.desktop.qa.gitdetails`) runs the real Git panel
  and Git read commands against a temporary repository. Checks cover tooltip contents, native
  commit/file clicks, keyboard activation, empty/root commits, real diffs and expanded diffs with
  commit details retained. Visual inspection covers Chinese/dark and English/light views and
  wrapping in a 280 px panel.
- Production and desktop builds, TypeScript, localization, documentation, changed-file formatting
  and Cargo formatting pass. Production builds retain the large-chunk warning. macOS/Linux runtime
  acceptance remains pending.

### Git comparison tabs

File comparisons open by default as a closable Git/file-name tab in the central tab bar. Selecting a
terminal or file hides the comparison while retaining its tab; selecting the comparison tab restores
it.

Closing its tab returns the comparison to the inspector. Main toolbar and Git tools remain
available.

#### Validation and limits

- Windows App regression checks cover automatic activation of the central diff tab on a file click,
  returning through terminal/file tabs, retained diff content and closing back to a cached editor
  draft. TypeScript, production/desktop builds, formatting, localization and documentation checks
  pass.

- Native terminal/file/diff tab switching remains pending on Windows, macOS and Linux. Native diff
  placement is covered under [Expanded Git diffs](#expanded-git-diffs).

### Expanded Git diffs

Click a file in Changes, Compare, History or Working directory comparison to open its diff in the
central content area by default. The inspector retains the branch tree and Git file list, and the
main toolbar and workspace tabs remain available.

The diff toolbar retains Copy Diff, unified/side-by-side comparison, previous/next file,
inspector-only display and Close diff. Expand diff returns a comparison from the inspector to the
central workspace.

Inspector-only display returns the diff to the inspector; closing the diff restores the previous
central terminal/editor without terminating sessions or discarding file buffers. The inspector
remains resizable in central display mode.

#### Validation and limits

- Six focused Windows Git/content/App regressions pass. Coverage includes automatic central display
  for staged, working, branch-comparison and commit files, retained font/diff modes, manual
  inspector display, tab activation, closing and cached editor drafts. TypeScript,
  production/desktop builds, formatting, localization and documentation checks pass.

- The isolated Windows Tauri/WebView2 app (`sh.uterm.desktop.qa.gitbranches`) uses a real temporary
  Git repository. Native clicks and screenshot inspection verify default central staged/untracked
  diffs, the retained file list, manual inspector display and reopening centrally after closing, in
  Chinese/dark and English/light with a 320 px inspector. macOS/Linux runtime acceptance remains
  pending. Production builds retain the existing large-chunk warning.

### File tab limit

Settings → General → File tab limit sets the maximum number of open file tabs per directory (default
10, minimum 1, whole numbers only). The preference persists across restarts.

- Opening a file beyond the limit closes the earliest opened file tab; switching to an existing tab
  does not change its opening order. Lowering the limit also removes the oldest excess files.

- Terminal and Agent sessions are excluded and remain running. Saves and conflict protection run
  before automatic removal; failed saves retain drafts and require resolution.

#### Validation and limits

- All 157 frontend/build-helper tests, localization checks and frontend/isolated macOS desktop
  builds pass. Tests cover old-settings defaults, invalid values, FIFO eviction, existing-tab
  selection, reducing to one, conflict protection and retaining the session tab.

- Native QA (`sh.uterm.desktop.qa.tablimit`) verifies the General layout, default 10 and saving 1.
  Native automatic eviction and Windows runtime acceptance remain pending.

### Switching file tabs

File-tab selection directly uses the guarded open operation, avoiding a nested hide/open transition
that would block opening the target.

#### Validation and limits

- App regression checks verify switching between retained files, saving edits and returning from a
  terminal to a file. All 156 frontend/build-helper tests and frontend/isolated macOS desktop builds
  pass.

- Native QA (`sh.uterm.desktop.qa.tabswitch`) verifies switching between two file tabs and returning
  from a file to the terminal; the QA app exited before the final terminal-to-file native check.
  Windows runtime acceptance remains pending.

### Middle-click to close file and diff tabs

Middle-clicking a file or Git diff tab closes it through its existing close action. File
save/conflict guards still apply; closing a background file retains the visible tab.

Middle clicks never close terminal or Agent sessions, and disabled transitions ignore closing.

#### Validation and limits

- Component tests cover file closing, conflict protection, disabled guards, ignored right clicks,
  retained terminals and Git diff closing. All 159 frontend/build-helper tests and frontend/isolated
  macOS desktop builds pass.

- Native QA (`sh.uterm.desktop.qa.middletab`) verifies current/background file closing and keeping a
  terminal session. Native Git diff middle-click and Windows runtime acceptance remain pending.

### Central tab bar

The main workspace has a compact tab bar showing the selected terminal or Agent session, files
opened in the current directory and any Git diff tab. Tabs are 28 px high and stay on one row when
they fit. They wrap to at most two visible rows; additional rows can be reached by vertical
scrolling.

Selecting a tab, resizing the workspace or closing a background tab keeps the active tab visible.
The bar is hidden when there are no file or Git diff tabs, even if terminal or Agent sessions are
running.

- Opening a file or diff shows it again. Component checks cover session-only hiding and hiding after
  the last file closes; native layout acceptance remains pending.

- Other running sessions remain in the sidebar and take no space in the central tab bar. Selecting a
  different sidebar session replaces the session tab, including while a file is visible; the session
  tab remains available to return from a file to that session.

- Opening another file adds a tab; reopening the same directory/path selects its existing tab. File
  tabs show an unsaved marker. File and Git diff close buttons appear when hovering over their tab
  or navigating its controls with the keyboard. Their space stays reserved to keep tab widths
  stable. Devices without hover keep the close buttons visible.

- Closing a background file leaves the active view unchanged; closing the active file returns to the
  selected terminal or welcome page. Terminal and Agent tabs, and terminal pane headers, have no
  close button; the sidebar retains Close Session.

- Selecting a session from the tab bar or sidebar retains open file tabs and running terminal
  output. Switching or closing the active file saves changes first; save/conflict failures block the
  action and preserve the recovery draft until Retry, Discard or Cancel.

- Git operations and file-tree mutations retain their save guard and close cached files in the
  affected root to avoid stale content. File tabs remain in memory for this run and are scoped by
  directory; they are not restored after restart.

- File text is retained between switches, while editor view history and cursor position are
  recreated. Left/Right and Home/End navigate tabs in display order across rows, long names are
  truncated with full paths in tooltips, and language switching updates tab labels.

#### Validation and limits

- Three focused Windows tab/menu/App regressions pass. Coverage includes saved/conflicting drafts,
  active/background closing, retained sessions, active-tab reveal after width or tab-count changes,
  resize fallback and observer cleanup. TypeScript, production/desktop builds, formatting,
  localization and documentation checks pass. Production builds retain the existing large-chunk
  warning.

- Close-button visibility is verified in the isolated Windows app (`sh.uterm.desktop.qa.tabhover`)
  with the real tab bar and file/diff fixtures: hidden away from the pointer, visible on hover or
  keyboard focus, stable tab widths, retained unsaved markers and Enter to close. Both tab/menu
  component checks, production/isolated desktop builds, formatting and documentation checks pass.
  Hover behavior on macOS/Linux and non-hover devices remains unverified.

- An isolated Windows Tauri/WebView2 app (`sh.uterm.desktop.qa.compacttabs`) runs the real tab bar
  with file/session/diff fixtures. Native clicks, keyboard input and screenshot inspection verify 28
  px tabs, 22 px close buttons, one/two-row layouts, a 57 px bar limit, overflow scrolling,
  active-tab visibility after resizing/background close, long labels, retained drafts, context menus
  and focus, in Chinese/dark and English/light at workspace widths of 900, 480 and 260 px. Native
  Agent/save-conflict dialogs and macOS/Linux runtime acceptance remain pending.

### File-tab context menu

Right-click an open file tab, or focus it and press Shift+F10, to open its file menu:

- **Copy** places the file in the application's file clipboard; use Paste in the file tree to copy
  it into a folder, including a different project.
- **Copy file name** copies the final name to the system clipboard.
- **Copy file path** copies the full path. Windows drive and UNC paths omit the extended-path
  prefix.
- **Open in File Manager** reveals the local file in its containing folder.

The menu acts on the clicked tab without switching the active file or saving its draft. Copy uses
the file on disk; save edits first to include them in the copy. Remote tabs allow copying their name
or SSH path; file copying and opening a local file manager are disabled.

The menu stays within the window and outside the tab bar's scroll clipping. Arrow keys and Home/End
navigate actions; Esc closes it and returns focus to the tab. Clicking outside, scrolling the tab
bar, resizing or leaving the window closes it. Copy and opening failures appear visibly.

#### File-tab menu checks on Windows

- Three focused component checks pass, including existing tab/draft guards and file-tree menus. The
  new regression covers background-tab targeting, cross-project paste, normalized Windows clipboard
  paths, remote restrictions, keyboard focus, edge positioning and visible failures. TypeScript,
  localization, changed-source formatting and production build pass.
- An isolated Windows app (`sh.uterm.desktop.qa.tabmenu`) uses the real tab bar, file panel and
  filesystem commands with disposable files. Chinese/dark and English/light views verify all four
  actions, system clipboard writes, real file copy/paste, file-manager command success, retained
  active tab, keyboard controls and an unclipped menu at 640×420.
- Explorer's selected-file highlight and macOS/Linux runtime behavior for this tab menu remain
  unverified. The production build retains its existing large-chunk warning.

### Deleting files and directories

In the local or remote file tree, right-click a file or directory and choose Delete. Directory
deletion opens a centered modal with the full path and a warning that all subdirectories and files
will be removed, including hidden entries and entries beyond the list's display limit. Cancel is
focused initially; Cancel or Escape closes the dialog and returns focus to the directory row.

- Deletion is permanent and cannot be undone. The selected project or remote root cannot be deleted.
  The existing editor save guard runs before deletion; save conflicts block the operation until
  resolved or explicitly discarded.
- Selecting a symbolic link or a path through a link remains read-only. Deleting a containing
  directory removes its nested links without following their targets.
- The confirmation closes before editor save protection runs, allowing its own conflict dialog to
  remain usable. Replacing the target, switching roots or unmounting cancels a deferred mutation.
- Completion refreshes the list. Failure also refreshes it and reopens directory confirmation; some
  contents may already be deleted. Permission errors, connection loss or unsupported remote
  filenames stop the operation without automatically retrying or restoring deleted contents.

#### Deletion checks on macOS

- Component regression checks cover Simplified Chinese and English confirmation, cancellation, modal
  placement and initial Cancel focus, root/link restrictions, deferred editor protection, unmount
  cancellation, duplicate requests, visible failures and list refresh for local and remote commands.
  All 287 frontend/build-helper tests pass, with ten optional checks skipped. TypeScript,
  localization, formatting, documentation checks, the production build and the debug desktop build
  pass.
- All 117 regular backend tests pass, with nine optional checks ignored. Temporary filesystem and
  real system SFTP-server fixtures cover nested/empty directories, hidden files, root/traversal
  rejection, missing targets, preserved siblings and external, cyclic and broken links. The SFTP
  fixture includes 2,100 files to verify deletion beyond the display limit.
- An isolated macOS app (`sh.uterm.desktop.qa.dialogsidebar`) verifies the centered directory modal,
  full path, initially focused Cancel button and Escape returning focus to the directory without
  deleting it. Credentialed remote servers and Windows/Linux runtime acceptance remain unverified.
  The production build retains its existing large-chunk warning.

### Automatic file-tree refresh

The visible file tree automatically refreshes its root and expanded folders five seconds after each
directory read completes. Manual Refresh files remains available.

Empty folders remain visible and expandable; their contents stay blank without an empty-directory
message. Directory read errors and partial-list warnings remain visible.

Refresh retains expanded folders, scroll position and inline name inputs; it does not reload editor
contents. Slow reads do not overlap within a folder’s refresh cycle, and collapsing a folder,
changing projects or closing the panel cancels its timer and ignores late results.

Quick-open and content-search results are not periodically queried.

Manual and mutation-triggered refreshes update each parent before rereading its expanded children.
Cached rows and expansion remain while the parent loads; deleted directories are removed before
their old child paths can be read. Real directory errors remain visible.

#### Validation and limits

- Component tests cover updated listings, scheduling after completion and timer cleanup; frontend
  tests, TypeScript/production build, formatting, localization and documentation checks pass on
  macOS. Native timing and Windows runtime acceptance remain pending.
- The Windows file-tree refresh regression, scoped formatting and documentation checks pass. Native
  empty-folder visual acceptance remains pending.
- A Linux component regression reproduces the missing-path error when deleting an expanded folder
  with a delayed parent response, then passes with parent-first refresh. It also checks retained
  cached rows/expansion, resumed child reads and visible permission errors. The native CI retains
  `file-refresh-tests.log` and records the actual CRUD stage if a window check fails; this fix still
  requires its own macOS run. The complete Linux frontend suite passes 477 checks with 11
  conditional skips; TypeScript/production, formatting, localization and documentation checks pass.

### File-operation errors

File-list operation errors (creation, renaming, deletion, copying, pasting and opening in the file
manager) disappear after three seconds. Each failed action restarts the timer, including identical
errors; typed names remain intact.

Directory-loading and search errors remain visible.

#### Validation and limits

- Component timer tests cover dismissal and repeated failures; native timing acceptance remains
  pending.

### Quick-open file menu

Under Files → Quick open, right-click a result or press Shift+F10 on the focused result to open its
menu. Arrow keys move between actions; Escape closes the menu and returns focus to that result.

- **Copy** keeps the selected local file in uTerm's internal clipboard. Switch to the file tree and
  choose Paste on the destination folder; the existing copy rules and conflict checks apply.

- **Copy file name** copies the final name to the system text clipboard.

- **Copy file path** copies the absolute path, omitting Windows extended-length prefixes.

- **Open in File Manager** reveals the local file in its containing folder; it is disabled for SSH
  files. Clipboard and opening failures remain visible.

The menu targets the result that opened it without opening the file. It is available in Quick open;
content-search results keep their existing behavior.

#### Validation and limits

- Windows component regression covers the four actions in both languages, the selected target,
  normalized paths, internal Copy/Paste, keyboard dismissal and visible failures.

- The isolated Windows app (`sh.uterm.desktop.qa.contentcontrols`) uses the real App, a temporary
  project and filesystem commands. Quick-open Copy followed by file-tree Paste writes the expected
  file in that root. Chinese/dark and English/light menus were visually inspected, including a 1000
  × 700 viewport. Clipboard and file-manager calls use fixtures; this check does not launch
  Explorer. macOS/Linux runtime acceptance remains pending.

### Copying files and folders

The file tree supports Copy/Paste from its context menu and Ctrl+C/Ctrl+V (Cmd+C/Cmd+V on macOS)
while the list is focused. A folder receives the copy; a file targets its parent, and blank space
targets the project root.

- This single-entry internal clipboard retains the source project across project changes and panel
  remounts, allowing pasting into another project. It resets when the application reloads and does
  not import files from the system clipboard.

- Source and destination are separately validated within their project roots; missing sources report
  an error. Component and Windows backend tests cover cross-project copying, conflicts, missing
  sources and traversal.

- Files, binary content and complete directories are supported without overwriting existing names.
  Links, special files, root copies and self/descendant destinations are rejected.

- Copy runs off the UI thread, stages content locally and limits recursion to 64 levels and 100,000
  entries; extra disk space is required. A final write failure may leave an incomplete destination,
  reported visibly for inspection.

#### Validation and limits

- Component and backend tests cover destination routing, recursive copying, conflicts and traversal;
  a mocked browser preview verifies the menu and refreshed tree. Native WebView and macOS acceptance
  remain pending.

### Static HTML preview

HTML and HTM files open in static preview, with an Edit/Preview toggle that previews unsaved text
without saving. Full-document head styles, inline CSS and embedded data images are preserved.

The isolated frame blocks scripts, external/local linked resources, forms and navigation; pages
needing JavaScript (including Vite/React entry HTML) must use their development server. Such
dependencies display a limitation notice rather than an unexplained blank panel.

#### Validation and limits

- Regression tests cover style preservation and active-content removal. Native WebView acceptance
  remains pending.

### Open in File Manager

Project, Worktree and local file-tree context menus offer Open in File Manager. The file-tree menu
expands to show its actions, including this entry after Copy path, and uses its measured size to
stay inside the window.

It scrolls only when the available window height cannot fit all actions; arrow keys still reach the
lower entries. The action is disabled for SSH remote files.

The Worktree action opens that Worktree's own directory and is disabled for a missing Worktree.
Folders open directly; files are revealed in their containing folder.

File-tree paths are checked against the selected root before opening. Opening failures remain
visible.

#### Validation and limits

- An isolated macOS QA app (`sh.uterm.desktop.qa.worktreeopen`) verified the Worktree menu layout,
  dismissal after activation and Finder opening the Worktree directory.

#### File-menu checks on Windows

- File-menu validation on Windows: 19 related frontend checks, changed-source/test formatting,
  localization/documentation checks and TypeScript/production build pass. The focused regression
  covers measured edge positioning, language-dependent height changes, short viewports, keyboard
  access, file/folder/root targets, menu dismissal and visible opening failures.

- An isolated native host (`sh.uterm.desktop.qa.filemenu`) uses the real FilePanel and
  filesystem/opener commands with a temporary root. Chinese/dark and English/light menus show all
  local actions without scrolling, including at the window's bottom-right edge; file and root
  actions open Explorer at the correct directory.

- Explorer file selection, Windows project/Worktree actions and macOS/Linux file-menu layout remain
  unverified. The production build retains its large-chunk warning.

### Name conflicts

Creation and renaming report conflicts separately for files and folders, including cross-type
collisions. Renaming to the unchanged name succeeds without writing.

Editing the input clears the previous validation message. Files and folders still cannot share a
name in the same parent directory.

#### Validation and limits

- Backend regression tests cover these rules; native interaction acceptance remains pending.

### Windows path display

The session header, file-viewer header, file-panel footer and their tooltips display Windows paths
without the extended-length prefix (`\\?\` or `//?/`). Local paths start at the drive letter, such
as `D:\project\AGENTS.md`; UNC paths retain `\\server\share\…`. Internal filesystem paths remain
unchanged.

#### Validation and limits

- Nine focused file-document and viewer-header checks pass on Windows. The header regression covers
  both prefix spellings, mixed separators, Unicode, drive roots, UNC shares and unchanged POSIX
  paths; it also checks that display formatting preserves the document's file identity.

- An isolated Windows Tauri/WebView2 app (`sh.uterm.desktop.qa.filepath`) uses the real FileEditor,
  sample Markdown documents and mocked desktop commands. Six path cases pass for the visible header
  and tooltip, with screenshots inspected for drive and UNC paths. TypeScript, the fixture's
  frontend and native builds, changed-test formatting and documentation checks pass. The real App
  fixture (`sh.uterm.desktop.qa.contentcontrols`) also verifies drive-letter paths in session/file
  headers and the file-panel footer. A focused path regression covers drive, UNC and POSIX display
  while desktop commands retain the original directory. macOS/Linux runtime acceptance remains
  pending.

### Inline creation and renaming

New files and folders are named inline inside the target folder in the file tree; renaming edits the
existing row. Enter confirms and Escape cancels; failures retain the input.

Creation from a folder's context menu expands that folder. Refresh preserves expanded folders.

Deletion still requires explicit confirmation. Native inline-edit focus and input-method acceptance
remain unverified.

### Root boundaries and recovery drafts

File access stays within the selected project root. Text saves check for conflicts and retain
unsaved drafts for recovery.

Markdown is sanitized before rendering; PDF canvas dimensions are bounded. Git views include status,
diffs and commits, with worktree management.

GitHub integration requires the user's credentials and access. A non-Git directory leaves the list
empty without displaying Git's fatal diagnostic or retaining a previous repository selection. Other
discovery and GitHub operation failures remain visible.

### View on GitLab

The Working directory panel places View on GitLab directly below View on GitHub. It opens a
repository whose remote hostname contains `gitlab` (case-insensitive), including self-hosted
instances and nested groups, preferring a matching `origin`.

HTTP/HTTPS remotes retain their web port; SSH remotes open the corresponding HTTPS site on its
default port. Custom web ports must be provided through an HTTP/HTTPS remote.

Embedded credentials are omitted from the browser link. Missing remotes and opening failures remain
visible.

#### Validation and limits

- Component tests cover button order, invocation, busy state and bilingual errors; backend tests
  cover remote conversion and selection. All 218 frontend/build-helper tests and 76 backend tests
  pass, with eight frontend tests skipped and four backend tests ignored.

- Formatting, localization, TypeScript/production build, documentation checks and an isolated macOS
  app build pass. The isolated app (`sh.uterm.desktop.qa.gitlab`) verifies the button order, icon
  and visible error when the directory is not a Git repository.

- Authenticated GitLab access and Windows runtime acceptance remain unverified.

## Java and Maven builds

### Build and run a project

Open a local project and choose **Java build and run** from its project menu or the toolbar (Spring
Boot hexagon/power icon). The bottom panel keeps the current file or terminal above its
configuration and task output. Expand the panel when more room is needed; hiding it saves its
configuration and leaves running tasks attached to the background host.

The toolbar summarizes running projects across all local projects and Worktrees managed by this
app's background host. The Java icon turns Spring green while any Development run or JAR run task is
alive, including preparation steps in that run. Standalone builds, tests and installs do not light
it up. The Python icon turns blue/yellow while any Python run task is alive. Otherwise the icons are
gray; light appearance uses darker colors for contrast.

The sidebar replaces a project's or Worktree's folder icon with the matching colored Java or Python
icon while a managed run task is alive. Each row reflects its own root, including pinned projects.
The folder icon returns after the host confirms exit. Switching projects or closing the run panel
keeps a running task's icon visible; standalone builds and completed history use folder icons. A
failed status query retains the last confirmed icon and marks its tooltip unavailable.

Switching projects or closing a run panel keeps these indicators active. Tooltips and accessible
labels give each language's running project count. Panel selection keeps its separate background
highlight, and clicking an icon opens the current project's panel. Status refreshes every 1.5
seconds after the previous request finishes, and immediately on returning to the window. A stop
request leaves the icon colored until the host confirms exit; other running projects keep it lit.

An open Java or Python panel follows the selected local project or Worktree, keeping the same
language's panel open with that root's configuration, tasks and logs. The previous configuration is
saved before replacing its panel. An unfinished operation or failed save restores the previous
project selection and keeps its draft and error available; background tasks continue running.

Right-click either toolbar icon to open its running-project list. Each entry shows the task name and
project root; choose one to switch to its project or Worktree, including in another workspace, and
open the matching run panel. Only live run tasks appear, excluding standalone builds and completed
history. The list refreshes every 1.5 seconds while open, reports empty or failed reads, and retries
failed reads automatically. Arrow keys navigate, Enter selects and Escape returns focus to the icon;
Shift+F10 also opens the list. Re-add a removed project before selecting its running task from this
list.

The indicators describe running tasks, not web-service readiness. Commands started manually in an
ordinary terminal are excluded. Reopening the app reads the host's current state without opening a
run panel. A failed status query keeps the last confirmed colors and marks the tooltip unavailable,
with the last confirmed count; a later successful query updates both.

Drag the panel's top divider up or down to adjust its height within the available workspace, leaving
room for the content above. Double-click the divider to restore the default height. With the divider
focused, Up/Down changes height and Home/End selects its minimum/maximum. Expand and Restore keep
the adjusted height while the panel stays open; reopening a closed panel starts at the default
height. Drag previews run once per animation frame without reconnecting the task terminal, and
terminal fitting waits for the drag to settle.

1. Select a module declared by the root `pom.xml`. Project discovery reads at most 200 modules
   inside the selected root; aggregator POMs can build but cannot run.
2. Select Java 8, 11, 17 or 21 and the Maven configuration source. Maven profiles and Spring
   profiles are separate fields. Advanced settings provide a full JDK path, JVM/application
   arguments, environment variables, Skip tests and Maven offline mode.
3. Choose Package, Test or Install, then Build; or choose Development run / JAR run, then Run.

In Development run, **Main class** detects public static `void main(String[])` entry points in Java
classes under each module's `src/main/java`. A unique class annotated with `@SpringBootApplication`
takes priority over ordinary main classes. Multiple preferred candidates require a selection;
**Enter manually** accepts a fully qualified class name. Manual and selected values are saved with
the project's run configuration. Changing the target module resets the entry selection. Detect again
refreshes candidates without replacing the current draft.

Automatic mode shows the unique candidate and passes it to Maven with `spring-boot.run.main-class`.
With no candidates, Maven retains its own entry-point discovery. Scanning skips comments, literals,
nested classes and symbolic links, and is limited to 5,000 entries, 64 directory levels, 1 MiB per
Java file and 32 MiB per module. Custom source directories, generated sources, Kotlin and composed
annotations require manual entry. JAR run uses the packaged manifest; this field does not override
an existing JAR's entry point.

Development run uses `spring-boot:run`. A selected submodule in a multi-module project first
installs its reactor dependencies with tests skipped. JAR run packages the selected reactor and runs
the only ordinary JAR in the module's `target`; when several artifacts exist, select one explicitly.
Selecting an existing JAR runs it with the selected JDK without rebuilding, resolving Maven or
downloading a Wrapper distribution. Sources, Javadoc and test JARs are excluded from automatic
selection.

Run configuration saves before starting a task and when hiding or switching the run panel. Failed
saves remain visible and keep the draft. Environment variables apply to this run only and never
enter the saved configuration. Arguments are split with literal quote handling, without shell
expansion; Windows paths, spaces and shell metacharacters remain argument data.

Saving or preparing a task locks configuration edits and prevents closing or switching the run
panel. Switching to SSH, Redis or database views retains the local Java draft until returning. Check
again refreshes project/tool detection without discarding an existing draft. To adopt saved values
after a conflict, explicitly choose Reload saved configuration.

### System-wide and project Maven configuration

**Settings → Maven settings** edits system-wide defaults. The run panel's **Maven configuration →
Settings** also offers Project configuration. Both configure local/managed Maven, Maven home,
`settings.xml`, the local repository and preference for the project's Wrapper.

Choose opens a native folder picker for Maven home and the local repository, or an XML file picker
for `settings.xml`. The selected path updates the active global/project draft; canceling retains the
previous value. Save applies the draft to subsequent builds.

- Projects inherit the system-wide configuration by default. First choosing Project configuration
  copies the current defaults; saved project overrides remain independent from later global edits.
- Inherit system-wide configuration retains the saved override for later reuse. Worktree roots have
  separate configuration. No POM, system environment variable or existing `settings.xml` is
  rewritten.
- A blank settings path uses Maven's defaults; a blank repository uses the chosen settings file or
  Maven's default. An explicit repository is passed as `maven.repo.local`. Configuration writes use
  revision checks and atomic replacement; Reload recovers from another window's update. The combined
  configuration is limited to 2 MiB; a rejected save retains the previous readable file.
- Changes apply to the next build/run. Existing processes continue with their original environment.
- Saving one scope retains unsaved edits in the other scope. Maven saves prevent closing the
  settings panel or changing its category until the write finishes.

The runner supports Maven 3 and launches its Classworlds entry point directly with the selected JDK.
It reads `.mvn/jvm.config`, Maven's `.mvn/maven.config` and `MAVEN_OPTS`; it does not execute custom
`mvnw` or `mavenrc` scripts. Wrapper mode follows `distributionUrl` in
`.mvn/wrapper/maven-wrapper.properties`, accepts HTTPS ZIP distributions and verifies
`distributionSha256Sum` when provided. Initial Wrapper use requires network access; downloaded
distributions are cached separately. Wrapper configuration and discovery never trigger a download
before the user starts a build/run.

### Optional JDK and Maven tools

**Settings → Java development tools**, also available through Manage tools in the run panel,
downloads or imports only selected components. A full JDK needs both `java` and `javac`; the
database JRE cannot compile projects. Choose a local JDK home or use detection through `JAVA_HOME`,
`PATH` and platform installation directories. Selecting a macOS `.jdk` bundle resolves its
`Contents/Home` directory before JDK validation.

Detected JDKs lists full local installation paths separately from optional managed downloads. The
run panel also shows the selected or detected JDK home. Detect local JDKs updates detection without
installing tools. Repeated detection sources for the same JDK home appear only once.

Choose **Add local JDK**, enter its home or use **Choose JDK home**, then choose **Add**.
Registration validates a complete JDK 8/11/17/21 and saves its canonical path across restarts.
Invalid paths keep the form open with an error. The run panel's JDK selector lists manually added
installations by version and path, including multiple installations of the same version.

**Remove record** removes only the saved reference; it preserves JDK files and project overrides. An
installation still found automatically remains listed. Missing or invalid registered homes stay
visible as unavailable and can be removed; they cannot be selected as a detected runtime. Up to 64
manual records are stored separately from Maven/project configuration, preserving existing draft
revision checks. Invalid saved records are reported without overwriting the file.

Local paths in the run header, working-directory footer, project/Worktree tooltips and Java/Maven
fields display without the Windows `\\?\` prefix. UNC paths retain their `\\server\share` form;
filesystem operations and project identity retain their original path values.

Windows x64 and macOS Intel/Apple Silicon have pinned JDK 8/11/17/21 and Maven components. Temurin
is used except for native Apple Silicon Java 8, which uses Zulu. Archive versions, exact byte sizes
and SHA-256 live in `components/java/catalog.json`; installed archives retain their licenses and
notices. The main installer contains none of these tool archives or project dependencies.

Downloads show progress, retain interrupted prefixes and allow bounded retries, cancellation, manual
download and verified offline installation. Verified downloads remain cached after installation
failure or cancellation. Large-file copying and verification run on background workers. Extraction
bounds paths, file count and expanded size; only internal archive links may be materialized for
development tools. Installation uses versioned directories and does not change system Java or Maven.
Main application builds still need no JDK. Maintainers refresh the catalog with
`node scripts/java-components.mjs` using curl and vendor metadata; the helper checks Maven against
Apache's SHA-512 before recording SHA-256.

Java component installation uses a shared-core operation service; the ordinary client retains its
existing pickers, events and response shape. String IDs/generations identify reads and cancellation;
completed results must be consumed before another operation can start. Closing the service cancels
workers and guards installation-pointer commits. Failed offline imports retain the original archive,
and downloads retain their existing cache paths. Byte counts use bounded 32-bit values so generated
TypeScript/Swift types match actual JSON numbers.

Linux passes five targeted component tests, including a real loopback HTTP download with stale
cancellation, actual cancellation and close while running. Locked Core, six FFI and backend
regressions pass. Windows and macOS regressions also pass in the source-bound CI linked below; these
local checks do not replace native execution.

The native **Settings → Java development tools** section provides the same local JDK detection,
manual registration/removal and five optional managed tools as the ordinary client. It preserves an
invalid path, removes only registry records, supports manual HTTPS download/offline import and keeps
cancellation bound to its actual operation until the worker settles. Settings and quit guards retain
unfinished component operations. Opening the section does not download archives.

Native QA activates the actual navigation/register controls, checks an invalid path is retained,
registers and removes the real CI JDK without deleting files, and captures
`native-settings-java-components.png`. Same-source settings captures include all twelve categories
(24 settings pairs plus eight workspace pairs). A missing/unloaded Java catalog fails collection.
Linux type/build/format/contracts/docs checks, 448 Node regressions (11 platform skips) and 29
package/evidence policy checks pass.

At source head `7170352cf0846c0ee68ea5663ed7c7e8d29adf1c`, tested merge
`0931241bded38efac28ebd534b1dfcdb9c9ce0d7`, macOS 15.8.2 ARM64 and macOS 15.7.9 Intel pass Swift/C
ABI tests and actual navigation, invalid-path retention, JDK registration/removal and file-retention
checks. The generated byte-count tests round-trip 4,294,967,295 and reject overflow.
[ARM report and original image](https://github.com/YondFane/uTerm/actions/runs/42958609545/artifacts/13830711864)
and
[Intel report and original image](https://github.com/YondFane/uTerm/actions/runs/42958609545/artifacts/13832271806)
include `settings-native.json` and `native-settings-java-components.png`.

Both
[Personal packages and actual update installations](https://github.com/YondFane/uTerm/actions/runs/42958609371),
[Windows/macOS regressions](https://github.com/YondFane/uTerm/actions/runs/42958609495) and
[three-platform performance checks](https://github.com/YondFane/uTerm/actions/runs/42958609359)
pass. The
[paired artifact](https://github.com/YondFane/uTerm/actions/runs/42958609495/artifacts/13831527243)
contains 32 pairs and 64 verified original PNGs, including English/dark and Chinese/light Java
settings. Native controls and the ordinary modal still differ visually. Full visual/functional
parity remains open in [#53](https://github.com/YondFane/uTerm/issues/53); screenshot completeness
does not close it. Physical Mac, IME and system-picker interaction were not executed and are waived
as release gates by the user's instruction.

### Shared Java service validation

The development `uterm-core::java` service owns the existing Java/Maven configuration, JDK registry
and probing, bounded POM/main-class discovery, Wrapper resolution and task launch rules. Versioned
`java.*` Core/FFI calls and generated TypeScript/Swift DTOs share this service. Tauri retains IPC,
native pickers, change notifications and app-data/helper adapters.

Select a local project or Worktree in the native QA app, then choose **File → Java build and run…**.
The native window edits module/JDK, global/project Maven settings, profiles and literal
JVM/application arguments; temporary environment values are never saved. It offers Package/Test/
Install/Run, task history, readonly search/copy/follow logs, Stop/Force stop and ordered Run again.
Saving pins the loaded revision and retains conflicting drafts. Closing prompts for unsaved
configuration and detaches tasks; normal quit refuses busy run operations. Pickers select JDK/Maven
paths or a JAR inside the project.

Spring Boot development mode quotes arguments for the plugin's Plexus parser, preserving embedded
single/double quotes and literal backslashes. That plugin discards empty/whitespace-only tokens and
replaces line breaks/tabs; the shared service rejects these values before starting a host or
resolving Maven. Both clients show the same localized **Use JAR mode** instruction and retain the
configured values. JAR mode continues to pass application arguments directly, including empty
strings.

On Windows, the development Maven process uses `-Djdk.lang.Process.allowAmbiguousCommands=false` so
Spring Boot's forked Java process preserves embedded quotes and trailing backslashes. This option
applies to the development run goal.

The `java-build-v1` configuration/registry formats, defaults and root keys stay unchanged. Updated
clients acquire an OS writer lock before configuration CAS or registry replacement; contention
requires explicit retry. Stale or damaged data is retained. Read-only queries do not create
configuration, start a host or occupy the write quit guard. Stop verifies both the task family and
generation. Saves, registration and task preparation remain protected operations.

For Windows Java steps containing a non-ASCII executable, working directory or argument, the new
host starts an isolated UTF-8 child and delegates to the selected JDK's own `jli.dll` launcher. The
host process never loads a JVM. JDK 8 needs a private launcher layout: the runner mirrors the
selected installed JDK into a task-owned cache using file hardlinks (copies across volumes), then
runs the manifested child beside those exact runtime files. It does not install/download a JDK or
modify the selected installation. The mirror is bounded to 32,768 entries, 2 GiB and 32 directory
levels and rejects reparse points. Parent/child shared locks protect live caches; normal completion
removes the cache, and a later launch reclaims released orphan caches older than one minute. Windows
regressions check live-owner exclusion, orphan cleanup, depth rejection and source retention. The
JDK 8 child loads a small embedded compatibility agent before user agents and the main class. It
restores original UTF-8 VM properties and the selected JDK's system URL classpath after Java 8's
early locale decoding, then selects UTF-8 for launcher arguments. The repaired search path retains
user-agent JARs in launcher order, so later premain classes remain loadable. The runtime agent
stores no user arguments; its versioned input stays in process memory. Its launcher path must have
an ASCII relative or existing short representation; otherwise the helper reports
`JAVA_UTF8_AGENT_PATH_UNSUPPORTED`. A non-URL custom system loader that needs classpath repair is
explicitly refused. Application file encoding remains configurable. A bounded anonymous stdin pipe
carries literal arguments; no argument/environment file or shell interpolation is introduced. The
child retains the task console and process-tree lifetime, then returns the actual JVM exit code.
ASCII steps retain direct Java launching. Java 8 requires an ASCII application-data cache path: its
JVM loads native ZIP support before premain can repair locale-decoded paths. A Unicode cache path
reports `JAVA_UTF8_JDK8_CACHE_PATH_UNSUPPORTED` before launch and removes the owned mirror,
retaining the selected JDK. Relative bootstrap paths did not resolve the real Windows failure. This
limitation concerns application data; selected project directories can contain Chinese. New Windows
Java tasks require `java-utf8-launch-v2`; an older active helper reports an upgrade requirement
without killing its existing sessions/tasks. Updated helpers also advertise v1 for older clients. A
loopback protocol regression verifies that v1 alone is refused for the Unicode route while ordinary
task capability probes remain usable. The Unicode route needs Windows per-process UTF-8 support and
a JDK matching the child architecture.

`bash scripts/macos-java-smoke.sh` uses JDK 21 to build a disposable JAR and operate the actual
native menu/window. Native ARM/Intel configuration, conflict, output, search/copy/follow,
reattachment, stop/rerun, visible unsupported-development-argument rejection and cleanup are
recorded with source-bound reports and five WindowServer screenshots per architecture; accepted
baselines and artifact links are in Issue #37. Manual system-picker, keyboard and IME acceptance
remain unexecuted.

The real Core/host fixture checks a Unicode JAR filename, Unicode/emoji/quotes/wildcard/trailing
backslash and empty arguments, temporary environment/JVM properties, both final streams, exit code
7, same-generation replay/ack, stale/cross-family stop refusal, force stop and host cleanup. An
invalid offline Wrapper proves existing-JAR execution bypasses Maven resolution. `jar cfe` creates
an ASCII archive before renaming it to the original Unicode filename, allowing the same fixture to
run on JDK 8/11/17/21. Two Rust processes check global/project CAS, actual writer contention,
explicit retry, registry locking and damaged-byte retention.

The Java interoperability workflow separately collects `java-encoding-diagnostics.json` by launching
ASCII and Unicode JAR paths through the selected real Core/host/JVM. It records actual properties,
literal arguments, launcher traces and exit codes on JDK 8/11/17/21. Collection is diagnostic, not
Unicode task acceptance. The earlier Java 8 report confirms correct application arguments but
corrupted VM properties and classpath; the encoding property override alone was insufficient.

The strict task test retains exact arguments/properties, final output, exit code 7, replay and
generation-safe stop. It additionally uses a Chinese project directory and verifies that a user
premain agent sees the original Unicode/emoji property before main. Application data lives
separately from the Chinese project, as in both desktop clients; the disposable user-agent JAR has
an ASCII path. Separate stock-JDK diagnostics retain BMP and supplementary-character directory
results without using the uTerm host. Local JDK 21 also fails from an emoji directory without an
agent, inside Java's URL decoding; that upstream limitation is not counted as a successful bridge
result. The Windows bridge requires an existing ASCII short path when its own asset path contains
supplementary characters. Platform acceptance of this fix requires its own strict CI result in #37;
source/asset reproducibility does not replace execution.

Run `pnpm test:core` and frontend checks with `JAVA_HOME` pointing to JDK 21 and its `bin` on
`PATH`. The Java interoperability workflow runs the actual Windows host on JDK 8/11/17/21 and
uploads `java-live-core.json`, source/toolchain data and targeted logs. Source
`e06168dbe9491c3c862977dc931c6b7ad098a4ee` / tested merge `e48ce2f886987f92b17f77a42637f6b692bf6da2`
passes the strict Windows matrix on Temurin 8u504, 11.0.32.1+1, 17.0.20.1+1 and 21.0.13+9. Each
clean-source report verifies Chinese project/JAR paths, the user's premain property, exact
Unicode/emoji and empty arguments, final stdout/stderr, exit 7, replay/ack, stale/cross-family stop,
forced cleanup and released caches. All four ASCII/Chinese encoding diagnostics also exit 7 with
exact properties/arguments.
[Run41984445509](https://github.com/YondFane/uTerm/actions/runs/41984445509) retains
[JDK8 artifact13395571787](https://github.com/YondFane/uTerm/actions/runs/41984445509/artifacts/13395571787)
and the corresponding 11/17/21 artifacts. The explicit Unicode Java8 application-data cache
limitation and stock-JDK supplementary-directory failures remain recorded. #37 is closed in the
user-approved scope, with final human checks waived rather than executed. Uncovered Windows
run-panel/picker behavior remains in #13, and original failures retain their evidence in #37.

The optional real Maven fixture uses Maven 3.9.9 and Spring Boot 2.7.18 with a disposable
three-project reactor. It exercises Package/Test/Install, module preparation, development and
package-then-JAR runs through Core and the independent host. Actual tests verify selected
settings.xml, Maven/Spring profiles, `.mvn/jvm.config`, environment/JVM/application literals with
both quote styles and trailing backslashes, final stdout/stderr and empty JAR arguments. A
deliberately failing JUnit check must fail the task; an explicit retry gets a new generation and
passes. Detach/replay retains the host and generation, stale Stop is refused, and graceful stop
preserves the real shutdown hook output. Linux x86_64/JDK21 passes all eight scenarios and cleans up
the host. These are real Maven/Spring Boot processes, not a simulated build or GUI acceptance. The
independent Maven interoperability workflow runs Windows JDK8/11/17/21 and native macOS ARM/Intel
JDK21, uploading `maven-live-core.json`, toolchain and command logs; source-bound platform results
are recorded in Issue #37. Its ASCII paths/arguments do not accept the separate Windows JDK8 Unicode
failure.

The QA Maven installation and dependency cache stay in the runner temporary directory; neither is
bundled with the application.

### Task lifetime and validation

Each project root runs one task at a time. Stop requests interruption; Force stop terminates its
process tree. Rerun first stops the previous task and waits for exit. Process state and exit code
are shown independently of whether a web service is ready.

Stop lets the process finish its interruption cleanup and preserves its final logs. Later steps in
the same task do not start after interruption. Force stop remains available while cleanup is
pending.

Some Windows Java processes do not exit after the interruption request. Use Force stop before
rerunning when the process remains active; the action remains available after a failed Stop request.

Build and run logs retain the most recent 1 MiB of process output. Long lines wrap to the current
pane width without losing their endings when the panel is narrowed, expanded or reopened. Java
standard streams use UTF-8, including Spring Boot processes launched by Maven; application file
encoding remains configurable through JVM arguments. Output already discarded by an older host
cannot be reconstructed. Starting tasks requires a host with pipe-output support; an older host
reports the existing upgrade instruction while its running tasks remain accessible and stoppable.

Java and Python log areas use the selected terminal palette's foreground and opaque background.
Change terminal palettes independently of the interface theme under **Settings → Appearance**; the
colors update existing logs while tasks keep running.

Task log replay shows the most recent retained text when the host snapshot ends in a blank screen
after a terminal resize. Reopening the panel or switching task history does not require new output
to reveal existing logs. Later text follows the log tail without jumping through padded blank rows;
manual scrolling cancels this automatic following. This adjusts the viewport only, preserving the
received bytes, acknowledgement order, session identity and running process. Ordinary interactive
terminals and alternate-screen applications retain their existing viewport behavior.

Quitting detaches from the host. Reopen the same project's Java panel to restore its task and
ordered terminal replay. Tasks stay separate from ordinary terminal discovery; the host retains a
bounded history of completed task output for its current lifetime. An older host without task
support is reported without stopping existing sessions.

The private loopback output channel retains partial 32-byte authentication tokens across its 250 ms
socket polls, within the peer's five-second write budget. Wrong tokens remain rejected. Shutdown
interrupts an incomplete authentication wait while queued authenticated output still drains. The
wire token and task/error formats stay unchanged.

Seven Linux output checks cover controlled timeout/fragment sequences, actual loopback sockets
delayed beyond a poll, exact final bytes, wrong-token refusal, expiry and close. The targeted
command is
`cargo test --locked --manifest-path crates/utermd-local/Cargo.toml --lib task_output::tests`.
`task-output-auth.json` records source/merge, platform and controlled-peer results without token
values; real task subprocesses are checked separately. Full Host/Core/FFI checks and the eight real
Linux Maven/Spring Boot scenarios pass. At source `14596527f8c0642a68fc194f4e505903fc928040` /
tested merge `c48d62c2a0ddce10ffaa92adce6887f91fb40f44`, four clean Windows/macOS authentication
reports passed, as did all six real Maven matrix jobs. These results do not accept the separate
failing Windows JDK8 Unicode check or the Windows preview QA failure.

At source `8491bae96401829e5cc5c3420d5aaccb58494356` / tested merge
`f25eef9b077d0b9be88ed35f311db52868d17f88`, Windows JDK11 Maven failed with
`JAVA_TASK_OUTPUT_FAILED` while five other Maven reports passed. The next source's six passing Maven
jobs do not prove that authentication was the original failure's sole cause or establish long-term
reliability. The fixture now retains task ID, generation and at most 64 KiB of output tail on
transport failure or timeout; its original failure remains in Issue #37.

- Windows native-host regression verifies that ordinary Stop keeps a task running throughout child
  cleanup, retains final stdout/stderr and prevents later task steps from starting. It also verifies
  Force stop during pending cleanup. Real Java and Python processes complete two-second shutdown
  handlers before exit. The Agent enablement, notification and database App regressions pass with
  valid run-summary IPC fixtures. The host suite passes 51 checks with three optional checks
  ignored; backend checks pass 144 with ten ignored. These checks do not establish macOS/Linux
  runtime acceptance.
- Windows JDK registration checks cover invalid paths, native-picker cancellation, concurrent
  detection, add/remove and saving a specific registered JDK in a run configuration. Backend checks
  cover persistent deduplication, removal without deleting JDK files, Maven-file preservation and
  rejection of damaged records. The isolated native Windows app (`sh.uterm.desktop.qa.java`)
  verifies the folder picker, visible invalid-directory errors, adding JDK 21, restoration after
  restart, selection by path and removal back to automatic detection. Four focused frontend tests
  and 136 backend tests pass, with nine optional backend checks ignored; TypeScript, localization,
  formatting, documentation and production/isolated desktop builds pass. macOS/Linux runtime
  acceptance and registering JDK 8/11/17 remain unverified.
- Windows log-theme validation reproduces transparent Java/Python log backgrounds in Clear Sky
  before the fix. The isolated native app (`sh.uterm.desktop.qa.runnavigation`) passes 28 live
  palette-switch checks using real JDK 21 JARs and Python 3.13.5 scripts: all six interface themes
  in both appearance modes, all eight built-in terminal palettes and two custom palettes are covered
  across the cases. Foreground and opaque background match the selected terminal palette; the log
  view, task IDs and generations remain attached. Screenshots verify readable Java and Python logs
  with light interfaces and dark terminal palettes, and with custom light palettes. Production and
  isolated desktop builds, formatting and documentation checks pass. Native macOS/Linux visual
  acceptance remains pending.
- Shared Java/Python project-navigation validation on Windows passes 22 focused frontend checks and
  144 backend checks with ten ignored. Coverage includes project and Worktree selection, save
  failure recovery, cancelled transitions, Windows path matching, language filtering, empty/error
  lists, keyboard focus and cross-workspace navigation. The isolated native app
  (`sh.uterm.desktop.qa.runnavigation`) runs two real JDK 21 JARs and two Python 3.13.5 scripts;
  configuration roots and task logs follow project changes, and list selection opens a project in
  another workspace. Screenshots verify Chinese dark and English light lists and a 680 px viewport;
  Escape restores icon focus. Formatting, localization, documentation, TypeScript, production build
  and isolated desktop compilation pass. Native macOS/Linux navigation acceptance remains pending.
- Windows run-indicator validation passes six focused frontend checks and 144 backend checks with
  ten ignored. Coverage includes global counts, per-root sidebar icons, build/history exclusion,
  root changes without count changes, retained failed snapshots and recovery. The isolated native
  app (`sh.uterm.desktop.qa.runnavigation`) runs three JDK 21 JAR tasks, including an actual Git
  Worktree, and two Python 3.13.5 scripts. It verifies colored 16 px sidebar icons in dark/light
  appearance, pinned projects, cross-workspace navigation, retained icons with panels closed and
  independent stops that restore only the matching folders. The native toolbar checks
  (`sh.uterm.desktop.qa.runicons`) also verify 17 px icons, app-restart recovery and independent
  stops back to gray. TypeScript, localization, formatting, documentation and production/isolated
  desktop builds pass. Native macOS/Linux sidebar-icon acceptance remains pending.
- Windows panel-height checks cover pointer previews, size limits, cancellation, keyboard bounds,
  double-click reset and Expand/Restore. The React task-terminal probe remains mounted during a
  committed drag and is not rerendered for pointer previews. An isolated native Windows app
  (`sh.uterm.desktop.qa.java`) verifies dragging from 380 to 550 px, restoring the same height after
  expansion, double-click reset and keyboard minimum/maximum heights. TypeScript, localization,
  formatting and production/isolated desktop builds pass. macOS/Linux pointer acceptance and
  resizing with a live Spring Boot task remain unverified.
- Windows task-log capture checks cover long stdout/stderr lines through narrow/wide reattachment,
  UTF-8 chunk boundaries, ANSI/newline retention, authenticated loopback capture, final-output drain
  before exit and force-stop disconnects without false read errors. Authentication also covers
  delayed token arrival after connecting; archive extraction covers link chains whose parent
  directories are absent and rejects targets outside the installation root. The isolated native app
  (`sh.uterm.desktop.qa.tasklogs`) runs Spring Boot 3.5.7 on JDK 21 through both an existing JAR and
  Maven 3.10.0 development startup. Both modes preserve 300-character messages and Chinese endings;
  JAR checks also cover pane-width changes, closing/reopening and HTTP readiness. The user's running
  service is left untouched. The host suite passes 48 checks with two optional checks ignored;
  backend checks pass 137 with nine optional checks ignored; 16 focused frontend checks pass.
  Production/isolated desktop builds, formatting, localization and documentation checks pass.
  macOS/Linux runtime and JDK 8/11/17 redirected-stream encoding remain unverified.
- Windows task-log viewport regressions cover blank-padded replay, short and one-row panes, fitting
  after replay, subsequent output, manual scrolling and alternate-screen preservation. An isolated
  native Tauri/WebView2 app (`sh.uterm.desktop.qa.taskreplay`) feeds 80 synthetic startup log lines
  followed by a cleared screen to the real TerminalView. The unadjusted buffer reproduces the blank
  viewport; the repaired view shows the latest retained lines after panel reopening and task
  switching, retains earlier context as new text arrives, and respects manual scrolling. Replay
  acknowledgements continue without fixture errors. This checks simulated frames, not a new live
  Spring Boot service; the user's running service was not stopped. macOS/Linux runtime acceptance
  for this viewport adjustment remains pending.
- Focused Windows checks cover literal arguments/environment variables, Maven scope isolation,
  retained overrides, save-conflict drafts, bounded POM parsing and root escapes. Native host
  integration covers task attachment identity, output retention, force stopping and separation from
  shell discovery, including Unicode, spaces, ampersands and percent signs.
- Windows automated validation passes: 32 focused frontend checks, 131 backend checks with nine
  optional checks ignored, and 42 host checks with two platform/optional checks ignored. Frontend
  coverage includes Java drafts, pending saves, stale task/tool responses, installation
  cancellation, file-tree lifecycle and guarded database/Redis/SSH/project transitions. Backend
  regressions cover configuration size rejection, verified-cache retention, native Maven arguments,
  JDK bundle paths, environment key casing and archive link bounds. Host checks cover generated-JAR
  selection after packaging, GUI-subsystem console attachment, duplicate-task rejection, stale Stop
  generations and live-task restart protection. Formatting, localization, production frontend build
  and isolated desktop build pass. The existing large-chunk warning remains.
- Main-class checks on Windows cover annotated and ordinary entry points, comments/literals, nested
  classes, source bounds, legacy configuration defaults, invalid names and Maven arguments. React
  checks cover unique/multiple candidates, manual drafts, module changes and saving. Isolated native
  QA (`sh.uterm.desktop.qa.java`) verifies automatic identification, candidate selection, manual
  input and restoration after reopening. Selecting a second Spring Boot entry starts that class and
  its HTTP endpoint returns the expected response. macOS/Linux runtime acceptance and nonstandard
  source layouts remain outside this native check.
- Windows path-selection regressions cover global/project scope, picker cancellation and failures,
  pending-operation protection, local JDK paths and clean drive/UNC display while preserving
  original IPC paths. The isolated native Java QA app verifies XML filtering, Chinese/space filename
  selection, folder-picker cancellation and detected JDK 21 at its actual local path.
- The isolated Windows native app (`sh.uterm.desktop.qa.java`) verifies the bottom/expanded panel,
  Maven global/project saves, narrow-window scrolling and task reattachment. A real Spring Boot
  3.5.7 fixture with Maven 3.10.0 and local JDK 21 packages successfully and serves HTTP through
  development and JAR launches. HTTP checks confirm Spring profiles and literal Chinese, ampersand
  and percent-sign arguments/environment values; JAR checks also confirm JVM properties and that
  temporary environment values are absent after reopening the panel. Managed Maven download,
  checksum verification, installation and development launch also pass in the isolated app. The
  service survives application exit; authenticated host reattachment preserves its task generation,
  and force stopping releases the service port. An existing JAR also serves HTTP with nonexistent
  Maven home and settings paths, preserving its Spring profile, literal arguments and JVM property.
- The unsigned Windows x64 Java QA NSIS installer measurement is 9,419,233 bytes (9.42 MB, 8.98
  MiB), excluding optional tools and Maven dependencies. macOS runtime acceptance, Java 8/11/17
  execution, Wrapper downloads and full multi-module Spring Boot service acceptance remain pending.
  Gradle, Java language services, breakpoint debugging and remote deployment are outside this panel.

## Python projects and logs

### Configure and run a project

Open a local project or Worktree, then choose **Python run** from its project menu or the workspace
toolbar. The bottom panel keeps the editor available above the configuration and live logs. Drag its
top separator to resize it, or expand it. Switching between the Java and Python panels saves the
current configuration; hiding a panel leaves its task running.

The toolbar's Python icon is blue/yellow while any managed Python project or Worktree has a live
script, module, FastAPI, Flask or Django task. It stays colored across project and panel changes,
and returns to gray after the last Python task exits. Its tooltip gives the global running project
count; this indicates process lifetime rather than web-service readiness.

The open Python panel follows project and Worktree selection, with the same save protection as the
Java panel. Right-click the Python icon and choose a live entry to open that project's configuration
and logs; see [Build and run a project](#build-and-run-a-project) for the shared list behavior.

1. Select an existing Python 3 executable. Detection lists project `.venv` and `venv` environments
   before executables on PATH; a saved selection is retained. Enter a path or use the file picker
   for another environment. Virtual environments run directly without an activation script.
2. Select Python script, Python module, FastAPI, Flask or Django. Choose a project-relative script,
   a module such as `package.main`, or an application entry such as `app.main:app`. Flask also
   accepts a factory such as `app:create_app()`.
3. Set the working directory. Web presets expose an IP address, port and Auto reload. Defaults are
   `127.0.0.1:8000`, or port `5000` for Flask; reload and Flask's interactive debugger start
   disabled.
4. Choose **Run**. The panel shows the process state, exit code and live stdout/stderr, including
   exception tracebacks. A web task offers its configured service URL; it is not a readiness check.

Detection reads Python sources without importing the project. It suggests simple top-level
`FastAPI(...)` / `Flask(...)` assignments and `manage.py`, and leaves ambiguous entries for explicit
selection. It skips virtual environments, generated directories and symlinks. Scanning is bounded to
2,000 entries, six directory levels, 128 KiB per source file, 2 MiB total source and approximately
100 candidates. Aliases, multiline declarations and nonstandard layouts may need a manual entry.

**Advanced settings** provides literal application arguments and temporary environment variables.
Arguments respect quoting without shell expansion. Environment variables are not saved; UTF-8 and
unbuffered Python output are enforced for readable live logs. Missing interpreters or framework
packages produce visible errors. Prepare Python and dependencies outside the panel: uTerm does not
download Python, create environments or install packages, and includes none of them in its
installer.

**Save configuration** appears as a compact button below the advanced fields, aligned to the right.

### Configuration, logs and task lifetime

Each project root, including each Worktree, saves one run configuration in uTerm's application data.
Atomic saves check revisions. A failed or conflicting save retains the draft and existing file;
**Check again** refreshes detection without replacing edits or accepting a newer revision. Use
**Reload saved configuration** explicitly after a conflict. Saves and task preparation block panel
switching and repeated actions. SSH, Redis and database views retain the hidden local draft.

The log view is read-only, uses the terminal palette's foreground and background, and supports
search, copying retained plain text and Auto follow. Scrolling up pauses following; checking Auto
follow resumes it. Its checkbox stays beside the label in both Java and Python logs; clicking the
label also toggles following. Task history remains available after exit, with the most recent 1 MiB
per task and up to 32 completed tasks across the host. History is bounded and lives only for the
host's lifetime; it is not a permanent log archive or a file-log viewer.

Use an ordinary terminal for programs requiring interactive input or a Python REPL; the log panel
does not accept process input.

Each root allows one task at a time, shared with Java; different roots run independently. **Stop**
requests interruption, and **Force stop** terminates the process tree, including reload workers.
Some Windows processes remain alive after interruption; use Force stop before running again.

Ordinary Stop allows interruption cleanup to finish and retains the process's final logs. The task
stays running during cleanup, and Force stop remains available.

**Run again** waits for the old task to exit before starting another. Quitting uTerm detaches;
reopen the project's Python panel to reattach to the same task and replay its output. Ordinary
terminal discovery excludes these tasks.

Older hosts without task/pipe support report an upgrade error while existing sessions remain
running. Script and working-directory selection cannot escape the selected root; the interpreter may
be installed elsewhere.

#### Shared Python service validation

The development `uterm-core::python` service owns existing interpreter detection, source scanning,
five launch modes, configuration and host-task rules. Tauri retains only IPC, file pickers and
platform app-data/helper adapters. Versioned `python.*` Core/FFI calls use the same service;
generated Rust DTOs supply TypeScript and Swift types. In the native QA app, select a local project
or Worktree and choose **File → Python run…**. Its native window edits the shared configuration,
selects detected interpreters/entries, accepts one literal argument per row and temporary
environment pairs, and shows readonly task output/history. Saving pins the loaded revision; explicit
reload and closing prompt before discarding edited configuration. Run saves configuration before
starting; Stop/Force stop use the captured task generation. Closing the window detaches without
stopping its task.

The log toolbar uses the pinned terminal library's literal next/previous search and match counter,
with a native Auto follow checkbox. Scrolling up pauses follow; output continues to be consumed and
acknowledged while the viewport keeps its buffer-line anchor. Rechecking follow returns to the end.
**Run again** saves configuration, normally stops only this root's Python task, waits for its exit,
and starts a new generation; a task still stopping after five seconds requires explicit Force stop.
Normal stop retains final cleanup output, and copy reports native clipboard failures visibly.

Native Choose buttons select an interpreter, script (Script/Django modes) or working directory. Both
clients validate selection results through the shared Rust path rules. Interpreter symlink spelling
is preserved for virtual environments; script/directory selections cannot escape the project.
Cancelling leaves the draft unchanged and invalid selections show an error without replacing it.
Reload's Save choice saves successfully before adopting saved values.

Core and real-process contract checks cover literal selections, symlinks, project escape and invalid
kinds. The native smoke also checks cancellation-result handling, interpreter spelling and
project-bound selection results through the bound form/Core calls; it does not operate the system
picker. Linux Core/FFI and focused backend checks pass, as do 401 frontend checks (ten skipped),
TypeScript/production build, contracts, formatting, localization and documentation. The new picker
controls still need their own macOS CI and manual dialog/keyboard/IME acceptance. Full settings/menu
integration remains pending; Java's native window has separate implementation and acceptance
records.

The `python-run-v1/configuration.json` format and project-root keys remain unchanged. An OS writer
lock serializes updated clients before revision checks and atomic replacement; a busy writer
requires explicit retry. Reading defaults/tasks creates neither configuration nor a host. Damaged
bytes and stale revisions refuse replacement. This lock does not retrofit old installed binaries.
Stop checks the task generation and Python task family before asking the host to terminate it.

Linux checks run a real Python script and isolated Rust host, preserving literal Unicode/Shell
arguments and temporary environment values, nonzero exit, last raw output, consumption ack,
detach/replay and bounded cleanup. Stale generations and an actual other-family task cannot be
stopped by Python requests. Separate Rust processes verify configuration CAS, an actual OS writer
lock, explicit retry and damaged-file preservation. Existing Python mode/path/scanning tests moved
with the implementation; no separate Swift launch planner was added. Core/FFI, frontend and backend
regressions pass locally. The Python service passed macOS/Windows CI at `692cd6c`; older Windows
framework evidence below is not reused for the extraction. `bash scripts/macos-python-smoke.sh` adds
actual native menu/window checks for configuration conflict, real script output/nonzero exit,
detach/replay with the same generation, stale stop refusal and force stop, plus search, paused
viewport consumption, follow resumption, same-host PID, normal-stop final output/copy and run-again
ordering. Four screenshots include English/dark, paused output and Chinese/light narrow windows.
[Native CI 41771783432](https://github.com/YondFane/uTerm/actions/runs/41771783432) passes on macOS
ARM/Intel for source `ee0b1ac` and tested merge `e213eaa61e119c307566a50329acd85985432032`. The ARM
artifact `native-qa-macos-15-ee0b1ac38fe42db2ad772bb68a8ae144268c47be` includes `python-live.json`
and the four `native-python-*.png` screenshots, including paused output. This Linux environment has
no AppKit/Swift toolchain. Manual input/IME and full settings/menu integration remain unaccepted;
the later Java migration is not covered by this Python evidence.

The raw-task replay check uses one ten-second deadline for the complete operation, including each
receive, and reports the last sequence and actual host task state on failure. The corrected check
passes on Windows/macOS in CI 41770931806 for source `692cd6c`; an earlier inner two-second receive
failed before the declared operation deadline. No test or required platform is skipped.

#### Python control layout validation on Linux

- The isolated native app (`sh.uterm.desktop.qa.pythonlayout`) passes 16 layout combinations: script
  and FastAPI configuration forms, 1380 px and 800 px windows, English and Simplified Chinese, and
  dark and light appearance. Save configuration stays below the advanced fields, right-aligned and
  28 px high; its size remains compact when advanced settings are reopened. The log checkbox stays
  beside its label and vertically centered. Clicking the label, toggling with Space and scrolling up
  to pause following pass; saving still shows confirmation.
- A real Python script fixture supplies the logs; FastAPI is a configuration-form layout check. All
  25 focused Python-panel, argument, replay, renderer and resize tests pass, along with type
  checking, production and Linux desktop builds, formatting, localization and documentation checks.
  These checks cover the controls; macOS/Windows acceptance of this layout remains pending.
- Release preflight on Linux passes 343 frontend tests with ten skipped, 59 host tests with three
  ignored, and 150 backend tests with ten ignored. Production build, version consistency and the
  bilingual release-note checks pass.

#### Python validation on Windows

- Shared toolbar-indicator validation uses a real Java JAR and Python script in
  `sh.uterm.desktop.qa.runicons`. Dark/light 17 px rendering, global counts across project changes
  and closed panels, restoration after app restart and independent stopping back to gray pass.
  Focused frontend and backend summary checks also cover query failures without clearing the last
  confirmed state. This checks the toolbar; narrow-window and light-mode run-panel acceptance remain
  pending.
- Focused frontend checks cover literal arguments/environment values, unique and ambiguous entry
  defaults, immutable running-task URLs, failed saves, hidden drafts, pending actions and force-stop
  recovery. Backend checks cover all five command forms, source detection bounds, root containment,
  configuration conflicts and corrupt-file preservation.
- A real isolated Python 3.13.5 environment validates UTF-8 stdout/stderr, literal
  Chinese/space/shell characters, missing dependencies and nonzero exits. Host integration runs
  scripts, modules, FastAPI 0.162.0 with Uvicorn 0.54.0, Flask 3.1.3 and Django 6.1.2, checks HTTP
  responses, reconnects with the same generation, rejects stale stops and verifies that stopping
  reload trees releases ports.
- The isolated native Windows application (`sh.uterm.desktop.qa.python`) validates Chinese dark-mode
  configuration, FastAPI entry selection, an actual HTTP response, live logs, search, expanded
  layout, panel reopening and retained output after exit. After the QA application process ends,
  HTTP remains available and authenticated IPC reattaches the same generation and replays startup
  logs. Force stop releases the port; the isolated host is then shut down. No existing application
  or service is stopped.
- Python and Java panel regressions pass separately, alongside 29 argument, replay, log-copy,
  resize, lifecycle and internationalization checks. Python backend checks, the backend suite with
  four test threads, host tests, formatting, documentation, production build and desktop compilation
  pass. Desktop compilation uses an isolated Cargo target because the existing executable is in use.
- The full frontend suite passes 341 checks with 11 optional/platform checks skipped, including
  content-font, database-app and Git-worktree coverage. The build retains the existing large-chunk
  warning. Narrow-window and light-mode native acceptance remain pending.
- macOS/Linux runtime acceptance and final installer size remain unmeasured. Framework fixtures are
  local and do not connect to existing databases or external services.

## Agents and settings

### Enabling Agents

Settings → Agent and the standalone Agent panel place an Enable switch after each program’s
availability status. Agents start disabled until explicitly enabled; the choice is saved across
restarts.

- Only enabled, detected Agents appear in project/Worktree creation buttons, the Add menu and the
  default chat Agent selector. Missing programs cannot be enabled; a previously enabled program that
  becomes unavailable can still be disabled.

- New chat uses the preferred Agent when enabled and available, otherwise the first enabled,
  available Agent; without one, the action is disabled. Turning an Agent off hides its creation
  entries without closing existing sessions or removing its program, configuration or Hooks.

- Saving failures remain visible and preserve the previous selection.

### Finding and configuring Agents

Settings → Agent and the standalone Agent panel provide a compact list with enable switches. Search
by name, ID or program command, or filter to available or enabled Agents. Select an Agent to see its
availability, program and applicable installation, configuration and Hooks actions in the detail
area. Use Add agent to configure a custom program.

Wide panels place the list and details side by side with separate scrolling. Narrow panels stack
them vertically. Search and filters affect this view only; they do not change which Agents are
enabled or close existing sessions.

#### Layout checks and limits

- Nineteen focused interface checks pass, including search, empty results, filter and switch
  interaction, custom Agents, installation confirmation/errors and Hooks targets in both languages.
  The complete frontend/build-helper suite passes 284 tests with ten optional/platform checks
  skipped. Formatting, localization, TypeScript/production build and an isolated macOS desktop build
  pass.

- Native macOS QA (`sh.uterm.desktop.qa.agentlayout`) uses the real Agent settings with mock
  availability and temporary preferences. Visual inspection covers wide and narrow containers,
  Chinese/dark and English/light views, search and the configuration form. Native dropdown
  selection, a complete keyboard-only flow, actual installation/Hook changes and Windows/Linux
  runtime acceptance remain unverified. The installed application was not replaced or restarted.

### Usage and quota refresh

Settings → Usage provides separate Claude, Codex, Kimi and Grok tabs. Opening Usage immediately
queries Claude, and selecting another Agent tab directly queries that Agent, including its local
seven-day token totals and available provider quota windows.

- Each tab retains its latest result and error while switching between Agents; macOS automatically
  allows the Claude query to request credentials from Keychain. The Usage page also sets the
  remaining-usage refresh interval to a whole 10–3600 seconds (60 seconds by default); the value is
  saved across restarts.

- For an active supported Agent session, the workspace title bar queries immediately and then at
  that interval, without overlapping a still-running request. Clicking the remaining percentage
  opens every valid quota window with its remaining percentage, progress and reset time; clicking
  outside or pressing Escape closes the details.

- A failed or credential-less quota query hides the title-bar indicator until a later refresh
  succeeds.

#### Validation and limits

- The 147 frontend/build-helper tests, localization check and production build pass, including
  settings compatibility, interval validation, automatic tab queries, non-overlapping refresh and
  the clickable details; authenticated provider queries and native interaction remain pending.

### Token logs and incomplete UTF-8 records

Local token logs are read as bounded byte records. When reading a large file tail, the incomplete
first record is discarded before UTF-8 decoding.

Records containing invalid UTF-8, including unfinished characters in logs being written, are skipped
and the totals show a partial-record notice; valid records and provider quota requests can still be
processed. Real filesystem read errors remain visible.

The seven-day filter, 8 MiB per-file limit, 64 MiB total budget, five-second scan limit and
deduplication rules remain in effect.

#### UTF-8 usage checks on Windows

- UTF-8 usage validation on Windows: all 84 backend checks pass (six optional/resource checks
  ignored), together with 18 focused usage and bilingual interface checks. Regression fixtures cover
  a fully valid UTF-8 file whose 8 MiB tail starts inside a Chinese character, invalid bytes between
  valid records and incomplete final characters for Claude, Codex, Kimi and Grok.

- Interface checks retain token totals and quota windows alongside the partial-record notice in both
  languages. Changed-source formatting, localization, documentation, TypeScript/production and the
  isolated Windows desktop build (`sh.uterm.desktop.qa.usageutf8`) pass.

- The production build retains its large-chunk warning. Authenticated provider queries and
  macOS/Linux runtime acceptance of these paths remain unverified.

#### Agent-enablement checks

- Agent enablement validation: all 145 frontend/build-helper tests, 39 backend tests, local-session
  service tests, locked dependency installation, formatting, localization, documentation checks,
  TypeScript/production build and the isolated macOS desktop build pass. Settings and component
  tests cover explicit defaults, invalid saved values, built-in/custom Agents, immediate entry
  updates, default-chat fallback, existing-session retention, persistence, bilingual labels and
  storage failures.

- The isolated macOS QA app (`sh.uterm.desktop.qa.agentenable`) verifies switch alignment after
  availability, the unavailable-program disabled state, shared settings/Agent-panel state, and Codex
  disappearing from and returning to the Add menu when toggled. Native restart persistence, keyboard
  interaction and Windows runtime acceptance remain pending.

### Kimi executable discovery

Kimi detection and Agent launch search `~/.kimi-code/bin` after inherited PATH entries, alongside
the existing default installation directories. This lets macOS apps launched with a minimal GUI PATH
find Kimi without depending on a terminal startup environment.

Explicit program paths and PATH precedence are preserved. Custom installation locations still need a
configured absolute executable path.

#### Validation and limits

- An isolated subprocess regression test with an empty PATH verifies detection and the launch PATH;
  another verifies PATH precedence. Local-service tests, 39 backend tests and the desktop/production
  build pass on macOS.

- The installed application has not been replaced, and authenticated Kimi sessions and Windows
  runtime behavior remain unverified.

### Agent brand icons

Kimi, OpenCode, Grok, Hermes, Pi, MiniMax, Qwen Code, Copilot CLI, iFlow CLI and TRAE CLI use their
brand icons in Agent settings, sidebar creation/session controls and session tabs. Hermes, MiniMax,
Qwen Code, Copilot CLI and TRAE CLI use Lobe Icons' original brand paths; Pi uses its official SVG
geometry, and iFlow uses the official CLI site's favicon. Sources and applicable rights are retained
in `NOTICE`.

Vector marks inherit the interface color in dark and light themes; iFlow retains its original image
colors. All assets ship locally and need no network request. Unknown agents retain the terminal
icon.

#### Brand-icon checks on Windows

- Windows validation passes 17 focused frontend checks, changed-source/test formatting and
  TypeScript/production build. Icon checks cover the bundled paths, original iFlow image, distinct
  marks and safe fallback for unknown identifiers.

- The isolated native Tauri/WebView2 fixture (`sh.uterm.desktop.qa.agenthooksicons`) renders the
  real Agent settings with temporary availability data. Visual inspection confirms all six
  additional marks and Hook controls in Chinese/dark and English/light views. It does not launch
  providers or restart the installed app; macOS/Linux visual acceptance remains pending. The tests
  retain Vite WebSocket-port/React act warnings and production builds retain the large-chunk
  warning.

### Agent installation

Settings → Agent and the standalone Agent panel include Claude, Codex, Gemini, OpenCode, Kimi, Grok,
Hermes, Pi, MiniMax, Qwen Code, Copilot CLI, iFlow CLI and TRAE CLI. Each uses the existing
project/chat launch flow and starts disabled.

1. For a missing program, select Install program, then confirm installation or open the official
   installation guide.
2. After installation, select Check again. Configure a custom executable path when needed.
3. Turn on Enable, then create a session from a project/Worktree row or the Add menu.

| Agent                                                                                                        | Default command | Installation entry                     |
| ------------------------------------------------------------------------------------------------------------ | --------------- | -------------------------------------- |
| [Hermes](https://hermes-agent.nousresearch.com/docs/getting-started/installation/)                           | `hermes`        | Official installer script              |
| [Pi](https://pi.dev/)                                                                                        | `pi`            | npm: `@earendil-works/pi-coding-agent` |
| [MiniMax](https://agent.minimax.io/docs/cli/quick-start)                                                     | `mcode`         | npm: `@minimax-ai/code`                |
| [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/)                                    | `qwen`          | npm: `@qwen-code/qwen-code`            |
| [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) | `copilot`       | npm: `@github/copilot`                 |
| [iFlow CLI](https://docs.iflow.cn/cli/quickstart/)                                                           | `iflow`         | npm: `@iflow-ai/iflow-cli`             |
| [TRAE CLI](https://docs.trae.cn/cli_get-started-with-trae-cli-2)                                             | `traecli`       | Official TRAE CLI 2.0 installer script |

- OpenCode, Claude, Codex, Gemini, Pi, MiniMax, Qwen Code, Copilot CLI and iFlow CLI support
  confirmed global npm installation. Node.js/npm, a version supported by the CLI and network access
  are required; installation does not elevate privileges. Only fixed package identifiers are
  accepted; installation runs off the UI thread, concurrent installs are rejected, and errors remain
  visible.

- Completion refreshes program detection; custom npm prefixes may require configuring the executable
  path or restarting uTerm. Kimi links to official installation instructions; Grok and custom
  executables require publisher-directed manual installation and path configuration.

- Detection preserves inherited PATH precedence. Default search paths include `~/.local/bin`,
  `~/.opencode/bin`, `~/.kimi-code/bin`, `~/.pi/agent/bin` and `~/.minimax-code/bin`. Windows also
  searches `%APPDATA%\npm`, `%LOCALAPPDATA%\hermes\bin`, `%USERPROFILE%\.minimax-code` and
  `%LOCALAPPDATA%\Programs\TraeCLI\bin`.

- Hermes downloads its official platform script and runs it without interactive setup, browser or
  computer-use installation. The download is limited to 1 MiB; execution is limited to ten minutes
  and 10 MiB of output. It does not elevate privileges or bypass PowerShell execution policy.
  MiniMax's npm installation includes optional dependencies and permits its SQLite install scripts.

- Complete provider login and model configuration in the CLI itself. Hermes, Pi, MiniMax, Qwen Code,
  Copilot CLI, iFlow CLI and TRAE CLI do not provide uTerm usage integration. The iFlow project has
  announced service shutdown; retaining its installer and Hooks does not guarantee that its hosted
  services are available.

#### Validation and limits

- Bilingual component tests cover confirmation, failure/retry, refresh, official installation links,
  enablement and the MiniMax `mcode` configuration default. Backend tests cover the package
  allowlist. Windows local-service fixtures verify all seven additional command mappings, default
  installation directories, inherited PATH precedence, launch command construction and custom
  program overrides.

- Windows validation passes 278 frontend/build-helper checks (11 optional/platform checks skipped),
  111 backend checks (nine ignored) and 38 local-service checks (two ignored). Tests cover custom
  identifier isolation, literal installer paths, MiniMax dependency flags, Hook reinstall/removal
  without unnecessary files or backups, retained user entries, malformed JSON, configuration
  conflicts and Pi's settled completion and closed reporter input. Formatting of the changed
  source/tests and Rust files, documentation, TypeScript/production and the isolated desktop build
  (`sh.uterm.desktop.qa.traebuild`) pass.

- Localization passes. These automated checks do not establish live provider, database or SSH
  acceptance.

- An isolated native Tauri/WebView2 fixture (`sh.uterm.desktop.qa.additionalagents`) renders the
  real Agent settings with temporary availability and settings data. Visual inspection confirms the
  six names, availability and switch alignment in the Chinese dark interface, English label
  switching and the MiniMax `mcode` field. The fixture does not launch provider CLIs or replace the
  installed app.

- Actual package downloads, authenticated Agent sessions and macOS/Linux runtime acceptance remain
  unverified.

### TRAE CLI

Open Settings → Agent → TRAE CLI, install the program, then enable it to create project, Worktree or
standalone chat sessions. The default command is `traecli`; Configure accepts an absolute program
path and a JSON array of arguments for custom installations. A `trae` editor launcher does not count
as the CLI.

Installation downloads the official TRAE CLI 2.0 platform script and runs it in the background with
unattended confirmation. The script download is limited to 1 MiB; execution is limited to ten
minutes and 10 MiB of output. PowerShell execution policy and installation errors remain visible.
Sign in and complete any first-run sandbox setup inside the CLI using an account with the required
access.

TRAE CLI uses its bundled brand icon and generic terminal notifications when emitted by the CLI.
Automatic uTerm Hooks, precise task-state events and usage/quota integration are unavailable.

#### Validation and limits

- Windows component fixtures verify bilingual installation confirmation, official guide links,
  program defaults, brand icons and enablement. Local-service fixtures verify `traecli` detection
  with an empty PATH, inherited PATH precedence, launch construction and custom program overrides.
  Backend checks verify official script URLs, unattended confirmation and literal script paths
  without Hermes-only arguments.

- All 17 focused frontend checks, 111 backend checks (nine ignored) and 38 local-service checks (two
  ignored) pass on Windows, together with formatting, localization, documentation,
  TypeScript/production and the isolated Windows desktop build. The full frontend/build-helper suite
  passes 278 checks with 11 optional/platform checks skipped.

- The isolated native Tauri/WebView2 fixture (`sh.uterm.desktop.qa.trae`) renders the real Agent
  settings with temporary availability and settings data. Visual inspection confirms the brand icon,
  availability, enable switch, `traecli` configuration and installation prompt in Chinese/dark and
  English/light views. The fixture does not install or launch TRAE or replace the installed app.

- Actual TRAE installation, authenticated model requests and macOS/Linux runtime acceptance remain
  unverified.

### Dismissing break reminders

Clicking blank space inside or outside a break reminder, or pressing Escape, does not dismiss it.
Use Keep working to close it manually, or wait ten seconds for automatic dismissal.

#### Validation and limits

- Component interaction and timer tests pass for these paths; native WebView interaction remains
  unverified.

### Break reminder settings layout

The break reminder switch and interval input share one row in General settings, without the
auto-dismiss helper text. Reminder timing and validation are unchanged.

#### Validation and limits

- A browser preview verifies the row alignment; bilingual component tests check both controls and
  removal of the helper text.

### Break reminder timing

Settings → General includes a Break reminder switch (off by default) and an interval of 1–1440 whole
minutes (default 60). Interval edits save on leaving the field.

- While the app runs, a non-blocking reminder appears without taking focus, closes automatically
  after ten seconds, and can be dismissed with Keep working. Dismissal restarts the interval;
  changing the interval or restarting the app also resets it.

- Disabling cancels pending reminders. Missed intervals during sleep are not queued, and the app
  does not force its window to the foreground.

#### Validation and limits

- Timer and settings regression tests cover automatic/manual dismissal, cleanup and invalid values;
  native timing and visual acceptance remain pending.

### Resetting interface settings

The global Reset interface and terminal settings action appears only in Settings → General. Other
settings categories do not repeat it, so its scope is distinct from category-specific controls.

Resetting keeps the existing backup and visible error behavior.

### Launch at login

Settings → General → Launch at login controls automatic startup after OS sign-in on Windows and
macOS. Login startup keeps the main window hidden and runs in the system tray (macOS menu bar);
click the tray icon to open it.

Right-click the tray icon and left-click **Launch at login** to turn it on or off. A check mark
means startup is enabled. This item and the General settings switch share the same system
registration; changes also update an open settings dialog. The menu follows the application's
language.

- Manual launches and session links still open the window, while repeated background launches leave
  an existing window hidden. For an existing startup entry, turn this setting off and on to apply
  background startup.

- Opening settings reads the system registration without enabling it. Changes apply immediately;
  failures remain visible and can be retried. A failed tray-menu change restores the last confirmed
  check mark and shows an error dialog.

- Resetting interface settings does not change the OS registration. Development builds use a
  separate startup entry.

#### Validation and limits

- On Windows, all 22 focused taskbar, settings/localization and highlight-setting checks pass,
  including bilingual tray labels, enabling/disabling, failure recovery and updates to an open
  settings dialog from mocked tray events. TypeScript and the production frontend build pass. An
  isolated browser preview verifies the General settings layout.

- Windows backend checks pass with 107 tests passed and nine optional checks ignored. The isolated
  desktop build (`sh.uterm.desktop.qa.tray-autostart`), localization and documentation checks pass.
  Native startup and visual inspection confirm that background startup keeps the main window hidden
  and a subsequent manual launch shows the application without startup errors.

- Actual OS sign-in, visual tray-click acceptance and macOS acceptance remain pending.

### Agent definitions and activity

Agent definitions specify a program and argument list. Structured events and native terminal
reminders report activity; Hooks remain optional. Usage can combine local logs with provider
requests when enabled.

Custom identifiers keep their own configuration actions and do not inherit built-in installation
guides or defaults, including identifiers such as `constructor`.

Provider credentials and permissions determine availability. Terminal input and process I/O are
handled independently of UI rendering.

The native QA client opens **File → Agent settings…** for custom commands, enable/disable,
installation, Hooks and usage. Commands use an executable and JSON string array; argument errors
retain the draft. Hiding the window retains it, switching commands confirms unsaved changes and
quitting refuses an active operation or asks about an unsaved command. Local usage reads no account
credentials; reading account quota requires an explicit action and may request Keychain access.

`uterm-core::{agents,agent_install}` owns the existing provider rules; Tauri delegates its unchanged
commands and Swift uses Core JSON calls. The Pi extension is embedded from
`crates/uterm-core/integrations/pi-activity.js`. QA passes explicit private provider directories
without changing `HOME`, `CODEX_HOME` or the user's account selectors. Reporter updates use a staged
replacement, preserving the prior executable if the new copy fails.

Failed installers return a classified error code without their output, which can contain registry
credentials. The retry message remains bilingual; private installer output is not included in UI or
CI diagnostics.

Shared Linux regressions pass 18 Agent checks (one resource profile is intentionally ignored), five
installer checks and two platform/real-Hooks checks. An installed reporter child process drains 64
KiB of input, produces real Host working/done events and rejects stale generations. The installer
failure/retry test executes private scripts rather than installing a provider globally. Three
focused frontend notification/Pi suites, TypeScript, localization and the QA backend check pass. The
first native build found an optional generation at the adapter boundary; the adapter now rejects
missing generations before evaluating notification eligibility. That failed build does not establish
window acceptance.

The Tauri real-app harness also opens Agent settings, saves/enables/disables/removes a private
custom command, changes canonical notification opt-out, installs/removes Hooks and retains an
invalid argument draft with a visible error. Post-exit checks require other tools' Hooks to survive.
Notification opt-in permissions remain covered by explicitly mocked regressions. Native QA cancels
an actual app quit with an Agent draft. Activity labels update only when status changes; ordinary
output does not trigger workspace redraws. Activity failures cancel pending notifications and show a
reconnect hint. The native Close menu action hides the focused Agent window and retains its draft;
it never closes the selected terminal behind that window.

Tauri setting scenes wait for the control's save result before reading the canonical store. A
visible writer-busy failure requires an explicit, bounded retry and is counted in the scene report;
other errors fail the run. This avoids the observer taking a lock during the write under test. The
initial lock-failure report is retained in #40. Agent selection uses the application's current brand
label.

A component regression runs these actions against the actual Agent form with mocked native services,
forces one busy save and requires an explicit successful retry before the observer runs. It verifies
three scene outcomes, final definition/enable cleanup and no notification permission request.

Source `424fd23b55e44d116e51eb4224771ea963352df7`, tested merge
`950bf24aaaad8e39b7855662d04d7000801f7649`, passes Native
[run 42173232949](https://github.com/YondFane/uTerm/actions/runs/42173232949) on macOS 15.8.2 arm64
and 15.7.9 Intel, and Tauri
[run 42173232927](https://github.com/YondFane/uTerm/actions/runs/42173232927) on macOS 26.7.2 arm64
and Windows Server 2025 x64. All four archives report a clean source tree. Native reports pass with
exit 0, including actual quit cancellation; Tauri passes 71 scenes per platform with no cleanup
errors or observer busy reads. The forced busy-write component regression passes on Linux, macOS and
Windows. All four installed-reporter reports pass real Host events, stale-generation rejection and
private Host cleanup. The archives contain `agent-native.json`, `agent-hooks-core.json`, Tauri
`agent-live.json`, logs and ten reviewed original application screenshots. The
[acceptance record](https://github.com/YondFane/uTerm/issues/40#issuecomment-6679048480) links each
artifact and image. Provider authentication, global package installation and final OS notification
delivery remain explicitly simulated; final human acceptance is waived by the user. This evidence
does not replace the separate
[#41 settings/menu acceptance](https://github.com/YondFane/uTerm/issues/41#issuecomment-6690738106)
or merge the draft PR.

### Installing and removing Hooks

Settings → Agent → Install Hooks configures Claude, Codex, Gemini, Pi, MiniMax, Qwen Code, Copilot
CLI and iFlow CLI. Reinstalling keeps one uTerm reporter per supported event, replacing recognized
entries from other release, development or QA installations even when their paths differ.

- Remove Hooks also removes these recognized entries for the selected Agent. Other tools' commands
  and settings, including commands in the same group, are preserved.

- Unchanged Hook configurations are not rewritten or backed up again. Removing absent Hooks does not
  create configuration files or extensions; unrelated empty Hook groups are preserved.

- Only literal standalone uTerm reporter commands are managed; double-quoted command substitutions
  or variable expressions, custom wrappers and combined shell commands remain untouched.
  Configuration conflict checks and backups remain in effect, and changes apply to new Agent
  sessions.

| Agent       | Hook file or extension                     | Activity                                     |
| ----------- | ------------------------------------------ | -------------------------------------------- |
| Qwen Code   | `~/.qwen/settings.json`                    | Idle, working, permission waiting, completed |
| iFlow CLI   | `~/.iflow/settings.json`                   | Idle, working, notification, completed       |
| Copilot CLI | `~/.copilot/hooks/uterm-activity.json`     | Idle, working, completed                     |
| Pi          | `~/.pi/agent/extensions/uterm-activity.js` | Idle, working, settled completion            |
| MiniMax     | `~/.minimax/plugins/uterm-activity/`       | Idle, working, permission waiting, completed |

Copilot uses direct executable/argument entries. Pi runs its reporter off the UI thread, closes the
reporter's input and waits for `agent_settled`, so an intermediate `agent_end` does not report a
finished task. Pi requires a version that exposes this event; update older installations. Pi and
Copilot do not report a separate permission-waiting state.

MiniMax uses a local compatible plugin. If it was manually disabled, enable `uterm-activity` in
`/plugins`. Custom directories honor `COPILOT_HOME`, `PI_CODING_AGENT_DIR`, `MINIMAX_DATA_DIR` and
`MAVIS_DATA_DIR`; set the MiniMax data directory to the active custom profile when applicable.
Existing hook-disable settings and unrelated plugins are preserved. Remove Hooks leaves Pi's
extension inactive and removes uTerm commands from the JSON configurations, retaining backups.

Hermes provides a Hook setup guide instead of automatic uTerm state integration. Its shared gateway
can serve multiple terminal clients without their individual uTerm environment, so gateway hooks
cannot reliably identify a terminal session. Follow its official guide for manual hooks; enabling
them does not establish uTerm session-state integration.

### Windows Hook commands

Windows Hooks explicitly invoke PowerShell with a literal executable path, so PowerShell and cmd.exe
runners support spaces, Chinese and shell metacharacters without treating the quoted path as an
expression. To configure reporting, select Install Hooks and open a new Agent session.

Other tools' Hooks remain independently configured and may need their own Windows commands.

### Notifications without Hooks

Enable Settings → Agent → Notify when tasks finish or need attention, then open a new Agent session.
The original interactive terminal interface is retained. Installing Hooks is optional.

| Agent                                                                                | Notification source                                                                                                                                                                |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex                                                                                | A dedicated authenticated loopback app-server and the original TUI connected through `--remote`; unsupported versions or invocation-specific configuration use terminal reminders. |
| OpenCode                                                                             | Its own authenticated loopback server and SSE session/permission events. Custom server or attach arguments retain terminal reminders.                                              |
| Claude                                                                               | A terminal bell enabled for this launch with `--settings`; explicit later CLI settings retain precedence.                                                                          |
| Gemini, Kimi, Grok, Hermes, Pi, MiniMax, Qwen Code, Copilot CLI, iFlow CLI, TRAE CLI | Native terminal notifications or BEL when the CLI emits them. Availability and enablement depend on the CLI version and settings.                                                  |

- All thirteen built-in Agents, custom Agents and ordinary terminals share the OSC 9, OSC 777, basic
  OSC 99 and BEL reminder channel. A generic signal displays “Session has a new notification” with
  an amber indicator; it never establishes task completion or permission waiting. Viewing the
  session acknowledges the reminder. OSC title, clipboard, directory and progress controls do not
  trigger reminders.

- Generic reminders also appear in the tray task list with an amber attention indicator and their
  own label. Failure labels say “Task failed”, including failures while the Agent process remains
  running.

- Codex invocation-specific profiles, config/feature overrides, OSS selection, worktree creation and
  starting-directory overrides retain the original local launch with terminal reminders, so an
  independent server cannot silently change those settings. Configuration from `CODEX_HOME` remains
  available to the managed event server.

- Codex and OpenCode use structured status to distinguish work, completion, attention and failure.
  Codex excludes subagents and temporary helper threads and supports both paginated and legacy
  history. A cancelled Codex turn does not report success. OpenCode ignores child sessions and
  requires observed work before reporting completion; an error followed by idle is not completion.

- Native reminders may require a CLI setting: Gemini uses `general.enableNotifications`; Hermes
  offers `display.bell_on_complete`; Copilot uses `beep`. Other CLIs must emit a supported terminal
  notification or bell themselves. If no signal is emitted, only process exit can be detected;
  silence, CPU usage and displayed prose are not treated as completion. Process-exit notifications
  say “Session ended” on success or “Session exited with an error” on failure, independently of a
  turn completing while its process remains alive.

- Each event has its own ID, so consecutive completed turns can notify without an intervening
  working frame. Up to 128 recent events are retained per session. Replay and reattachment do not
  resend history, and acknowledging an older event does not clear a newer one. Bell bursts are
  combined, and structured events take precedence over terminal reminders and compatible Hooks.

- Event connections stay on authenticated loopback endpoints and retry after disconnection. Their
  errors appear separately from terminal connection errors and clear after recovery. Existing Hooks
  and user configuration files are preserved. Codex WebSocket app-server transport remains
  experimental upstream; unsupported API behavior is visible and retains terminal reminders.

- Starting an Agent's event service does not hold the session-list lock, so existing sessions remain
  available while a CLI probe or server startup is pending. New-session creation and safe host
  shutdown remain serialized.

- Existing host processes keep their current capabilities until safely replaced; existing sessions
  are not restarted automatically. Notifications require the application to remain running,
  including in the background. Reopening after quitting restores state without sending historical
  notifications. SSH and terminal-multiplexer forwarding remain dependent on those tools passing the
  escape sequences through.

#### No-Hook notification validation

Windows host regressions cover every built-in Agent's generic event path, split escape sequences,
non-notification controls, replay, independent event IDs and structured-event precedence. Frontend
regressions cover old-host frames, invalid event metadata, repeated completed turns, generic copy,
failure copy, native permissions and duplicate suppression.

- Windows serial host checks pass (38 checks); two installed-CLI checks run separately and pass.
  Serial backend checks pass (108 passed, nine opt-in checks ignored). Serial execution avoids
  process-startup and executable-cleanup timing failures in the QA environment.

- The complete frontend/build-helper suite passes (273 passed, 11 optional/platform checks skipped).
  Focused checks cover batched font adjustments, tray reminder labels, repository switching, legacy
  Codex turn ordering and retaining custom invocation settings. A slow-CLI regression verifies that
  host requests remain responsive during startup.

- Changed-source/test and Rust formatting, localization, documentation, TypeScript/production and
  Windows desktop checks pass. Vite's WebSocket-port and large-chunk warnings remain.

The installed Codex CLI 0.163.0 runs its real TUI against an isolated deterministic loopback model
fixture, with no Hooks or real provider credentials. Two successive turns produce distinct
authenticated completion events, and closing the session removes its temporary authentication file.
OpenCode CLI 1.18.32 runs its original TUI with authenticated SSE and rejects unauthenticated
requests; it makes no model request in this check. A loopback SSE fixture covers child-session
filtering, permissions, failures and completion.

An isolated native Tauri/WebView2 app (`sh.uterm.desktop.qa.nativeactivity`) renders the real
settings and indicators with fixture availability. Chinese/dark and English/light screenshots
confirm the six-pixel generic reminder indicator, labels and notification description without
horizontal overflow. A real native tray sync accepts the generic reminder with attention status; two
file-font increments and one diff-font increment persist independently before another render. The
installed app and active sessions are not restarted. Real-provider acceptance for all Agents,
installed notification delivery/branding and macOS/Linux runtime acceptance remain unverified.

### Agent state and notifications

The sidebar and Agent pane header display the same idle, working, needs-attention or completed
state, plus a distinct generic-reminder state. Unviewed completion highlights the sidebar icon until
acknowledged.

- Settings → Agent → Notify when tasks finish or need attention is off by default and requests
  permission through the native notification service when enabled. The switch and delivery checks
  use native permission results, so a stale WebView denial does not block enabling native
  notifications. A failed permission request or preference save leaves the switch unchanged and
  displays an error. Completion and attention notify when the app is unfocused or another session is
  selected; development builds, restored history and repeated identical states do not send
  notifications. Independent events from capable hosts are deduplicated by event ID rather than
  state, so successive completed turns can each notify.

- Pending permission results are ignored after a newer Agent state, session closure or view unmount;
  dispatch also rechecks the current notification setting, focus and selected session. Native
  dispatch failures remain visible.

- Native Agent settings use the same optional canonical `agentNotifications` preference as Tauri;
  absent values retain the imported legacy preference and otherwise default to off. Opening settings
  does not write a default or request permission. Native activity comes from accepted terminal
  frames; no quiet-time completion is fabricated. The native gate uses `UInt64` event sequences,
  bounded event-ID retention and generation/session checks. Swift regressions cover adjacent values
  above JavaScript's safe-integer limit, `UInt64.max`, replay and invalidation of pending notices.

- `bash scripts/macos-agent-smoke.sh` uses a real isolated native window, private commands/usage,
  installed reporter processes and actual Host frames. Its OS permission and delivery adapter is
  explicitly simulated; provider sign-in and actual system notification presentation are not
  claimed. It archives source-bound reports and English/dark and Chinese/light narrow-window
  screenshots. The user has waived final manual acceptance; automated failures still require fixes.

#### Hook and notification automated checks

- Hook regressions cover idempotent installation, old/encoded paths, mixed groups, removal,
  unrelated commands, preservation of dynamic shell expressions, no-op file/backup protection and
  actual PowerShell/cmd execution with literal special-character paths.

- Notification and settings regressions pass. The App regression covers indicator states, unread
  acknowledgement, opt-in, focus, native permissions, replay, duplicate suppression, development
  builds and dispatch failures. Deferred permission checks verify cancellation after opting out,
  viewing/closing a session, receiving a newer state or unmounting, including delivery of only the
  latest pending state.

- Settings coverage includes a denied WebView cache with native permission granted, native
  permission requests, denial, query/save failures, pending requests, provider reload and disabling
  without requesting permission.

- Changed-source/test and Rust formatting, localization, documentation checks, TypeScript/production
  and the isolated Windows desktop build (`sh.uterm.desktop.qa.nativeactivity`) pass. Tests/builds
  retain the Vite WebSocket-port and large-chunk warnings.

- Permission and deferred-notification regressions use mocked native commands. Native acceptance of
  enabling and delivering notifications through the updated permission path in installed Windows
  builds, installed notification branding, authenticated providers and macOS/Linux acceptance remain
  unverified.

#### Hook and notification native checks

- An isolated native app (`sh.uterm.desktop.qa.agenthooks`, unoptimized with the production
  notification gate enabled) runs the installed Codex CLI 0.163.0 against a deterministic loopback
  model fixture. Real prompt/Stop Hooks update both working/completed indicators without Hook
  failures, and the completed sidebar icon glows.

- Executing the generated attention Hook with 64 KiB of stdin verifies yellow indicators;
  acknowledgement clears completion. Windows toast history confirms completion and attention
  messages.

- Repeated attention reports and reattachment do not resend notifications, and repeated installation
  retains one reporter per event. A combined CLI smoke test also preserves another tool's
  Windows-specific Hook overrides with its remote-session environment cleared.

- The unpackaged QA app uses the notification plugin's PowerShell identity; installed-app
  notification branding, authenticated provider runs and macOS/Linux runtime acceptance remain
  unverified. The user's active app and sessions are not restarted.

### Appearance and terminal preferences

Settings include appearance, color themes, fonts, terminal cursor and scrollback, keyboard
shortcuts, default shell and Agent. Core `settings.catalog` reads the existing defaults and a
generated bilingual catalog of 31 commands, eight terminal themes and six interface themes from the
current TypeScript sources. Opening the catalog does not save defaults. `pnpm settings:check` and
the normal contract checks verify generation.

Core `settings.validate` checks the full settings shape, platform shortcut conflicts, reserved
system/editor keys and optional default bindings without writing configuration. `settings.commands`
resolves bindings from the same rules. The native **Commands** menu updates its keys after saving
and clears colliding fallback menu keys. The palette and capture controls show macOS key glyphs.

**Command palette** provides native search, Up/Down, Return and Escape. Dismissing it restores its
originating window/responder and cannot close a terminal behind it. Plain navigation keys are
handled only in the owned visible palette; its event monitor is removed on dismissal and modified
keys retain normal text editing. Commands follow the current window/session context. The Tauri
welcome-page primary action uses the same pending-draft/transition guard as the command menu. Its
concurrent-input QA clicks a connected button in the same JavaScript turn; the visible real terminal
remains a required assertion. Native **Files**, **Search** and **Quick open** show a tools pane
backed by the shared Rust file service. Return or double-click opens a file; content search opens
the matching line while preserving an existing editor's text. Hidden files are optional, partial
results are labelled, and outside-root symlink targets cannot be opened. Search results from a
cancelled request or previous project cannot replace the current list.

**Toggle inspector** hides/restores tools; **Swap panes** saves its left/right position, including
with the project sidebar hidden. Closing focused tools returns focus to the selected terminal
without closing its session. **Zoom** shows only the selected split pane, then restores the shared
layout and cached terminal views; hidden sessions continue receiving output.

**GitHub** opens the existing shared panel in a native window. Both clients use Rust
`github.repositories/read/prepare/create` for GitHub CLI access, repository/fork discovery, issue/PR
details, diff and explicit PR creation. Native tools preserve the selected root and refuse other
methods or private CLI arguments. Session association uses revision-checked shared state; linked
sessions keep the issue URL and title. Inserting a URL requires a selected Agent session with input
control and does not send Return. Closing the window preserves its PR form. Quitting refuses active
requests or asks before discarding a form; cancellation cannot release an already dispatched CLI
operation before its actual result. PR creation uses literal JSON input and never pushes a branch or
creates a fork implicitly.

The native QA app opens **Settings → All settings…** or **File → All settings…** for General,
Appearance, Terminal, Files/Agents and Shortcuts. Changes remain drafts until **Save settings**.
**Restore defaults** prepares a draft and still requires saving. Hiding/reopening retains the draft;
quit refuses an active operation or asks about unsaved changes. Invalid numbers and reserved or
duplicate shortcuts show an error without discarding input. Saving checks each changed field against
the latest store, preserving unrelated peer changes and refusing conflicting overwrites.

Both clients parse Ghostty themes through Core `settings.theme.import`, retaining existing name/ID,
UTF-16 length, six-digit color and palette-index rules. Parsing itself does not save settings. Tauri
saves after a successful selection; native import adds a draft that requires **Save settings**. The
native chooser reads at most 32 KB and requires UTF-8. Names remove only a final `.conf` or `.txt`,
ignoring extension case; other extensions remain part of the name and identity.

Native terminals and task logs apply bundled/custom palettes, cursor/selection colors, available
font fallback/weight, line spacing, cursor shape/blink, scrollback and background opacity. Copy on
selection copies after mouse selection ends. Interface palette/font, row/window padding, sidebar
visibility, active icon color, project name sorting and optional background material are connected
to the workspace.

Native break reminders use the shared enable/interval preferences. A nonmodal notice appears once
after the interval, closes after ten seconds or **Continue working**, and starts the next interval
from dismissal without replaying missed reminders after sleep. Changing the interval or disabling
the preference hides the current notice. The timer stops when the client shuts down.

Native editable file windows enforce the shared per-directory file-tab limit, retaining the newest
tabs. Opening another file or lowering the limit prepares excess editors before closing them; clean
saves use the existing save path, while a conflicting write refuses the new opening and retains
existing tabs/drafts. The existing Close action offers Keep editing or explicit discard before
retrying. Existing missing-source recovery still opens retained drafts read-only. Agent settings
refresh the selected supported Agent's usage while visible, using the shared remote/local preference
and interval with one request at a time. Automatic reads do not request Keychain access; explicit
account reads retain their confirmation. Hiding the window or preparing to quit stops polling.
Native automatic-update effects remain tracked in #45.

**General → Login startup** reads OS state without registering on open. Explicit opt-in/out uses
macOS `SMAppService`; approval-required and failed operations stay visible and active operations
block quitting. This system preference applies immediately, separately from the shared draft.
Isolated settings QA simulates approval, success, failure and disable without registering a CI login
item or changing shared settings. Real OS registration/approval is not executed in CI; the
user-authorized simulation boundary and final human waiver are explicit.

#### Validation and limits

`bash scripts/macos-inspector-smoke.sh` uses the isolated native QA app, temporary files and real
PTYs to check file navigation, hidden files, symlink boundaries, Unicode search/line navigation,
retained editor text, cancellation, quick open, pane swap, zoom, focus and explicit host cleanup. It
records four original WindowServer captures and `inspector-native.json`, including source head and
tested merge SHAs. Source `52eb2bb440175b44895bd58882d0485c98ada144`, tested merge
`2d21a040c4e9e33c2dd52ec5eada4c2cde11db92`, passes these checks on macOS arm64 and Intel in
[run42214355682](https://github.com/YondFane/uTerm/actions/runs/42214355682). The four ARM originals
were individually inspected. Earlier build/input/focus failures remain in the Issue evidence; those
results are not reused for later source revisions. Final human acceptance is waived by the user.

`scripts/interaction-matrix.py` audits each client's source head/tested SHA, required reports and
original PNG captures. Each capability separates implementation, build, automatic checks, native
actions and waived manual acceptance. Editor summaries carry the isolation flag after both actual
processes validate their private profiles; missing metadata remains a failing gate. Native terminal
QA also checks simulated marked text with zero interim PTY bytes and one exact Unicode commit, and
simulated sleep/wake/display notifications with retained views/generations and resumed actual
output. Windows reuses actual desktop editor/settings/Git and input-ownership scenes plus labelled
composition/input tests. Missing/failed/stale evidence fails the audit. Physical IME, hardware sleep
and multiple monitors are not represented as executed; manual acceptance is waived.
`interaction-matrix.json` keeps those boundaries and original M3 layout, session-tab-drag and PDF
gaps explicit; it does not declare stable cutover acceptance.

`bash scripts/macos-github-smoke.sh` runs the real native WebView window with an isolated simulated
`gh`, temporary Git repository and real PTYs. It checks root/method/type boundaries, sanitized
Markdown, shared session links, PR details/diff, visible offline failures/retry, cancellation, draft
hide/reopen/quit cancellation, literal submission, pending-request quit protection and bilingual
theme captures. `github-native.json`, the simulated CLI log and four original screenshots are CI
artifacts. Draft quit confirmation uses an asynchronous sheet attached to its own window, keeping
WebKit and main-actor tasks responsive. Actual ARM CI at source `3719222` passes Cancel and draft
retention, then fails explicit creation: preparation returns extra `branch` metadata that the strict
Core creation contract rejects. The panel now copies only title/base/head into the form; the
regression includes extra preparation fields and requires one exact creation payload. The PR draft
checkbox uses compact inline sizing. Intel source `cdedb12860c5a20c88c1945b21c96c84770173ce` passes
all GitHub checks with four original captures in
[artifact13516460493](https://github.com/YondFane/uTerm/actions/runs/42236559031/artifacts/13516460493).
This is scoped GitHub evidence; that workflow fails the separate SDK installation capture and
interaction-summary metadata checks. No account, real GitHub write, push or fork is used. Shared
session tests retain stale/malformed link, reopening and split checks.

Linux checks pass the 422 existing frontend tests (11 skipped), the added GitHub panel regression,
242 Core/FFI/failure-mode tests (17 ignored), 84 host tests (3 ignored), 18 Tauri backend tests (1
ignored), type checking, production/desktop builds, contract/localization checks and formatting.
Java-dependent checks use JDK 21. A real Core process with the isolated CLI also passes eight
repository/read/diff/prepare/create/invalid/offline/retry requests with one exact JSON creation.
These local results use simulated GitHub responses and do not replace native CI screenshots.

An ARM Core run hit the isolated SSH server's source-address penalty during deliberate host-key
failures. The fixture now detects support with `sshd -T` and disables that penalty only in its
temporary server configuration; older OpenSSH keeps its supported configuration. Host-key rejection
assertions remain required and now include the actual error on failure. Production SSH configuration
is unchanged. The native inspector retains its observing root view during PTY updates and snapshots
a row's identity/generation before opening, rather than restarting its focus/reload tasks on every
update. Intel Return and GitHub boundary failures remain recorded; their reports now include
selection state and returned boundary codes for the required rerun. Dependency caching on CI failure
does not turn a failed gate into a passing result.

Settings/menu/command acceptance #41 is complete on source
`949e4c23dc22d2b01e4823b96a73a26e8c26f60c`, tested merge `b8e96bbb42501213040f0b93bff009ecd24623a7`.
Native [run42251082940](https://github.com/YondFane/uTerm/actions/runs/42251082940) passes
settings/inspector/GitHub reports and Core/FFI/Swift tests on macOS15.8.2 arm64 and15.7.9 Intel; its
overall result still fails the separate #45 SDK capture. Tauri
[run42251082946](https://github.com/YondFane/uTerm/actions/runs/42251082946) passes both full jobs
on macOS26.6.2 arm64 and Windows Server2025 x64, each with73 actual-app scenes and no cleanup
errors. All reports bind clean source/merge identities; this source is not presented as a later
commit retest.

The actual Rust process/TypeScript checks pass 372 shortcut configurations, 11,532 resolved-binding
comparisons and 96 theme inputs, including Unicode names, contextual lowercasing, encoded IDs,
leading-zero palette indices and invalid colors. They verify unchanged defaults/store and bounded
rejection of invalid/private parameters. These logic reports do not replace native window checks.

`bash scripts/macos-settings-smoke.sh` checks actual menu/shortcut capture, search and
arrow/Return/Escape input, return focus, explicit reset, actual quit cancellation, invalid drafts,
conflicting/unrelated peer writes, theme drafts and actual themed PTY effects. It also uses real
temporary files for theme names, UTF-8 and bounded reads. Settings QA runs after the generic window
smoke, retaining every other native check. The same origin/return window is verified on both
architectures; login approval/failure/disable remains explicitly simulated.

Twelve original application screenshots have been reviewed. Native archives include
`settings-native.json`, logs and `native-settings-command-palette.png`,
`native-settings-themed-terminal.png`, `native-settings-full-dark-en.png` and
`native-settings-full-light-zh-narrow.png`. Tauri archives include `settings-platform.json`,
`tauri-state-qa/report.json`, `initial-theme-invalid.json/.png` and
`initial-theme-imported.json/.png`. The
[evidence record](https://github.com/YondFane/uTerm/issues/41#issuecomment-6690738106) links all
four artifacts, commands, toolchains and captures. Tauri uses DOM File events inside the real
application; OS file-chooser interaction is not claimed. macOS images use WindowServer and Windows
uses the owned QA HWND with capture metadata.

Earlier window-capture, SSH askpass and focus-assertion failures, plus cancelled superseded runs,
remain in the Issue records. The focus test now activates the intended settings origin rather than
expecting it while the main workspace is in front after cancelled quit. These failures are not
counted as passes. #41 is accepted against its four criteria and the separate
settings/inspector/GitHub reports. The older `nativeSettingsFeatureAcceptanceComplete=false` summary
remains visible because its remaining list points at #45 updates and those separate reports; it is
not rewritten as true. Login approval uses the authorized simulation, final human acceptance is
waived, and neither establishes stable cutover or merges the draft PR.

### Terminal text selection and rendering

Visible terminal and Agent panes use GPU rendering when WebGL2 is available. Dragging to select text
updates the highlight without rebuilding the visible text nodes at every mouse movement. Copy
shortcuts and the optional Copy on selection setting retain their existing behavior.

Visible panes, including grouped panes, keep their GPU contexts. Up to three recently hidden panes
also retain their renderers for 15 seconds, allowing quick switches to reuse them. The oldest hidden
renderer is released when the idle cache is full; visible panes are never evicted by this cache.
Closing a view releases its renderer immediately. Session identity, scrollback and selection remain
intact when a renderer is released.

Hidden panes leave the page layout and disable their screen-reader text layer, pausing DOM rendering
and screen-reader row measurements. They continue consuming and acknowledging output. Showing them
restores rendering and the screen-reader layer without restarting sessions. Unchanged panes skip
React rendering when another session receives focus; callbacks still use current workspace state.
Workspace persistence and the resize/replay ordering remain unchanged.

Unsupported GPUs, initialization failures and context loss that cannot be restored fall back to DOM
rendering automatically. This fallback can still slow down when selecting dense output.

Live screen-reader announcements retain at most 8,192 UTF-16 code units, including the overflow
message. Older announcement text is discarded when applications redraw without line feeds. The
readable terminal rows, scrollback, selection and input remain intact.

#### Selection-rendering checks

- Windows renderer, accessibility, input, scrolling, replay/resize and workspace regressions pass
  (55 focused checks plus three React rendering checks). They cover idle limits/expiry, visible
  split-pane protection, GPU failure/context loss, no remounting, skipped unrelated panes and fresh
  callbacks after memoization. TypeScript, localization and production builds pass.

- An isolated native Windows Tauri/WebView2 app (`sh.uterm.desktop.qa.switchperf`) uses the real
  TerminalWorkspace and TerminalView with four simulated session channels and ongoing output.
  Eighteen switches retain four initial attachments and create GPU renderers only for the three
  visited panes. Two visible split panes continue showing output; hidden panes have no accessibility
  layer, output acknowledgements continue and no fixture errors are reported. These checks use
  simulated frames and do not establish live Codex/OpenCode process performance.

- An isolated Windows Chrome comparison uses two real xterm instances, 800 simulated output lines
  each and 18 switches per strategy. Synchronous main-thread switch time has a median of 24.2 ms
  with immediate renderer disposal and 4.6 ms with the idle pool; GPU activations fall from 20 to
  two. This is a component comparison, not desktop end-to-end latency. Background-tab frame
  scheduling is excluded from the reported synchronous timing.

- On macOS, all 28 focused accessibility, renderer, input, scrolling and resize regressions pass.
  The full frontend suite passes (280 passed, ten optional/platform checks skipped), alongside
  repository formatting, localization, TypeScript, the production build and desktop compilation. The
  production build retains its large-chunk warning. Locked dependency installation, local-session
  service tests and backend tests pass; the backend suite has 114 passes and nine opt-in checks
  ignored.

- An isolated native Tauri/WebKit app (`sh.uterm.desktop.qa.terminalselection`) uses the real
  terminal view and 600 rows of colored Chinese/English fixture output. Across 120 selection
  updates, visible-screen node additions/removals fall from 424,257 with DOM rendering to zero with
  GPU rendering; the longest measured frame falls from 66 ms to 18 ms. These fixture measurements do
  not guarantee the same frame timings on other hardware or live workloads.

- Native mouse dragging shows multi-line selection highlights. Injected context loss returns to DOM
  rendering, retains selection and accepts more output; showing the pane again enables GPU
  rendering.

- An isolated macOS Tauri/WebKit fixture (`sh.uterm.desktop.qa.selectionfreeze`) exercises eight
  real terminal views, 300 simulated project entries and 180 frames of colored Chinese/English
  output and selection updates. Pausing hidden views reduces the measured 95th-percentile frame time
  from 233 ms to 20 ms and accessibility-row measurements from 10,416 to 126. These fixture timings
  are hardware/load dependent and do not establish live Agent acceptance.

- The same fixture verifies hidden-session replay and live output, with both frames acknowledged.
  Hiding/showing preserves selected text and coordinates, restores the visible screen-reader layer
  and keeps the start count at eight. Native mouse dragging and subsequent input remain responsive.

- The installed macOS app (0.1.37) reproduces the whole-window stall when the existing Codex session
  is scrolled and selected manually. During the confirmed stall, a three-second sample stays almost
  entirely in WebKit's `characterIndexForPoint` / `previousCandidate` text traversal and CPU usage
  approaches 100%; a window screenshot request also times out. This is separate from background
  rendering overhead.

- The accessibility regression covers repeated redraws without line feeds, Chinese/emoji boundaries,
  retained readable rows and selection, replacing the accessibility layer and observer disposal. An
  isolated native Tauri/WebKit fixture (`sh.uterm.desktop.qa.selectionhittest`) writes 8,000
  cursor-based redraws without line feeds through the real terminal. Announcements remain bounded at
  8,192 code units, retain the latest text and preserve all 43 readable row elements and the input
  textarea.

The announcement limit still needs acceptance in the installed app against the same live Codex
session; the running installation was not replaced or restarted. Clipboard shortcut routing remains
covered by automated tests; native clipboard, grouped-pane acceptance and Windows/Linux runtime
checks remain pending.

### Content font shortcuts and session headers

Use Ctrl+- to decrease or Ctrl++ to increase the font of the content shown in the middle workspace.
Ctrl+= also increases it; Ctrl+Shift+= produces Ctrl++ on common keyboards. macOS uses Command in
place of Ctrl. Settings → Shortcuts provides Decrease content font size and Increase content font
size; existing custom shortcuts keep priority over these defaults.

Terminal and Agent sessions share the terminal font setting. Text, HTML source and Markdown use the
file setting; an expanded Git diff in the middle workspace uses the Git diff setting. These three
sizes are independent, change by 1 px within 10–32 px and save immediately. Consecutive adjustments
retain each increment, including when different content types change before the next render. Images,
PDF and static HTML previews keep their existing sizing behavior. Dialogs and context menus retain
their own keyboard handling.

Session headers show the configured starting directory beside the session name, with the complete
path in its tooltip. This directory does not follow shell `cd` commands. Long paths truncate to keep
**A−**, the current pixel size and **A+** accessible. The buttons adjust the shared terminal font
setting and disable at its bounds; save failures appear in the session.

#### Windows checks and limits

- All 29 focused settings, path, viewer-header, content-font and file-menu tests pass. Coverage
  includes Ctrl and Command combinations, the shifted plus alias, custom-binding priority,
  independent saved sizes, menu targets and visible failures. TypeScript, localization,
  production/native QA builds and changed-file formatting checks pass; the production build retains
  its large-chunk warning.

- An isolated Windows Tauri/WebView2 app (`sh.uterm.desktop.qa.contentcontrols`) runs the real App,
  shell and temporary Git project. Native key input verifies all three font targets, terminal input
  suppression, terminal buttons and the upper bound, and retained CodeMirror instance/selection.
  Visual inspection covers session headers, file text and an expanded Git diff in Chinese/dark, plus
  the header and menu in English/light at 1000 × 700. Clipboard and reveal calls are mocked; no
  model requests are used. macOS/Linux runtime acceptance remains pending.

### Mouse wheel and trackpad scrolling

Terminal and Agent panes use small steps for slow mouse-wheel scrolling and accelerate consecutive
faster turns. A typical isolated notch moves about one history row; faster same-direction input
increases the multiplier up to six times.

- Pausing for more than 200 ms, reversing direction or changing the scrolling context resets
  acceleration and fractional carry. Fine trackpad pixels retain proportional distance and
  fractional accumulation without extra acceleration; larger pixel deltas and line-based events use
  wheel normalization, since browsers do not identify the physical device.

- Alt/Option adds its existing speed multiplier. Horizontal/Shift and Ctrl/Cmd gestures retain their
  existing handling.

- History moves immediately, bounded to four viewports per event; page-based events move by viewport
  height. Application scrolling keeps xterm's original mouse or cursor-key encoding, with at most 12
  steps (or the pane's row count when smaller) per event, combined into one input write.

- Applications decide how many rows each step moves; saved scrollback limits still apply.

#### Scrolling checks on Windows

- Scrolling validation on Windows: all 17 focused input/scroll regressions, changed-source/test
  formatting, localization/documentation checks and TypeScript/production build pass. A probe of
  1,000 discrete wheel events and ten page events records zero layout measurements; a fine pixel
  event still measures the rendered row height.

- Tests cover slow/fast pixel and line notches, bounded acceleration, pause/reversal/context resets,
  fractional trackpad input, modifiers, mouse protocols, disabled input and cleanup. An isolated
  native Tauri/WebView2 host (`sh.uterm.desktop.qa.terminalscroll`) runs seven scenarios with the
  real xterm renderer and injected wheel events: four 300 ms-spaced notches move four history rows,
  four 30 ms-spaced notches move 13, and eight 2 px events move one row.

- SGR/legacy binary mouse and alternate-screen cursor reports retain encoding and use one batched
  input write per event; disabled application input sends nothing. The fixture uses no real
  processes or Agent credentials and does not restart the installed application.

- Physical-wheel/trackpad feel, live Agent behavior and macOS/Linux runtime acceptance remain
  pending. The production build retains its large-chunk warning.

### File and Git diff font sizes

Settings → Appearance provides independent File font size and Git diff font size controls alongside
the existing font controls. Both default to 14 px and accept whole numbers from 10 to 32 px.

File viewing also provides **A−**, the current pixel size and **A+** in the file header, before the
save status. Each click changes the shared file font size by 1 px and saves it immediately. The
buttons disable at the size limits and are available for editable/read-only text, HTML source and
Markdown previews. Image, PDF and static HTML previews keep their own sizing controls or styles.

- Enter or leaving the field applies and saves the value; existing files and diffs update
  immediately, and the values persist across restarts. File font size covers editable/read-only text
  and Markdown previews, with headings and code scaling proportionally.

- Git diff font size covers working/staged changes, branch comparisons and commit history in
  unified, side-by-side and expanded views. Interface and terminal sizes remain independent; PDF
  zoom and HTML page styles retain their existing behavior.

- Older version-1 settings receive the defaults for missing fields; invalid values and save failures
  remain visible without replacing saved data. Reset interface and terminal settings resets both
  sizes.

- Font changes preserve the mounted editor, draft, selection and undo history and do not save or
  reload the file.

#### Font-size checks on Windows

- Windows validation: 21 content-font, settings and localization tests pass, including toolbar
  clicks, 10/32 px disabled states, immediate persistence, visible save failures and retry,
  old-setting defaults and independent font settings. The real CodeMirror regression retains its
  instance, unsaved text, selection and undo history, covers read-only text/Markdown switching and
  all Git diff modes with portal expansion, and confirms that font changes do not save files or
  reload diffs.

- Production build, TypeScript, localization, documentation and changed-file formatting checks pass.
  The production build retains its large-chunk warning.

- An isolated Windows Tauri/WebView2 fixture (`sh.uterm.desktop.qa.filefont`) runs the real file
  editor with sample documents and mocked desktop commands. Native clicks verify immediate sizing,
  retained drafts/selection, disabled limits, save failure/retry and persistence after reloading.
  Visual inspection covers Chinese/dark text at 20 px, English/light text at 32 px in a 640 px
  viewport and Markdown at 20 px. HTML source offers the buttons; static HTML and image previews
  hide them. No real file writes are used.

- The expanded unified Git diff was visually checked with the content shortcuts above; other Git
  diff layouts and macOS/Linux runtime acceptance remain pending.

### Automatic updates and confirmation

#### Native macOS update adapter

The native QA app includes Sparkle 2.10.1 and offers **Check for updates…** in the app menu and
General settings. An ordinary QA build has no feed/public key, displays an unavailable state and
does not initialize an updater controller or make network checks. A configured build uses shared
`automaticUpdates`, off by default; cached SDK preferences cannot re-enable it. Windows/Tauri also
leaves its delayed startup check disabled when automatic updates are off; explicit checking remains
available.

Native feed configuration fixes stable/preview and the current arm64/x86_64 architecture. QA sources
must be literal loopback URLs. Appcast items require matching `uterm:platform`/`uterm:architecture`
metadata, channel and same-origin ZIP archives before proceeding. SDK package verification remains
required separately. Sparkle retains its native download/install UI; application termination still
uses the existing editor, transfer and database guards. These QA fixtures never change production
feeds. The [personal app](#personal-macos-app) configures its own signed release feed.

The pinned framework, nested helpers and license are bundled. Candidate audits check signatures,
architecture, minimum OS and read-only permissions. `python3 -B scripts/macos-updates-smoke.py` runs
ten actual SDK scenarios using private loopback feeds, signed App ZIPs and unique QA
identifiers/temp roots. It creates one-time CryptoKit keys, signs with the Node release helper,
verifies with the official signing toolkit after checking its pinned hash, and retains only public
keys/signatures. User choices are simulated; SDK downloading, verification, extraction, target
checks and scheduling remain real.

Cases include valid/bad signatures, wrong architecture/channel, old versions, cancel, actual retries
after offline/interrupted downloads, shared automatic opt-in/opt-out and build1→build2 installation.
The latter uses the same private app path, saves a real editor draft through ordinary quit guards,
retains host PID/generation, checks exact saved bytes and produces fresh PTY output. The server
records and rejects requests before opt-in. Bad-signature acceptance requires the pinned SDK's exact
bounded `SUValidationError` cause `EdDSA signature does not match.`; unrelated errors fail. Bridge
negative tests cover that boundary.

Relaunch capture uses the original CI coordinator's process tree and verifies exact source, bundle
identity, owner PID/window number and dimensions. Missing permission/image fails. Canvas caching
includes the actual terminal view identity, and both ordinary reconnect and update relaunch require
that view inside the visible window. The install fixture owns a real PostgreSQL cluster and invokes
the actual termination delegate during a long query and an uncommitted transaction. Refusal,
rollback, unchanged host/generation and database cleanup are required. Transfer worker states and
updater termination requests are labelled simulations; the native Keep window open button is real.

At source `ec1a49df9fe7eb0ed75a2f23efcb9883dd36fb21`, tested merge
`cfd088ed91d8038dcae8e686a67b1812e87d7181`, both complete jobs in
[run42272314439](https://github.com/YondFane/uTerm/actions/runs/42272314439) pass all ten SDK cases
on macOS15.8.2 ARM64 and15.7.9 Intel with Xcode16.4/Swift6.1.2/Rust1.99.1. The
[ARM artifact](https://github.com/YondFane/uTerm/actions/runs/42272314439/artifacts/13533506603) and
[Intel artifact](https://github.com/YondFane/uTerm/actions/runs/42272314439/artifacts/13533773218)
contain updates/sdk-summary.json, install/sdk-native.json, four protection-window images and
native-update-install-relaunched.png. Original ARM relaunch and Intel query-refusal images were
inspected; retained output and QUIT_REFUSED are visible. #45 is accepted on the task branch. Old
empty-placeholder captures remain failed restoration evidence; they are not reused as passes.

#### Windows signed updater QA

`python -B scripts/windows-updates-database.py` owns a real private PostgreSQL cluster and invokes
`node scripts/windows-updates-smoke.mjs`, which builds and installs private 0.2.4/0.2.5 NSIS
packages and serves a one-time signed update over literal loopback. Only a compile-gated QA app with
its validated temporary root and updates phase can enable this source. Endpoints reject remote/DNS
aliases, credentials and query strings; download URLs retain the same origin and owned package path.
Signed versions remain mandatory. An embedded QA-only root supports argument-free relaunch into the
same private profile. Production configuration and ordinary QA disabled behavior remain unchanged.

The suite covers the real startup opt-out interval, old versions, wrong architecture, bad
signatures, offline/retry, interrupted Range resume, editor/database draft guards, manual checking,
automatic download/confirmation, Cancel and durable opt-out. Installation uses the real updater,
then verifies a different app PID, retained host/generation, exact Core draft bytes and fresh PTY
input. Draft input and dirty guard flags are explicitly simulated. The real transfer registry uses a
labelled simulated worker; cancellation remains protected until completion. Real PostgreSQL queries
and uncommitted transactions reject installation, with original data retained after rollback and all
connections closed. Input leases are released before an installer can exit directly; host/PTYS
remain alive. QA closes its actual terminal and stops only its owned idle host. Cleanup failures
retain logs and reports. Only bounded read-only observations retry writer contention; writes retain
their existing conflicts and the explicit Retry saving settings control.

Windows uses the same source/merge above. All fourteen scenes, actual signed 0.2.4→0.2.5
installation, normal exit and uninstall pass in
[run42272314528](https://github.com/YondFane/uTerm/actions/runs/42272314528), with cleanupErrors=[]
on WindowsServer2025 x64/PostgreSQL17.11/Java21/Node24.22.2/pnpm11.22/Rust1.99.1.
[Artifact13531895866](https://github.com/YondFane/uTerm/actions/runs/42272314528/artifacts/13531895866)
contains sdk-summary.json, fourteen updates-*.json/png scenes, database cleanup, packages and public
signatures. Both package hashes were independently recomputed, and the original relaunch window was
inspected with fresh SDK_UPDATED output. Protection RPC/report checks prove database and transfer
refusal; an ordinary window capture is not a SQL-interface screenshot. Private keys stay outside
artifacts; updater signatures do not provide Authenticode.

Startup status is observed once so later automatic-preference changes cannot race an in-progress
download's lock. The focused regression fails the old implementation and passes the correction; the
source-bound Windows run above also passes the actual automatic flow. Default opt-out, explicit
retry, Cancel and installation guards remain intact. #45 is completed under the documented
simulation/manual-waiver scope; no production update feed or release is changed.

#### Windows/Tauri automatic installation

Settings → Software update → Automatic updates is off by default and persists across restarts. In
builds with online updates enabled, turning it on checks immediately and then hourly while running,
automatically downloads available updates, verifies their signature through the existing updater,
and prompts before installing and restarting.

- The confirmation dialog offers Install now and Cancel, with automatic installation after ten
  seconds without a response. Cancel or Escape stops the countdown and suppresses automatic
  installation of the same version for this run; manual installation remains available in Software
  update.

- Manual Install and restart uses the same confirmation. Closing settings does not dismiss the
  prompt.

- Disabling automatic updates cancels an automatic prompt. Turning it off stops future automatic
  steps; an already running download may finish.

- Unsaved files block installation through the existing editor guard. Failures are shown in Software
  update and stop automatic progression until a manual retry.

#### Validation and limits

- Hook tests cover opt-in behavior, automatic download, installation guards, restoration after
  failure, avoiding retry loops and manual retry; settings tests cover old-data defaults and
  validation. All 159 frontend/build-helper tests, formatting, localization, documentation checks
  and frontend/isolated macOS desktop builds pass.

- Native QA (`sh.uterm.desktop.qa.autoupdate`) verifies the switch layout and disabled state in a
  build without online updates. Actual signed download/install/restart and Windows runtime
  acceptance remain pending.

#### Update-confirmation checks

- Update confirmation validation: all 159 frontend/build-helper tests, formatting,
  documentation/localization checks, frontend production and isolated macOS desktop builds pass.
  Hook/component tests cover cancel-button focus, cancellation preventing timeout installation,
  ten-second installation, duplicate confirmation guards and unsaved-file protection.

- A browser preview of the real dialog component verifies the Chinese layout and Cancel button. The
  preview uses mock update callbacks; native signed-update confirmation, installation/restart and
  Windows runtime acceptance remain pending.

### Update progress and release notes

Settings → Software update checks for updates after startup. Progress, action buttons and error
messages appear before Release notes at the bottom.

Release notes render Markdown headings and lists with spacing and their own scrolling region, so
long notes do not push actions below them. HTML, images and interactive content are excluded.

Component regression checks verify headings/lists, excluded script elements and progress/install
controls preceding notes. All 159 frontend/build-helper tests and the frontend production build
pass; native signed-update notes and Windows runtime acceptance remain pending.

While an update downloads, and after its download has completed, its progress bar remains visible
with the downloaded size immediately beside it. A completed update additionally reports successful
signature verification before Install and restart is available.

The bilingual settings component regression test covers this completed-download layout;
signed-update runtime acceptance remains pending.

### Terminal clipboard shortcuts

In a focused Windows terminal, Ctrl+C copies selected terminal text; without a selection it remains
the terminal interrupt key. Ctrl+V and Ctrl+Shift+V paste clipboard text using the terminal's
bracketed-paste mode when enabled.

- Ctrl+Shift+C also copies selected text. macOS sends Cmd+C/Cmd+V through native copy/paste events
  to xterm, without requesting asynchronous browser clipboard access: pasting needs no extra WebKit
  “Paste” click and does not produce that API's `NotAllowedError` banner. Control keys remain
  available to terminal programs.

- When input would exceed the 1 MiB queue limit, that input is not sent and a notice asks you to
  paste in smaller parts. The notice disappears after three seconds; triggering it again restarts
  the timer. Connection, clipboard and font-setting errors are not cleared by this timer.

- Native paste retains bracketed-paste handling and disabled-input protection. Other clipboard and
  session failures remain visible; a pending asynchronous paste is discarded if its connection
  closes or changes.

#### Validation and limits

- Shortcut regression tests cover native macOS routing, selection states and Shift modifiers,
  alongside Windows copy/paste and Control passthrough; native acceptance is recorded below.

- Linux component regression uses real xterm with fixture session IPC to cover three-second expiry,
  repeated-notice timer resets, normal input, persistent write errors and unmount cleanup. Linux
  Chromium at 900×600 and 640×420 uses the actual terminal component and fixture IPC to verify
  notice display/expiry, repeated timing, subsequent input and retained errors, with visual
  inspection of terminal layout after dismissal. TypeScript, production build, localization and
  formatting checks for changed files pass. On merged source `24a1928`, the Linux suite passes 477
  frontend checks with 11 conditional skips. Shared Core/FFI checks pass 267 cases, host checks pass
  86 and backend checks pass 17; optional cases remain ignored. TypeScript/production, desktop
  compilation, contracts, localization, formatting and documentation checks pass. Native
  macOS/Windows long-paste acceptance remains pending.

### Input-method punctuation

Terminal and Agent sessions let the input method transform punctuation before forwarding committed
punctuation through the normal terminal input queue. After pasting text, use Left/Right to move the
terminal cursor and continue typing Chinese at that position without resending old text.

Before new typing or composition starts, the hidden input field's caret is aligned with the end of
its committed value, independently of the terminal cursor. Its value, active composition, paste,
navigation and Control/Alt/Meta shortcuts are preserved, and disabled input is respected.

#### Validation and limits

- Ten focused tests cover Chinese and ASCII punctuation, composition boundaries, cancellation,
  disabled input and listener cleanup, including real xterm composition and key-229 input after
  caret movement. The frontend/build-helper suite passes 283 tests with ten optional/platform checks
  skipped. Formatting, localization, TypeScript/production build and an isolated macOS desktop build
  pass.

- Native macOS QA (`sh.uterm.desktop.qa.imeediting`) uses the real Terminal view with a mock input
  receiver. Injected composition verifies Chinese insertion after paste and Left; native paste,
  Left/Right and trusted input-method commits, including Chinese text, send only the new committed
  text at the requested position. Acceptance in the user's live Agent session and Windows/Linux
  runtime acceptance remain pending. The installed application was not replaced or restarted.

### Update download retries and caches

Update downloads make at most three attempts for transient connection/server failures, preserve
partial bytes across restarts, and reuse complete disk caches only after checking the current public
key, Minisign signature and signed-version policy. Unsupported or inconsistent Range responses
restart the download.

- Verification runs off the UI thread before the existing installer, confirmation and
  session/editor/database/Redis/SFTP guards. Network, timeout, certificate, missing-file,
  access-denied, rate-limit, server, metadata/response and cache-storage errors have separate
  bilingual guidance.

- Software update always offers Download installer manually, including builds without online
  updates. Cache cleanup runs on use, retaining the selected file and at most three other files
  within a 512 MiB budget and removing inactive files older than seven days; each update is limited
  to 512 MiB.

- Downloads still require access to their configured source.

### Agent package download failures

Agent installation continues through npm with its existing cache and user registry/proxy
configuration. Package fetches allow two retries, 2–10 second retry delays and a 120 second request
timeout, within the existing ten minute installation limit.

- Permission and Node.js-version failures are distinguished from network failures; raw installation
  output remains available. The installation command and lifecycle scripts are never automatically
  rerun.

- Official installation instructions remain available.

### Windows installer launch

Windows launches a temporary `.exe` copy after validating a cached installer, preserving the normal
installation wizard and elevation behavior. The cached `.part` remains reusable; the launch copy is
removed when the script exits.

This requires temporary disk space for one additional installer payload.

#### Download checks on Windows

- Download validation on Windows: 82 backend checks pass, including bounded retries, resumed
  prefixes, complete-cache reuse, ignored/malformed ranges, permanent HTTP failures, long
  Retry-After, storage/cancellation/certificate classification and signed content/key/version
  rejection. The PowerShell integration check uses real loopback HTTP and a disposable native
  Windows executable in place of an installer to cover 503, interrupted responses, resume,
  verified-cache reuse, actual process launch, modified-content rejection and 404 without
  installation retries.

- Frozen dependency installation, the complete frontend suite (228 passed), 31 affected-module
  checks, 15 UI/localization regressions, seven Windows installer/release-helper checks and 24 host
  checks pass; ten optional/platform frontend checks are skipped. Changed-file formatting,
  localization, documentation and TypeScript/production checks pass.

- Native isolated Windows QA (`sh.uterm.desktop.qa.downloads`) inspects the actual
  settings/components views in English/dark at 900×650 and Chinese/light at 640×600, and confirms
  the manual-release target with mocked external navigation. No real packages are installed.

- The isolated desktop build uses `sh.uterm.desktop.qa.downloadcheck`; the installed app is not
  restarted. The production build retains its large-chunk warning.

- Real signed application installation/restart, Agent package installation and macOS
  installer/runtime acceptance remain unverified.

## Interface

### Shared close icons

In-app close icons share a small circular ×: gray by default and muted red on hover. This applies to
dialog headers, file/diff tabs, session controls, terminal search, SQL query tabs and Redis
drawer/field-editor controls.

Sidebar session rows show only the × at rest, revealing its circle on hover or keyboard focus.
Existing actions, accessible names, disabled states and keyboard focus are retained, including the
Redis drawer close control's responsive visibility.

Settings and the Agent dialog initially focus their titles, so opening them does not draw an extra
outline around the close icon. Tab moves to the close button and shows its keyboard focus outline;
Enter activates it, and Escape dismisses the dialog when closing is allowed.

#### Close-icon checks

- Close-icon validation on macOS: 274 frontend/build-helper tests pass, with ten optional/platform
  checks skipped. Repository formatting, localization, TypeScript checks, production frontend and
  isolated desktop builds pass. The build retains its large-chunk warning; tests report an occupied
  Vite WebSocket port without failures.

- Native QA (`sh.uterm.desktop.qa.dialogfocus`) verifies Settings and Agent titles receive initial
  focus without an outline around the title or close icon. Tab reveals the close button's focus
  outline; Settings closes with Enter, and Agent closes with Escape or a mouse click. Native
  Redis/database close controls and Windows/Linux runtime acceptance remain unverified.

### macOS window controls

On macOS, the close, minimize and zoom/full-screen controls use the original system window buttons
in a 44 px title bar, aligned with the workspace name and toolbar buttons. The native button group
is inset from the left edge; macOS manages its hit areas, colors, hover symbols, accessibility and
the green button’s window arrangement and full-screen menu.

Closing hides the window while keeping sessions; the buttons remain usable above application
dialogs.

The title bar shares the sidebar background, including when the sidebar list is collapsed. In the
Icon navigation sidebar, the rail background and divider start below the 44 px title bar, with an 8
px gap before the first navigation button. The window buttons keep a continuous background and clear
separation from navigation controls in both light and dark themes.

The sidebar title bar has a 1 px bottom divider aligned with the main toolbar, separating the window
controls and workspace name from the navigation and project lists. Collapsed and narrow sidebars
reserve space for the native buttons in the adjacent toolbar, including a left-side tool panel.

#### macOS window-button checks

- On macOS, 284 frontend/build-helper tests pass, including the ten focused sidebar layout,
  visibility, navigation, pane-swap and native-menu regressions; ten optional checks are skipped.
  Repository formatting and TypeScript/production frontend builds pass. The production build retains
  its existing large-chunk warning; tests report an occupied Vite WebSocket port without failures.

- Native QA uses an isolated application (`sh.uterm.desktop.qa.nativetitlebar`) with its own data.
  Desktop compilation, the native close/minimize/full-screen accessibility roles, Black/Paper
  title-bar backgrounds, navigation-list collapse/reopen and full-screen entry/exit are verified. A
  left-side tool panel still requires native acceptance.

- The macOS screen-capture badge obscures the button area during capture. Button hover symbols and
  the green button’s arrangement menu have not been directly visually accepted. Windows/Linux
  runtime checks were not run for this macOS-only layout change.

### macOS menu bar

The macOS menu bar provides the same commands as the application controls and command palette.

- **uTerm** opens Settings, Agent configuration and About, with the standard Services, Hide and Quit
  actions. **File** adds projects, opens terminals or chats, quickly opens files and closes the
  current session, file or workbench. Close Window hides the window and keeps sessions running.

- **Edit** provides native undo, redo, cut, copy, paste and select-all actions for the focused
  control. **View** opens the command palette, toggles the sidebar and inspector tools, swaps panes
  and searches the project.

- **Session** switches to the previous or next session, or selects one by workspace and project, SSH
  connection or standalone session type. It also provides splitting, pane focus, zoom, Ungroup,
  terminal search and Copy session link.

- **Workspace** creates or selects a workspace. Current sessions, workspaces and visible panels are
  checked. **Window** provides native minimize, zoom, full-screen and bring-to-front actions.
  **Help** opens the feature guide, website and issue form.

Menu labels follow Settings → General → App language immediately. Help links select the matching
guide and website language; user-entered names keep their original text. macOS manages the language
of system-provided Services entries and other system additions.

Command shortcuts follow Settings → Keyboard shortcuts, including custom and disabled bindings.
Unavailable actions are disabled; dialogs and pending file operations block session and workspace
changes. File switching and Quit retain the existing draft, conflict and exit safeguards.

#### Menu-bar checks on macOS

- On macOS, 258 frontend/build-helper tests pass with 10 optional/platform checks skipped, and 108
  backend tests pass with 9 ignored. Repository formatting, localization/documentation checks,
  TypeScript/production build and an isolated desktop build pass. The production build retains its
  large-chunk warning.

- Automated checks cover bilingual labels, stable session/workspace targets, SSH and Worktree
  grouping, panel checks, custom and disabled shortcuts, dialog guards, stale menu replacement and
  visible native-menu failures. Native menus are installed only on macOS.

- An isolated Tauri app (`sh.uterm.desktop.qa.macosmenu`) uses the real App and native menu APIs
  with temporary workspaces and simulated sessions. Native inspection verifies menu clicks, sidebar
  switching with Cmd+B, Settings with Cmd+Comma, cross-workspace session selection, workspace
  selection, a custom Cmd+Option+L binding and immediate Chinese/English switching. Session actions
  are disabled while Settings is open. Names containing an ampersand remain intact.

- Real process/SSH switching, dirty-file exit interaction and system-managed menu additions remain
  unverified. Native popup screenshots are unavailable in the current capture tool; menu labels and
  resulting application states are verified through native accessibility.

### Inspector tools and panel toggles

The inspector's Files, Git, GitHub and Working directory controls use the same transparent
background as the adjacent toolbar. Each has a 30 px circular click target, a 16 px outline icon and
4 px spacing; Working directory uses a folder icon. Hover and keyboard focus add a subtle
theme-colored background, while the selected tool keeps its own subdued background and highlight
color, including on hover.

Other icons retain their normal colors. Connection visibility switches and the selected sidebar
navigation icon use the same highlight color.

Settings → Appearance → Icon highlight defaults to Follow theme, using the current interface theme's
accent color as the theme or color mode changes. Older saved settings also use this default.

- Choose Custom color to use the color picker or enter a six-digit hexadecimal color such as
  `#62d98a`. Press Enter or leave the text field to apply it. Changes save automatically and persist
  after restart; a custom color stays the same across themes and dark/light modes.

- Choose Follow theme to restore automatic colors. Restore interface and terminal defaults also
  restores this mode. Invalid colors or failed saves show an error and retain the saved highlight.

- The sidebar hide/reopen and inspector show/hide buttons show only their icons at rest, adding a
  circular background and border on hover or keyboard focus. The sidebar hide icon aligns with the
  section actions below it; the right-side inspector toggle has an 8 px inset from the toolbar edge.

- Both retain a 36 px click target. These controls follow the selected interface palette in both
  dark and light modes and retain visible keyboard focus.

#### Inspector button checks on Windows

- Source formatting, TypeScript/production build and 30 theme, settings, sidebar-layout and
  localization checks pass. Native inspection in the isolated Windows application
  (`sh.uterm.desktop.qa.python`) verifies the transparent group background, consistent outline
  icons, the Working directory folder icon and the subdued selected state in dark mode.
- Native light-mode, keyboard-focus and macOS/Linux acceptance of this button styling remain
  pending. The production build retains the existing large-chunk warning.

#### Panel-toggle alignment checks

- Panel-toggle alignment validation: source formatting, TypeScript/production build and an isolated
  macOS desktop build pass. Native QA (`sh.uterm.desktop.qa.togglealignment`) verifies sidebar icon
  alignment, the tighter right inset with the inspector hidden and visible, and sidebar/inspector
  collapse and reopen.

- Windows/Linux runtime acceptance remains pending.

#### Highlight-color checks on Windows

- The complete frontend/build-helper suite passes on Windows (252 passed, 11 optional/platform
  checks skipped), together with changed-file formatting, localization, documentation checks and
  TypeScript/production build. Tests cover old settings, all six palettes in both color modes,
  custom-color persistence and provider reload, invalid colors, save failures and restoring
  defaults. The existing Vite WebSocket-port and production large-chunk warnings remain.

- An isolated Tauri/WebView2 host (`sh.uterm.desktop.qa.activeicons`) runs the real App with
  temporary settings and mocked desktop commands. Visual inspection verifies the appearance
  controls, default theme highlighting and applying a custom color to visible connection switches
  and the selected tool. The custom color survives an app restart, dark/light mode and a theme
  change; choosing Follow theme restores the selected palette's accent. No real server connections
  are used; macOS/Linux runtime acceptance of these controls remains pending.

### Sidebar action buttons

Sidebar section actions show only their icons at rest, revealing compact circular borders and
backgrounds on hover or keyboard focus without changing button size. Project/Worktree quick actions,
footer connection switches and Command/Settings/Agent controls use capsule groups with circular
buttons; project actions still appear on row hover or keyboard focus, and the footer wraps when
narrow.

The Settings close button uses the shared circular close icon, retaining its accessible name and
installation-time disabled state.

### Footer Add button

The footer's Add project or session button uses a bold plus with no circular frame or background,
including on hover. Its 34 px click target, action menu, tooltip and visible keyboard focus are
retained.

#### Footer Add checks

- Footer Add validation: the sidebar connection regression test, formatting, documentation checks,
  TypeScript/production build and an isolated macOS desktop build pass. Native QA
  (`sh.uterm.desktop.qa.footerplus`) verifies the unframed bold plus in dark mode, opening the Add
  menu and dismissing it with Escape.

- Light-mode and Windows/Linux runtime acceptance remain pending.

#### Hover-frame checks

- Hover-frame validation: 16 focused sidebar and bilingual UI tests, formatting, documentation
  checks, TypeScript/production build and an isolated macOS desktop build pass. Native preview
  (`sh.uterm.desktop.qa.hovercontrols`) confirms icon-only default controls and their alignment
  while resizing the sidebar.

- Pointer/focus transition acceptance and Windows/Linux runtime acceptance remain pending.

### File-list controls

The file list's New file, New folder and Refresh controls use compact 24 px circular buttons with 14
px icons and 4 px gaps. They have no persistent border/background; hover and keyboard focus remain
visible, and action tooltips and accessible names are retained.

#### Compact file-control checks

- Compact file controls validation: 15 focused file-refresh and bilingual UI tests, formatting,
  documentation checks, TypeScript/production build and an isolated macOS desktop build pass. Native
  QA (`sh.uterm.desktop.qa.compactfiles`) verifies the smaller controls in the dark file list,
  refresh interaction, hover and the visible keyboard focus ring.

- Windows/Linux runtime acceptance remains pending.

#### Rounded-control checks

- Rounded controls validation: 209 frontend/build-helper tests pass, with eight optional
  Java/database checks skipped. Formatting, localization, documentation checks,
  TypeScript/production build and an isolated macOS desktop build pass.

- Native QA (`sh.uterm.desktop.qa.roundtoolbar`) verifies the toolbar, sidebar section buttons,
  project quick-action capsule, footer groups and Settings close button in dark/light modes at the
  default 248 px sidebar width, plus the dark layout and footer wrapping at 176 px. It also verifies
  Files/Git/Working directory selection, keyboard activation and visible circular focus,
  hiding/reopening both panels, connection-switch states and closing Settings with Enter.

- Windows/Linux runtime acceptance remains pending.

### Inspector visibility in workbenches

Opening Database components from the sidebar temporarily hides the inspector together with its
layout column. Files, Git, GitHub and Working directory controls stay out of the sidebar footer;
returning to the project restores the selected tool and its left/right position.

Database and Redis workbenches also hide project inspectors.

#### Inspector visibility checks

- Inspector visibility validation: 192 frontend/build-helper tests pass, with eight optional
  Java/database or macOS-only checks skipped. Component coverage exercises all four local tools on
  both sides, absence of inspector requests while components are open, tool restoration and retained
  local sessions.

- An isolated Windows app (`sh.uterm.desktop.qa.dbtoolbar`) verifies opening components from Git at
  the default 248 px sidebar width, the footer remaining at the bottom without a stray Git
  toolbar/error area, and Git restoration on returning to the project. Narrow-sidebar and left-side
  native interaction, and macOS runtime acceptance of this layout remain pending.

- Locked dependency installation, localization/documentation checks, changed
  source/test/feature-guide formatting, both Cargo formatting checks, TypeScript/production build
  and the isolated Windows desktop build pass. The production build retains its large-chunk warning.

### Application context menus

Right-clicking the application page suppresses the browser's default menu, including Print, Save as
and More tools. Project, Worktree, session, file-tree and branch menus remain available.

Windows also disables WebView2's default menus for embedded frames, including isolated HTML
previews, without relaxing their sandbox.

#### Validation and limits

- Windows validation: 158 frontend/build-helper tests pass, with two platform-specific tests
  skipped; 40 backend tests, 16 local-service tests, locked dependency installation,
  TypeScript/production build, localization and documentation checks pass. Event tests cover blank
  space, inputs, dialogs and application handlers that stop propagation.

- Native Windows menu acceptance and macOS interaction (including isolated previews) remain
  unverified. The production build's large-chunk warning remains.

### Swapping the workspace and inspector

The Swap left and right panes button is centered vertically on the divider between the main
workspace and inspector. It stays hidden until the pointer hovers over the divider or the button;
moving away hides it again.

- Keyboard focus also reveals it. Clicking it exchanges the main workspace (terminal/editor,
  including its toolbar) and the inspector (Files, Git, GitHub or Working directory).

- The project sidebar stays in place. Widths follow their content, and the position is saved
  globally across projects and application restarts; resetting interface settings restores the
  inspector to the right.

- The button supports keyboard activation, and the command palette and shortcut settings expose the
  same action without a default binding. Swapping retains mounted terminal/editor instances, output,
  drafts, file-tree expansion and scroll state.

- It does not request a file save or close; existing editor autosave still applies. The inspector
  show/hide button follows the inspector side while remaining in the main title bar: it sits at the
  title bar’s left edge beside a left-side inspector and at the right edge for a right-side
  inspector.

- It never joins the inspector’s Files/Git action bar, and the left-side restore button keeps the
  same title-bar position while the inspector is hidden. The control is unavailable while the
  inspector is hidden or empty, Git diff is displayed in the central content area, a divider is
  being dragged or an editor transition is pending.

- Restoring the inspector or leaving expanded diff restores the chosen position. Settings-save
  failures remain visible and leave the layout unchanged.

- Separator dragging and Left/Right keys follow the displayed side; double-click or Enter restores
  the default width, and releasing at 30 px or less collapses the inspector toward its side of the
  working area. Inspector width remains a preference for the current run only.

### Drag-to-collapse and reopen hints

The sidebar and inspector dividers use the same thin, theme-colored highlight on hover or keyboard
focus, including when the inspector is on the left. Drag either divider to resize its panel.

The project sidebar and inspector highlight at a requested width of 30 px or less and collapse only
on pointer release. The inspector can occupy either side of the main workspace.

- Dragging back above the threshold while holding cancels the snap. The inspector checks this
  threshold before applying its minimum width, remembers the current panel and reopens through its
  button or shortcut.

- Release restores the pre-drag width for reopening; pointer cancellation clears the highlight
  without hiding. Window resizing alone does not trigger collapse.

- Both panel toggles use 18 px icons in 36 px circular buttons. After a drag is released at the
  collapse threshold, the corresponding reopen icon blinks for three seconds; reopening stops the
  hint immediately.

- Manual hiding, cancelled drags and dragging back outside the threshold do not trigger it. Each
  panel has its own hint timer; reduced-motion mode uses a steady three-second highlight.

#### Validation and limits

- Nine focused sidebar/inspector layout and pane-swap tests pass, together with repository
  formatting, documentation checks, TypeScript/production build and an isolated macOS desktop build.
  The production build retains its existing large-chunk warning.

- Native macOS QA (`sh.uterm.desktop.qa.panelhover`) verifies matching dark-theme divider
  highlights, inspector resizing on both sides, pane swapping, drag collapse and reopen hints with
  the previous width restored. Windows/Linux runtime acceptance of these divider styles remains
  pending.

### Panel keyboard shortcuts

Toggle left sidebar uses Ctrl+B on Windows and Cmd+B on macOS; toggle inspector uses Ctrl+Alt+B or
Cmd+Option+B. Both appear in Settings → Keyboard shortcuts and the command palette, and can be
rebound or disabled.

The inspector shortcut restores the last panel (falling back to Files when its project is
unavailable) and requires a working directory. Dialogs and pending editor transitions suppress these
shortcuts.

#### Validation and limits

- Automated tests cover defaults, conflicts and custom bindings; native terminal shortcut acceptance
  remains pending.

### Sidebar styles

The application uses an icon navigation sidebar with a vertical rail beside the content list.
Settings → Appearance starts with Interface theme; no sidebar-style picker is needed. Existing
settings and restored defaults use the same navigation layout.

- The rail offers All, Projects and sessions, SSH connections, Redis connections and Database
  connections. Connection categories, lists, Add actions and welcome actions stay available
  regardless of saved connection-visibility preferences.
- Selecting a category filters only the sidebar list, preserving the current project, session,
  workbench and connections. The current category is retained during this app run and starts at All
  after restart.
- Hide sidebar, the sidebar shortcut and drag collapse hide only the content list. The 48 px rail
  stays visible with its category and footer buttons. Click a category or Show sidebar to restore
  the list at its previous width, or drag the rail's right edge to expand it.
- Add, Commands, Settings and Agent share the button group at the bottom of the rail. The Add menu
  starts with New terminal, followed by Add project and enabled Agent chats, then SSH, Redis and
  database connection actions. Selected navigation icons use the configured Icon highlight color.
  Narrow sidebars use compact controls.

#### Sidebar checks and limits

- On macOS, the frontend/build-helper suite passes with 292 tests and 10 optional/platform checks
  skipped. Coverage includes legacy layout normalization, settings reload/reset, all connection
  categories, bilingual menus/dialogs, retained session data and rail collapse/resize/restore.
  Repository formatting, localization, documentation, TypeScript/production frontend build and
  isolated desktop compilation pass.
- Native inspection uses `sh.uterm.desktop.qa.sidebarremoval` with temporary legacy settings and
  mocked desktop commands. Chinese/dark Appearance starts at Interface theme with no style picker.
  Paper appearance preserves the 48 px rail when collapsed, the complete Add menu with Escape
  dismissal, and category selection restores the 248 px list. Connection categories and welcome
  actions remain available with all saved visibility switches off.
- No real sessions or server connections are used. Windows/Linux runtime acceptance and native
  restart persistence remain pending. Existing Vite WebSocket-port and production large-chunk
  warnings remain.

### Workspace header and sidebar width

At normal widths, the sidebar header places the workspace name and hide button on one row,
vertically centered with the main toolbar and to the right of the window controls on macOS. There is
no separate uTerm/Local brand row. The sidebar header, main toolbar and tool-panel header use a
compact 44 px height, with their controls vertically centered.

- The workspace name appears as text without a field border or dropdown arrow. Clicking it opens a
  compact 180 px menu below the header, with smaller item padding; keyboard activation and menu
  navigation remain available.

- Long names are truncated in the header with their full name in a tooltip and wrap inside the menu.
  Drag its right edge to resize, with a minimum of 48 px. The maximum is the smaller of 320 px or
  30% of the window (with a 180 px floor).

- Dragging to 78 px or less highlights the collapse threshold. Releasing keeps the navigation rail
  while hiding its list. The toolbar button reopens the list. Width is retained for the current app
  run.

- The separator also supports arrow keys, Home to hide, End for maximum width and Enter/double-click
  to reset.

- Narrow sidebars keep section headings on one line. Hovering or focusing a project/Worktree row
  floats its terminal/Agent capsule to the right when inline space is insufficient, retaining the
  original target and missing-folder restrictions. Escape, outside clicks, scrolling or resizing
  dismiss the floating capsule. The More actions menu remains a fallback when floating controls are
  unavailable.

- Very narrow sidebars stack header controls and use resource/session icons with full names in
  tooltips and accessible labels. Section actions wrap, and footer buttons wrap within their groups
  instead of being clipped. The footer scrolls when needed to leave room for the project list. SSH
  host search and its quick-connect button return when the sidebar is widened.

- Add and workspace menus open outside the sidebar with their normal readable widths, bounded by the
  window. Near the collapse threshold, content is hidden to avoid crushed controls. Widening
  restores the complete layout while preserving selection, sessions and connection settings.

#### Validation and limits

- Compact-header validation on macOS: 11 focused sidebar, inspector and pane-swap checks, repository
  formatting, TypeScript/production frontend build and an isolated desktop build pass. The
  production build retains its large-chunk warning; tests report an occupied Vite WebSocket port
  without failures.

- Native QA (`sh.uterm.desktop.qa.compacttitlebar`) uses the real App with temporary workspace data
  and simulated desktop responses to verify aligned headers in Black/Paper themes, the workspace
  menu, File/Git switching and sidebar-list collapse. The screen-capture badge obscures the native
  window buttons; their placement still needs direct visual acceptance. Windows/Linux runtime
  acceptance of the compact headers remains pending.

- On macOS, nine focused sidebar tests, TypeScript/production build, repository formatting and
  localization checks pass. Regression coverage includes floating placement, unchanged Agent targets
  and folding, resize dismissal and retained keyboard focus in wide rows.

- The isolated native app (`sh.uterm.desktop.qa.sidebaractions`) renders the real Sidebar with
  temporary state. Visual checks cover 176 px and 112 px navigation sidebars, Chinese/dark and
  English/light layouts, long names, project/Worktree Agent callbacks and Escape dismissal.

  Keyboard focus restoration is also covered by automated checks. No real sessions or servers are
  used; Windows/Linux acceptance of floating controls remains unverified. The production build
  retains its large-chunk warning.

- On Windows, 23 focused sidebar, welcome and bilingual UI checks pass, together with changed-file
  formatting, localization/documentation checks and TypeScript/production build. Coverage includes
  project/Worktree quick-menu targets, enabled Agents, missing folders, Escape focus return,
  connection guards, visibility settings and collapse boundaries.

- An isolated Tauri/WebView2 app (`sh.uterm.desktop.qa.activeicons`) runs the real App with long
  names, temporary profiles and mocked desktop commands. Native pointer drags verify the compact 176
  px layout and the 88 px icon layout, single-line Chinese headings and fully visible footer
  controls. No real processes or servers are used. Native acceptance of the final popup placement,
  narrow light/English layouts on Windows and Linux interaction remains pending.

### Terminal resizing

Drag the project sidebar, inspector or session divider to adjust the central terminal area. The
terminal keeps its current character grid while the layout changes and fits after the size has
remained stable for 120 ms. Existing output is consumed before fitting. During a drag, the viewport
may clip the old grid or temporarily leave extra space until fitting finishes.

Sidebar and inspector drags follow the latest pointer position once per display frame and commit the
final width on release. Task output and activity indicators continue updating during the drag.
Collapse highlights, keyboard resizing and either inspector position retain the same controls.
Cancelling a drag clears the highlight without hiding the panel; a navigation sidebar returns to its
previous width and collapsed state.

The host processes one resize at a time and retains only the latest pending size. Replaying a
session keeps its saved dimensions until replay completes; closing or reconnecting drops pending
resizes for the old attachment. Resize errors remain visible in the session.

#### Panel-drag checks on macOS

The App regression freezes periodic timers before mounting so background refreshes cannot count as
pointer-driven renders. Explicit task-activity updates and timed collapse hints remain checked. The
focused regression passes on Linux; the corrected timing boundary still needs its own macOS CI.

- App regressions cover frame coalescing without session rerenders on pointer movement, task-state
  updates during a drag, the final release position, cancellation, unmount cleanup, collapse hints,
  navigation-rail reopening and either inspector position. A 60-move regression produces 60 extra
  session renders with the previous implementation and none during pointer movement with the current
  implementation; pointer-down, release and task-state changes still render normally.

- The frontend/build-helper suite passes (274 passed, ten optional/platform checks skipped), along
  with repository formatting, localization, TypeScript/production build, documentation checks,
  locked dependency installation, host/backend suites and desktop compilation. The isolated desktop
  build also passes. Vite's existing WebSocket-port and large-chunk warnings remain.

- The isolated native app (`sh.uterm.desktop.qa.paneldrag`) runs the real App and xterm views with
  45 fixture projects and six simulated terminal-output streams, redrawing 28 rows every 32 ms.
  Native pointer checks at 1200×760 cover sidebar resizing, inspectors on either side, collapse and
  reopening, navigation-rail expansion, Chinese/dark and English/light appearance, and aligned
  output after fitting. This verifies WebView interaction with simulated output, not live Agent
  tasks or SSH services. The updated drag preview still needs Windows and Linux runtime acceptance.

#### Resize checks on Windows

- All 51 focused terminal, sidebar/inspector layout and workspace tests pass, including seven resize
  regressions for continuous dragging, output consumption, replay, hidden/disposed terminals, slow
  hosts, failures and attachment cleanup. Changed-file formatting, localization and
  TypeScript/production build pass, together with an isolated desktop build.

- An isolated Windows Tauri/WebView2 app (`sh.uterm.desktop.qa.terminalresize`) runs real local
  sessions. Repeated project-sidebar and inspector drags with OpenCode 1.18.32 show aligned content
  during and after resizing, without model requests. A continuously redrawing Node terminal fixture
  verifies split-divider resizing and consecutive row markers in both panes, including a narrow
  eight-column pane. OpenCode emitted a Bun 1.3.14 segmentation-fault report during narrow split
  testing; acceptance of that OpenCode scenario remains incomplete.

- The complete frontend/build-helper suite passes (273 passed, 11 optional/platform checks skipped),
  including the pane-swap App regression. Vite's WebSocket-port and large-chunk warnings remain.
  Linux runtime acceptance remains pending; macOS panel-drag checks are described above.

### Error-banner timing

Central error banners hide after 1.5 seconds without clearing the underlying error state. A
different message starts a new timer; unchanged background errors do not keep reopening the banner.

Workspace-load retry remains available after the banner hides. Native timing acceptance remains
pending.

### Clicking outside dialogs

Settings, the command palette and the Agent dialog close when a primary pointer click starts and
ends outside their bounds. Internal clicks and drags starting inside do not dismiss them.

Settings cannot be dismissed during update installation.

#### Validation and limits

- Boundary tests cover inside/outside coordinates; native pointer interaction remains unverified.

### Language switching

Settings → General switches Simplified Chinese and English immediately, including open panels,
menus, command search, validation messages, accessible labels and editor search controls. Switching
language does not recreate terminal sessions or replace editor documents.

Application-owned backend diagnostics are localized at display time; unknown OS/provider output,
terminal content, filenames and user-entered names remain unchanged. Native operating-system dialog
controls follow the OS language; the project chooser title follows the app language.

### Translation diagnostics and checks

Missing message keys produce an explicit diagnostic marker and a deduplicated console error instead
of silently returning Chinese. `pnpm i18n:check` rejects unregistered Chinese source literals,
untranslated JSX text/accessibility attributes and invalid literal-key parameters.

Tests verify all registered translations and placeholder parity, negative checker fixtures, live
language subscriptions, all nine settings tabs and major panel rendering in both languages. Source
analysis and mocked component tests are regression gates, not proof of every dynamic or native
runtime state.

### Interface themes

Settings → Appearance → Interface theme offers Black (black and silver, the default), Sandstone
(warm charcoal and sand), Ocean (navy and ice blue), Moss (forest green and mint), Paper (warm white
and terracotta), and Clear Sky (cool white and sky blue), with preview cards. Paper and Clear Sky
always use light interface colors without changing terminal color-mode preferences.

- The other four support dark, light and system color modes. Selection applies immediately and saves
  automatically without changing terminal color selections or recreating sessions.

- Missing interface-theme settings default to Black; invalid values are rejected.

Workspace and section names, project entries, branch selectors, panel tabs and settings labels use
semibold text. Shared buttons and form controls also use heavier text, and navigation and toolbar
icons use thicker outlines. Secondary text has stronger contrast in both dark and light themes;
selected icons retain the configured Icon highlight color.

### Welcome page and connection actions

The interface uses warm charcoal surfaces, a restrained sand accent, fine dividers and compact
controls, with a matching light palette. Sidebar selection, terminal pane focus and inspector tabs
use consistent states.

- A welcome page offers project, terminal and chat actions with configured shortcut hints;
  unavailable actions are disabled. Below these actions, compact Add SSH connection, Add Redis
  connection and Add database connection buttons match the sidebar and its + menu: all three remain
  available.

- Each button opens the existing connection dialog and remains disabled until the runtime and
  workspace are ready. Folding a section or hiding the content list keeps these actions available.

- The buttons reflow with the available width; short windows scroll without losing access to the
  heading or footer. Empty inspectors do not reserve screen space.

- UI colors and terminal ANSI colors are independent, and reduced-motion preferences are respected.
  See [DESIGN.md](../DESIGN.md) for tokens and design references.

#### Welcome-action checks

Automated checks cover startup-disabled controls, all eight legacy visibility-setting combinations,
existing welcome actions, bilingual labels, and opening/cancelling each connection dialog without
changing profiles. Current native evidence and platform limits are recorded under
[Sidebar styles](#sidebar-styles).

## Architecture

### Binary terminal output

Terminal output crosses the desktop-to-WebView boundary as binary frames with a small JSON metadata
header. The renderer passes a byte view of the received buffer to xterm without constructing a JSON
number array or copying the output again; consumption acknowledgements retain only metadata.

The desktop releases the source frame before waiting for acknowledgement. Session IDs, replay
dimensions/order, output backpressure, scrollback settings and the local host protocol are
preserved.

Malformed frames show a connection error and detach the affected view. Tauri may internally encode
small binary messages as JavaScript byte arrays; large frames use its binary IPC response path.

#### Binary-output checks

- Validation: 156 frontend/build-helper tests and 40 backend tests, formatting, localization,
  TypeScript/production build and an isolated macOS desktop build pass. Local-service tests pass on
  a full rerun; the initial run encountered intermittent host startup lock contention.

- Tests cover every byte value, empty output, metadata preservation, shared-buffer decoding and
  malformed headers. A 1 MiB sample cycling through all byte values occupies 3,743,840 bytes as the
  previous JSON frame and 1,048,667 bytes as a binary frame (about 72% less transport data); this is
  not a total application memory measurement.

- Native QA (`sh.uterm.desktop.qa.memory`) verifies 10,000 output lines through the completion
  marker, detach/relaunch replay, green ANSI text with Chinese/Unicode characters, exit code 7 and
  Close Session. Long-running memory reduction, real Agent traffic and Windows/Linux runtime
  acceptance remain unmeasured.

### On-demand editor and PDF resources

The file editor and its Markdown/syntax dependencies load on demand, with loading and failure
states. Unchanged Git branch polls preserve React state identity.

- PDF thumbnails render near the viewport and release offscreen canvas buffers. The development
  server streams local PDF resources instead of retaining all resource bytes in memory; production
  retains the complete PDF resources for offline compatibility.

- Key resource-lifetime decisions have English/Chinese comments.

### Workspace and session lookups

Session lists resolve project and Worktree directories in one pass. Explicit session directories,
including an empty directory, retain their precedence. Project, SSH, terminal and chat order and
session identities remain unchanged. Selection checks the selected project first and falls back to
the other rosters when that selection is stale.

The sidebar indexes project and roster IDs instead of scanning the lists for each row. Project
ordering is reused until the project collection, active workspace or ordering preference changes;
connection rosters are read on each render. Terminal views reuse session entries and split geometry
across activity updates, while session edits, workspace switches and split changes refresh the
affected data. Each view retains its current derived data without accumulating a cache of past
workspaces.

#### Workspace lookup checks

- On macOS, six focused regressions cover linear lookup work, directory precedence and identity,
  stale selection fallback, roster ID collisions, ordering reuse, source updates, split previews,
  zoom and mounted-session retention. The full frontend/build-helper suite passes 293 tests with ten
  skips. Frozen installation, repository formatting, localization, TypeScript/production build and
  an isolated desktop build pass; the existing large-chunk warning remains.

- A synthetic macOS ARM64/Node 26.3.0 benchmark compares the stable baseline with the current
  implementation in five independent processes. Each operation uses five warmups and five
  alternating before/after batches; each list batch runs five iterations. Median per-call list
  calculation times are:

  | Projects | Worktrees per project | Sessions per project | Baseline  | Current  |
  | -------- | --------------------- | -------------------- | --------- | -------- |
  | 100      | 8                     | 24                   | 0.398 ms  | 0.061 ms |
  | 300      | 16                    | 32                   | 3.213 ms  | 0.282 ms |
  | 1,000    | 32                    | 64                   | 86.907 ms | 1.615 ms |

  In the largest fixture, selecting the last session's roster takes 0.008 ms versus 0.217 ms with
  the baseline, using 100 iterations per batch. These are data-derivation measurements; they do not
  measure terminal rendering, total application CPU/RSS or network performance.

- The isolated native macOS app (`sh.uterm.desktop.qa.workspaceperformance`) verifies real PTY
  startup in the project directory, keyboard and pointer split resizing, zoom/restore, session
  switching, retained background output through a Chinese completion marker and Close Session.
  Windows/Linux runtime behavior and long-running whole-app resource gains remain unmeasured.

### Git refresh, file search and replay

The Git panel issues one snapshot read when window focus or visibility returns. Selected
working/staged diffs refresh after that read succeeds, including when Git status is unchanged but
file contents have changed.

- Hidden-window polls skip reads; failures remain visible and keep the current diff available.
  Directory listings cache sort keys while retaining directories-first, case-insensitive name
  ordering and the original-name tie-breaker.

- Case-sensitive file search borrows paths and lines; LF-only content skips newline-copying, while
  CRLF/CR normalization, Unicode matching, line numbers, ignore rules and search limits remain
  intact. Terminal delta replay reserves one output buffer and copies whole retained chunks in
  order, preserving reset decisions, sequence numbers, empty output and exit metadata.

#### Refresh, search and replay checks

- Windows validation of these paths: 162 frontend/build-helper tests pass with two platform-specific
  skips, alongside 43 backend and 18 local-service tests. Five focused regressions cover
  focus/visibility request counts, unchanged-status diff refresh, hidden polls, failure recovery and
  cleanup, directory ordering, Unicode/case-sensitive search, mixed line endings, all byte values,
  replay order, exit metadata and expired/future cursors.

- Frozen dependency installation, TypeScript/production build, localization, documentation checks,
  changed-file formatting, both Cargo format checks and desktop compilation with isolated identifier
  `sh.uterm.desktop.qa.optimization` pass. The production build retains its large-chunk warning.

- Native focus/visibility interaction, whole-app CPU/RSS gains and macOS/Linux runtime acceptance
  remain unmeasured; the installed application was not restarted.

### Connection and component resources

Connection resource controls: Redis handshakes reserve slots without holding the connection-map
lock, leaving other connections usable and disconnectable. Both Redis and database eight-connection
limits include handshakes and release reservations on failure.

- Component downloads retain partial files for resuming after interruption or cancellation; offline
  imports and extraction use temporary files that are removed on failure/cancellation. Verification
  uses a 64 KiB buffer and extraction reads directly from files.

- Completion events refresh component status without rehashing drivers every second; closed
  component details and hidden disconnected workbenches do not load status. Database replies
  transfer ownership without a result clone, and editing SQL preserves unchanged result-cell
  renders.

- Disconnects release cached rows/metadata while preserving SQL drafts; hiding a connected workbench
  keeps its results. JSON serialization shares one output buffer; Redis hex previews decode at most
  258 bytes.

- The parent owns each database worker temporary directory and removes certificate files after
  disconnect or unexpected worker exit. One-use SSH password servers check idle state every 100 ms,
  wake immediately on disposal and stop after rejecting a fingerprint.

#### Connection-resource measurements

- Resource validation: five independent-process stress microbenchmarks on macOS ARM64/Java 26.0.2.1
  with `-Xmx192m`, 200×32 Chinese/control-character cells, 10 warmups and 40 serializations reduce
  median elapsed time from 621 ms to 103 ms and median peak process RSS from 153,124,864 to
  103,809,024 bytes. This synthetic stress sample compares serialization, not whole-app gains.

- In a five-second idle sample after connecting the isolated Release app to TLS MySQL, native-main
  CPU is approximately 0.39% with 45.6 MB RSS; JDBC CPU is approximately 0% with 21.4–21.5 MB RSS.
  The snapshot excludes WebView/session-service processes, and RSS depends on system paging.

- Each database worker retains a 192 MiB Java heap cap excluding native memory;
  long-running/multiple-connection process-tree peaks remain unmeasured.

### Idle control and PTY monitoring

Idle resource handling uses queue notifications for local control, with a 30 second wait deadline
instead of repeated empty reads. Waiting does not claim requests, so reloaded views can still
process them; expired queue entries are removed before reuse.

- Authentication, loopback binding, request expiry and reply handling remain in effect. Windows PTY
  exit monitoring blocks in the operating system, while Close Session terminates the job
  independently of the child wait lock.

- The output reader waits on a condition variable for exit, preserving output order and
  acknowledgement. Unix child monitoring retains its existing behavior.

### Update verification and log scanning

Ready updates retain a verified cache path rather than the complete payload in memory. Prehashed
Minisign signatures are checked in 64 KiB chunks; legacy signatures retain the compatible bounded
byte-verification fallback.

- Installation loads and rechecks the payload before the existing session/editor/database/Redis/SFTP
  guards and installer. A missing or invalidated cache returns to Download update; a bad signature
  discards the corrupt cache without installing or automatically retrying.

- Online Java archives are read directly from their verified cache, avoiding a complete archive
  staging copy; driver replacement and offline import retain staging and atomic installation. Agent
  log scans reuse line buffers and 64 KiB readers.

- Claude parsing ignores conversation content and stores four integer token counters per response
  ID; duplicate fields, fallback request IDs, seven-day filtering, deduplication and read/time
  limits retain their existing behavior.

#### Idle and verification resource checks

- Resource validation on Windows: 82 backend checks, six focused control checks and 24 local-session
  service checks pass. Real ConPTY checks cover a blocked exit waiter with independent Close
  Session, normal exit code 7 and output sequence/order.

- Renderer regression coverage verifies no control claim while waiting, one reply after
  notification, unchanged update confirmation/guards, and manual recovery after cache verification
  failure. Component checks verify direct cache reads, retained cached content, driver staging and
  offline temporary-file cleanup.

- A synthetic 64 MiB signed update is checked in six independent debug-test processes (three per
  method), with a 500 ms post-verification hold for sampling: median peak working set is 73,662,464
  bytes with whole-payload verification and 6,586,368 bytes with streaming verification (about 70.3
  and 6.3 MiB). This measures the verification process, not whole-app RSS or installation peaks; the
  installer still needs a complete byte buffer.

- A two-file, 6,000-row Claude sample with 2 KiB message bodies scanned five times takes 925 ms with
  the baseline parser and 936 ms with the reduced-allocation parser; this sample does not
  demonstrate a CPU-time improvement. Whole-app idle CPU, long-running process-tree memory and
  macOS/Linux runtime acceptance of these paths remain unmeasured.

### Source layout

React components live in `src/components/`; state and pure logic in `src/lib/`; Tauri commands in
`src-tauri/src/`; PTYs, replay and hooks in `crates/utermd-local/`. The backend and session service
use separate Cargo manifests and lockfiles.

- `src/App.tsx` coordinates workbench selection through named view-transition handlers and the
  editor's save/discard/cancel guard. Components retain their own domain forms and drafts.
- `src/lib/useGitFileStatus.ts` owns Git file-tree reads, polling and stale-response protection;
  `FilePanel` owns the file rows and file operations.
- `src-tauri/src/java.rs` separates configuration, environment detection and native launch planning.
  `java_components.rs` coordinates verified downloads, cached archives and installation.
- `crates/utermd-local/src/tasks.rs` validates launch steps and resolves generated JARs before
  execution. `daemon.rs` owns task identity, snapshots and bounded replay history.

## Validation and limits

### Frontend test resource isolation

Component tests load real modules through a shared Vite SSR test server with file watching, HMR and
WebSocket listening disabled. `pnpm test` retains four concurrent test files. Rendering checks can
run alongside Cargo compilation without monitoring its active executables/debug symbols or sharing
port `24678`.

The resource regression reserves a real loopback port, loads two SSR servers concurrently, checks
their plugin transforms and modifies owned Cargo-style outputs without adding watchers. Linux
validation passed this regression, the Java/menu/Maven scenarios and the complete frontend suite
(436 passed, 11 optional/platform skips). Windows acceptance requires its actual CI reports and
source/tested SHAs; these Linux results do not establish it.

### Windows automated checks

- Repository-wide `pnpm format:check` passes, including Prettier and both Cargo workspaces.
  `.gitattributes` keeps text files on LF and Windows `.cmd`/`.bat` files on CRLF. A fresh Windows
  checkout with `core.autocrlf=true` passes Prettier, preserves batch-file CRLF and leaves binary
  assets unchanged.

- `.editorconfig` aligns editor defaults with the formatters: UTF-8, LF, two-space indentation, four
  spaces for Rust/Java and CRLF for Windows batch files; Markdown keeps intentional trailing spaces.
  PR/branch CI and stable-release builds run the complete `pnpm format:check` on macOS and Windows
  after frozen dependency installation and before tests/desktop compilation.

- Windows validation passes the full formatting check, workflow/Markdown formatting and ten existing
  packaging/release-helper regressions. Workflow parsing verifies the unconditional check order and
  rustfmt installation; Prettier configuration resolution verifies LF source files and CRLF batch
  files.

- Automated validation on Windows passes the complete frontend/build-helper suite (292 passed, 11
  optional/platform checks skipped), 112 backend tests (nine optional checks ignored) and 38
  local-session service tests (two optional installed-CLI checks ignored). Frozen dependency
  installation, repository-wide formatting, localization, documentation and TypeScript/production
  build pass.

- Windows desktop compilation (`pnpm desktop:check`) also passes. Application, desktop
  configuration, Cargo manifest and lockfile versions agree; the versioned bilingual release body
  loads through `releaseNotes(tag)` and both production updater configurations use the stable
  platform feeds without a notes override.

- Native acceptance remains feature-specific as recorded above; build and CI results do not
  establish untested native interactions or live credential/server integration. Production builds
  retain the large-chunk warning.

### macOS automated checks

- Current validation on macOS: 284 frontend/build-helper tests, 114 backend tests and 46
  local-session service tests pass. Ten optional frontend checks are skipped, nine backend tests and
  two native CLI service tests are ignored.

- Frozen dependency installation, formatting, localization, documentation checks,
  TypeScript/production build and desktop compilation pass. The production build retains its
  large-chunk warning.

- Native acceptance and credential limitations remain as described for each feature; macOS
  compilation does not establish Windows/Linux runtime acceptance.

### Panel collapse hints

- Panel collapse hint validation: 143 frontend/build-helper tests pass, including three-second
  expiry, manual-hide exclusion, cancelled/reversed drags, either inspector position, independent
  timers, immediate reopen cancellation and repeat-trigger timing. Source formatting, localization,
  documentation checks, TypeScript/production build and isolated macOS desktop build pass.

- Native QA (`sh.uterm.desktop.qa.collapsehint`) verifies matching icon sizes, hints after dragging
  each panel closed, return to normal appearance and reopening both panels. Native reduced-motion
  and Windows acceptance remain pending.

### Sidebar header and workspace menu

- Sidebar header validation: 143 frontend/build-helper tests, formatting for the changed source
  files, localization, documentation checks, TypeScript/production build and the isolated macOS
  desktop build pass. Native QA (`sh.uterm.desktop.qa.compactheader`) verifies the compact header,
  workspace menu placement, switching workspaces, long-name truncation and sidebar hide/reopen.

- Additional native QA (`sh.uterm.desktop.qa.headeralign`) verifies vertical alignment with the main
  toolbar and the menu opening below the aligned header. The text-only workspace trigger and compact
  menu pass 16 targeted sidebar/localization tests, source formatting, TypeScript/production build
  and an isolated macOS desktop build.

- Native QA (`sh.uterm.desktop.qa.workspacetext`) verifies the text-only appearance, compact menu,
  click/Enter activation, arrow-key navigation and Escape dismissal with focus returned to the
  trigger. Windows runtime and narrow-sidebar menu acceptance remain pending.

### Divider-button interaction

- Divider button validation: all 143 frontend/build-helper tests, 39 backend tests, local-session
  service tests, formatting, localization, documentation checks, TypeScript/production build and
  macOS desktop build pass. Native QA (`sh.uterm.desktop.qa.dividerhover`) verifies default hiding,
  hover reveal at the vertical midpoint with the inspector on either side, clicking to swap, hiding
  after moving away, and following the divider after resizing.

- Native keyboard-focus and Windows acceptance remain pending.

### Active-tree coverage

- Active-tree validation: all 140 frontend/build-helper tests, formatting, localization,
  documentation checks, TypeScript/production build and the isolated macOS desktop build pass.
  Component coverage includes complete trees, pinned descendants without duplicates, workspace
  filtering and moves, section-specific folding, independent folder-state restoration, selection
  guards, removal protection and drag boundaries.

- Native QA (`sh.uterm.desktop.qa.activitytree`) verifies project migration into Active, root and
  Worktree terminal creation and selection, Worktree folding, disabled project removal, pinned
  projects remaining only in Active, long names at 248 and 176 pixel sidebar widths, retention with
  only a Worktree session, and returning to Pinned while hiding Active after the last session
  closes. Native drag ordering, save-conflict handling and Windows runtime behavior remain
  unverified.

- Existing large-chunk and Rust unused-code warnings remain.

### Pane-swap coverage

- Pane swap validation: 143 frontend/build-helper tests pass, including old-settings defaults,
  position round trips, custom shortcuts, persistence failure, retained terminal/editor nodes and
  drafts, file-tree expansion/scroll preservation, hidden/expanded inspector guards, reset and
  mirrored resizing. Formatting, localization, TypeScript/production build and an isolated macOS
  desktop build pass.

- Native QA (`sh.uterm.desktop.qa.paneswap`) verifies swapping with retained terminal output/focus
  and unsaved editor text/focus, width following content, resizing on both sides, left-side
  collapse/reopen, custom shortcut activation, Git expand/restore, light/dark layouts, a 700×520
  window with the project sidebar hidden, and position persistence after quitting and reopening the
  QA app. Component tests use terminal/editor rendering adapters; the native checks exercise the
  real renderers.

- Windows runtime acceptance remains pending. Existing bundle-size and Rust unused-code warnings
  remain.

### Project-menu coverage

- Linux component regression passes for independent submenu mounting, destination pointer events
  without outside dismissal, focus retention and keyboard return. TypeScript and production build
  pass. Linux Chromium with the actual menu component, application styles and fixture workspaces
  confirms visible destinations at 800×600 and 410×375 and verifies destination clicks. The current
  fix still requires macOS/Windows native WebView acceptance.

- Project-menu validation on macOS: 139 frontend/build-helper tests, formatting, localization,
  TypeScript/production build and an isolated desktop build pass. Component tests cover path copying
  and failure reporting, bilingual labels, keyboard expansion/return, destination selection, empty
  destinations and edge positioning.

- Native QA (`sh.uterm.desktop.qa.projectmenu`) verifies the removed entries, submenu layout and
  Escape behavior, copying the exact project path and moving a test project into another workspace
  while retaining its files. Windows/Linux native menu interaction and long-list scrolling remain
  unverified.

### Branch-picker coverage

- Branch picker regression tests cover editor save conflicts, deferred actions after repository
  changes, repeated requests, stale polling, Local/Remote groups, remote switching, context actions,
  missing upstreams, visible remote/authentication failures and keyboard dismissal. Backend tests
  use temporary local/bare repositories for unfetched remote listings, partial remote failures,
  narrow clone tracking, name collisions, branch-switch conflict protection, upstream push/pull,
  divergent history and force-push prevention.

- Pull coverage includes retaining unrelated staged, unstaged and untracked files both when already
  up to date and during a fast-forward, and rejecting file overwrites even when automatic stash is
  enabled in Git configuration.

- On macOS, `pnpm test` passes 274 frontend/build-helper tests with ten skips; `pnpm test:backend`
  passes 113 tests with nine default-ignored service/benchmark tests. TypeScript/production build,
  repository formatting, localization, documentation metadata/index and feature-guide formatting
  checks pass. The generated `docs/README.md` retains a pre-existing Prettier formatting warning.

- Native QA (`sh.uterm.desktop.qa.remotebranches`) verified both menu layouts, selecting an
  unfetched remote branch from a single-branch clone, creating its tracking configuration, pushing a
  test commit to a local bare remote, pulling a newer remote commit with file-list refresh, and
  fetching a new remote reference without changing the current branch. Native Pull with local
  changes, Windows/Linux runtime and authenticated network remotes still require acceptance testing.

- Existing large-chunk and Rust dead-code warnings remain.

### Clipboard coverage

- Clipboard validation on macOS: 137 frontend/build-helper tests, frozen dependency installation,
  formatting, documentation and localization checks, TypeScript/production build and an isolated
  desktop debug build pass. Native QA with bundle ID `sh.uterm.desktop.qa.clipboard` shows Chinese
  text pasted directly into a shell without a WebKit “Paste” confirmation or `NotAllowedError`
  banner.

- The installed app was not restarted. Native copy, multiline paste and live Agent clipboard
  acceptance remain pending; Windows and Linux runtime behavior was not retested on macOS.

- Existing large-chunk and Rust dead-code warnings remain.

### File-copy coverage

- File-copy validation on Windows: 135 frontend tests, 32 backend tests, TypeScript, production
  build and localization checks pass. The browser preview uses mocked filesystem commands; native
  integration remains unverified.

- The production build retains its large-chunk warning.

### Lifecycle and sanitization coverage

- Lifecycle regression tests cover successful versus failed/unknown Agent exits, repeated close
  failures and duplicate close requests. Windows process tests verify that installer cleanup
  terminates both its parent and child processes using an isolated Job Object; Unix uses an isolated
  process group and still needs native acceptance.

- HTML sanitization tests reject SVG `xlink:href` navigation as well as ordinary links. No Agent
  package installation is performed by these tests.

### Agent-installation coverage

- Agent installation and lifecycle validation: 133 frontend tests, 31 backend tests, 15
  local-service tests, production build, formatting and localization checks pass. A browser preview
  verifies the OpenCode installation panel and confirmation command.

- Tests do not install packages on the user's machine; native download/install/launch and macOS
  acceptance remain pending. The build still reports chunks over 500 kB.

### Panel drag boundaries

- Snap eligibility tests cover entering and leaving the threshold during a drag. Browser checks
  confirm release-to-collapse on the left; held-pointer highlight/reversal and native right-panel
  interaction still require runtime acceptance.

- Both panel minimum widths equal the 30 px collapse threshold. Layout tests verify 31 px remains
  visible and 30 px arms collapse during dragging; a browser check verifies left-panel resizing
  through 50 px to collapse without content spilling into the main area.

- Native right-panel acceptance remains pending.

- Sidebar browser acceptance verifies the top-right hide button, the 320 px drag limit and automatic
  hiding below the collapse threshold. Native desktop and macOS pointer acceptance remain pending.

### HTML-preview coverage

- HTML preview validation: 122 frontend tests, production build and localization checks pass. A
  browser run of the real file editor verifies full-document styles and content.

- Native WebView acceptance is not covered by this preview.

### Performance measurements

- Performance validation: 119 frontend/build-helper tests, localization checks and the
  TypeScript/production build pass. The main JavaScript chunk measures 909.45 kB versus a 1,343.64
  kB baseline (approximately 32% smaller); this is startup chunk size, not total installer size.

- Total installer reduction and runtime CPU/RSS improvements have not been measured. Deferred-editor
  failure/recovery and offscreen PDF rendering still need desktop interaction checks; the >500 kB
  chunk warning remains.

### Localization coverage

- Localization validation on Windows: 119 frontend/build-helper tests, 29 backend tests and the
  TypeScript/production build pass. An isolated browser preview of the real settings components
  verifies English → Chinese → English without reload and the translated reset button.

- Component tests mock desktop APIs and terminal/PDF rendering; live native dialogs, tray
  interactions, authenticated provider states and macOS localization still require runtime
  acceptance. The running desktop app is not restarted for these checks.

### Theme coverage

- On macOS, 254 frontend/build-helper tests pass, with 10 optional/platform checks skipped. Coverage
  includes settings round-trips, invalid values, custom icon highlights and at least 7:1 secondary
  text contrast against the canvas, sidebar and surface in all six themes and both color modes.

- Repository formatting, localization/documentation checks, TypeScript/production build and an
  isolated desktop build pass. The production build retains its large-chunk warning.

- An isolated macOS Tauri app (`sh.uterm.desktop.qa.legibility`) runs the real App with temporary
  profiles and mocked desktop commands. Native inspection verifies Chinese dark and English light
  settings labels, navigation, reset and close buttons; heavier sidebar, toolbar and Git icons; and
  branch labels.

  Native inspection also covers Black, Paper and Clear Sky theme switching and readable navigation
  sidebars at 248 and 176 px. An existing browser check covers Ocean selection, Moss light rendering
  and persistence after reload.

- No real sessions or server connections are used. Native Windows/Linux inspection, the other
  themes' desktop appearance and custom interface fonts remain unverified.

### macOS integration scope

- Current macOS validation: frozen dependency installation, all 187 frontend/build-helper tests, 56
  standard backend tests plus four explicitly executed real Redis integration tests, 32
  local-session service tests, formatting, documentation/localization checks, TypeScript/production
  build, desktop compilation and an isolated ARM64 app build pass. Native feature-specific
  acceptance remains as recorded above; Windows/Linux runtime acceptance is not inferred from these
  macOS checks.

### Target-system checks

Automated checks cover state validation, session identity and layout, file recovery, input handling,
build helpers, Rust backend and local service behavior. Run the commands in the README on the target
OS.

### Windows integration scope

- Current Windows verification: frozen dependency installation, documentation/localization checks,
  163 frontend/build-helper tests (two platform-specific tests skipped), 18 local-service tests, 48
  backend tests, six release-helper tests and the TypeScript/frontend production build pass. The
  full frontend suite passes with test-file concurrency limited to four; the initial parallel run
  encountered Vite SSR loading timeouts.

- Backend tests and desktop compilation with the isolated identifier
  `sh.uterm.desktop.qa.release014` pass with single-job compilation, without restarting the
  installed app. Frontend, desktop configuration, Cargo manifest and lockfile versions agree; the
  versioned bilingual release body loads through `releaseNotes(tag)` and agrees with the
  Windows/macOS updater configuration without an override.

- Changed version files and both Cargo formatting checks pass. Native mouse, localization,
  signed-update and installer acceptance remain as recorded for each feature; build results do not
  establish runtime acceptance.

- Shortcut tests cover selection-dependent copying, Control interrupt passthrough, paste keys, macOS
  modifiers and composition/AltGr exclusion. Clipboard shortcuts in live Claude/Codex sessions still
  require interactive verification.

- The frontend build reports a bundle-size warning for chunks above 500 kB.

### Visual acceptance and platform limits

- The Windows app was built and visually inspected in a separate design-QA window. Browser checks
  cover the welcome page at 680×500 without overflow and light-palette rendering.

- Full keyboard, split-pane, file/editor/dialog and macOS visual acceptance remains unverified.

- Interactive Windows/macOS acceptance, installer execution, credential-dependent GitHub/provider
  calls and signed updates require separate runtime checks. Browser preview does not exercise
  desktop commands.

- Unix-only PTY tests do not run on Windows.

### Documentation checks

Documentation metadata, the generated index, Markdown formatting, heading structure and local
navigation links pass their checks. These checks validate documentation only and do not change the
runtime acceptance recorded for each feature.

## Database connections and optional components

### Shared database services

`uterm-core::{database,database_components,downloads}` owns connections, SQL/document requests,
read-only/transaction/cancellation guards, system-credential binding and verified component
installation. Existing Tauri commands delegate to those services. Clients supply application
directories, SSH authentication confirmation, native file selection and events; export pickers and
actual application exit remain platform operations.

Commands share connection/draft and component state. Cancelling file selection releases installation
protection without writing default configuration. The bundled Java engine is restored atomically
into the application cache, keeping the installed bundle unchanged. Drivers, runtimes and resumable
data retain their application-data paths, catalog versions and SHA-256 rules. Existing credential
service names and JSON configuration remain compatible.

The Core JSON interface starts database work asynchronously and returns an opaque operation ID and
generation. Clients poll or consume the matching result while disconnect and component cancellation
remain available. Admission reserves capacity for at most eight running or unread business results;
control operations have separate capacity. Progress events are coalesced and bounded. Operation
lists omit query results and request parameters. Closing the client stops owned database workers and
prevents a connection that finishes late from registering a new handle. Disconnect and client close
send the existing JDBC statement-cancel request with a bounded wait before terminating the owned
worker. They do not retry writes with an uncertain outcome.

The isolated macOS QA app opens **Databases** from its native sidebar or **File → Databases…**. It
reuses the SQL/document workbenches and component/connection forms through the same scoped content
transport. Profile save/removal uses revision-checked Core storage and refuses active or dirty
profiles. Temporary passwords stay in application memory and match canonical configuration values;
changing a profile's target recreates its inactive workbench without carrying the old password. A
successful connection clears the visible password field but keeps the temporary password in private
workbench memory for a later disconnect/connect; a changed or cleared password prop replaces that
memory.

Database handlers explicitly include structured error codes when classifying messages, while generic
error strings keep their existing format. Revision conflicts keep the connection form open and
request a reload; busy/pending errors retain their specific guidance even when the host message does
not repeat the code.

Closing this window hides it while retaining connections, drafts and results. Application quit
refuses active work or pending transactions and confirms draft loss. If another window cancels quit,
the database view resumes with its draft protection. Component selection uses AppKit; content cannot
supply a picker path. Export uses a native save panel. Language/theme changes propagate from shared
settings without saving defaults when opening the window.

#### Shared-service validation and limits

[#38 is implemented and accepted](https://github.com/YondFane/uTerm/issues/38#issuecomment-6678052308)
on the task branch, without merging into `release`. Its source head is
`0c31ec5e002c00c6c4f2d52101a783262a83a79f`; the actual tested PR merge is
`4017ae8c87f3b154844e15127da27bf0bfc75529`. Every report below records a clean source tree. Later
Agent commits do not replace these database acceptance identities.

Linux x86_64 / Rust 1.99.1 passes 24 database/document/component regressions, including interrupted
and cancelled downloads, range errors, size/hash verification, cache repair, archive boundaries,
versioned document writes and connection cleanup. Asynchronous client checks cover late completion
after close, backpressure, generation mismatches and parameter redaction. The real isolated
PostgreSQL 16.11 report passes all 11 scenarios: exact bigint/decimal/binary/null/Unicode, default
read-only protection, pending-transaction disconnect/quit guards, rollback, stale writes and
server-observed query cancellation and release. JDBC 42.7.14 is verified against the catalog.

`python3 -B scripts/database-protocol-qa.py <evidence-directory>` records 32 checks: 29 pass, three
real-MySQL cases are skipped and none fail. MySQL/PostgreSQL/Oracle use JDBC models and pinned
vendor driver SOCKS handshakes; MongoDB uses its real pinned Java driver against a disposable wire
fixture; Elasticsearch uses HTTP simulations. These authorized simulations supplement actual
PostgreSQL acceptance and are explicitly labelled; they do not establish real vendor-cluster or
account acceptance. Commands, driver versions/hashes, reports and logs are in the
[Linux artifact](https://github.com/YondFane/uTerm/actions/runs/42166630794/artifacts/13478739772).

`bash scripts/macos-database-smoke.sh` passes in both complete native jobs: macOS 15.8.2 ARM64 and
15.7.9 Intel, Xcode 16.4, Swift 6.1.2, Rust 1.99.1, JDK 21, PostgreSQL 16.15 and verified JDBC
42.7.14. Both `database-live.json` reports have `passed=true` and exit code 0, covering profile save
without password persistence, SQL controls/editor readiness, clipboard equality, exact values,
hide/reopen/reconnect, active-profile protection and bilingual theme/narrow-window behavior. The
[ARM artifact](https://github.com/YondFane/uTerm/actions/runs/42166630325/artifacts/13479841334) and
[Intel artifact](https://github.com/YondFane/uTerm/actions/runs/42166630325/artifacts/13480049468)
each contain the report, toolchain, logs, `native-database-sql-dark-en.png` and
`native-database-sql-light-zh-narrow.png`.

`python scripts/ssh-tauri-qa.py` passes on macOS 26.6.2 ARM64 and Windows Server 2025 x64 with Node
24.22.2, pnpm 11.22.0, Rust 1.99.1 and JDK 21. Each platform passes 68 real-app scenes, including
five database scenes against real private PostgreSQL 16.15 / 17.11. They cover all five profile
types, verified driver installation, exact SQL, retained drafts, write confirmation,
rollback/commit, server-observed slow-query cancellation and reconnect. `tauri-state-qa/report.json`
has `passed=true` and `cleanupErrors=[]`; `tauri-database-service/database-live.json` verifies
committed data after app exit, no remaining client connections, owned-server shutdown and credential
exclusion. The
[macOS artifact](https://github.com/YondFane/uTerm/actions/runs/42166630494/artifacts/13480905732)
and
[Windows artifact](https://github.com/YondFane/uTerm/actions/runs/42166630494/artifacts/13480430678)
each contain
`tauri-state-qa/database-database-live-{profiles,exact,draft,transactions,recovery}.png` and
adjacent scenario/capture metadata.

All 14 original application screenshots have been individually inspected. Long values clipped by a
window or result column are checked as exact strings in the reports. SQL/Unicode samples come from
the shared fixture, preserving translation checks. Draft reopening locates the saved endpoint and
requires its `*` marker, the same editor instance and unchanged SQL. Component probes start only
when the manager is opened and are retained when hidden. Input readiness waits for enabled controls
and a visible editable CodeMirror. Profile CAS, cancellation draining on both content ports, modal
freeze/resume and temporary-password invalidation remain covered; native diagnostics contain fixed
methods and bounded error codes rather than private parameters/vendor text.

Final manual interaction/picker acceptance is waived by the user and is not recorded as manually
passed. Real non-PostgreSQL vendor clusters remain unexecuted under the authorized simulation scope.
Earlier selector and GitHub DNS failures remain linked in #38; successful reruns are identified by
their actual source and merge. Other M3/M4/M5 acceptance remains separate.

### Database setup and visibility

The workspace's Databases section supports MySQL, PostgreSQL, Oracle service-name, Elasticsearch and
MongoDB connections. SQL databases open the SQL workbench; Elasticsearch and MongoDB open the
document workbench. Add a profile with the section's plus button, select it and click Connect.

- The footer database icon independently shows/hides the section, retaining its connections, SQL and
  transactions. Connected, busy or dirty profiles cannot be edited or removed; referenced SSH
  profiles and workspaces are protected.

- Opening Database components from the sidebar temporarily hides the project inspector and returning
  restores its selected tool and position.

### Database credentials

Profiles retain endpoint, database/service, username, verified TLS/PEM CA, optional system OpenSSH
target and opaque credential reference. Passwords remain in memory unless Remember password stores
them in macOS Keychain or Windows Credential Manager.

- Credentials bind to the configured endpoint, TLS trust and resolved SSH identity; changing those
  requires reentry. Secrets pass through worker stdin, never process arguments or diagnostics.

- Workspace schema 7 retains a backup when upgrading older data; older apps reject it rather than
  silently dropping database profiles.

### Java and driver components

The SQL and MongoDB connection engine is bundled (35,462 bytes); its checked-in source, checksum and
JAR are verified together. Connection restores missing or modified versioned cache copies
atomically.

- Main builds need no JDK. Java and vendor drivers remain optional and excluded from installers.

- The app validates an explicitly selected Java first, then detects working Java 17+ from JAVA_HOME,
  PATH and platform locations, then uses a managed runtime. Component management is available in
  Settings, the sidebar section and connection dialog; an unavailable component never replaces the
  SQL editor.

- Install required components displays the missing download size and installs only selected
  dependencies. No automatic downloads or system Java changes occur.

- Online/offline installation requires catalog versions, exact sizes and SHA-256; the portable
  Temurin 21 runtime uses TUNA mirror packages. Archive extraction bounds paths, size and file
  count.

- Interrupted/cancelled downloads retain their prefix across restarts; Resume uses validated HTTP
  Range or restarts when unsupported. Verified complete packages are retained for installation
  retries; every reuse checks catalog size and SHA-256, online runtime archives are verified and
  extracted directly from the retained cache, while offline imports and driver replacement use
  separate temporary staging.

- Transient network/server failures allow at most three download attempts; cancellation,
  certificate, storage, missing-file and verification failures do not loop. Rate limits and server
  Retry-After guidance return a retry-later error.

- Each component offers Download manually beside Offline installation. Complete and partial caches
  use the same bounded cleanup policy as update caches.

- Uninstall retains profiles and is disabled while a database connection is open.

### Database TLS and SSH

Direct TCP, verified TLS and existing OpenSSH profiles are supported. Tunnels use a
destination-restricted loopback SOCKS proxy with a one-time authentication token; JDBC retains the
original hostname for certificate verification.

- TLS uses the selected Java trust store or provided PEM CA without disabling hostname checks.
  MySQL/PostgreSQL use official JDBC drivers; Oracle uses JDBC Thin service names.

- SID, Wallet/cloud presets, arbitrary JDBC URLs, custom driver imports and server installation are
  unavailable.

### Elasticsearch and MongoDB document workbench

Add a connection from Databases and choose Elasticsearch or MongoDB. Elasticsearch defaults to port
9200 and accepts username/password or an encoded API Key. MongoDB defaults to port 27017 with a
separate authentication database, defaulting to `admin`. Leave credentials empty for services that
permit anonymous access.

For Elasticsearch, Host address accepts a domain, IP address or HTTP/HTTPS root URL. Leaving the
field, testing or saving a connection extracts the URL's host, port and TLS setting. For example,
`https://es.example.com` becomes host `es.example.com`, port `443` and enabled TLS;
`http://127.0.0.1:9200/` retains port `9200` without TLS. A URL without an explicit port uses `443`
for HTTPS or `80` for HTTP. Entering only a host retains the separate port and TLS settings.

URLs cannot contain credentials, index paths, query parameters or fragments; enter authentication
and the default index in their separate fields. Invalid addresses and ports show specific errors.
Saved profiles and desktop commands continue to use separate host, port and TLS fields.

- Elasticsearch reuses the built-in HTTP client without Java or driver downloads. Install MongoDB's
  pinned Sync, Core and BSON drivers on demand through Database components: 2,779,903 bytes in
  total. These drivers and the optional Java runtime stay outside the main installer.

- MongoDB uses one host and port with `directConnection=true`. Standalone servers and directly
  reachable replica-set members are supported; SRV, multiple-host discovery, sharded routing
  configuration and arbitrary connection URIs are unavailable. SQL transactions, grid editing and
  execution plans do not apply to document connections.

#### Browse and query documents

1. Connect and select a database and collection, or specify one Elasticsearch index. Refresh objects
   loads at most 500 names; you can also enter an authorized name directly.
2. Enter an Elasticsearch Query DSL body such as `{"query":{"match_all":{}}}` and inspect index
   Mapping. For MongoDB, enter `{"filter":{},"sort":{"_id":1}}` with an optional `projection`, or
   use `{"pipeline":[{"$match":{}}]}` for read-only aggregation.
3. Click Run query or press Ctrl/Cmd+Enter. Each page contains at most 50 documents within the first
   10,000 results. Pagination reissues the query without a snapshot. After editing a query, run it
   again from the first page before using pagination. Elasticsearch pagination fields including
   `from`, `size` and `search_after` are managed by the workbench and cannot be supplied in the
   query.

MongoDB uses canonical Extended JSON to preserve ObjectId, dates and numeric types. Queries, edits
and exports retain JSON text without frontend number reserialization. Aggregation rejects `$out`,
`$merge` and server JavaScript operations, including nested pipelines. Elasticsearch preserves large
integers; source-filtered documents cannot be replaced or deleted.

- Queries and individual documents are limited to 262,144 characters, page documents to about 1 MiB,
  Elasticsearch documents plus additional metadata to 2 MiB, and transport to 8 MiB. Excess results
  fail explicitly instead of allowing edits to truncated documents. Server query budgets are 30
  seconds; Cancel query and disconnect closes the connection and retains drafts.

- Save JSON saves the current query; Export page JSON exports only loaded documents. Query and
  document drafts stay in memory. Hidden workbenches retain connections and drafts; switching
  targets or documents requires confirmation before discarding unsaved document changes. Exit guards
  cover both draft types.

#### Document writes and connection protection

Connections start read-only. Enable editing to create documents or replace/delete a selected query
result; each write requires confirmation. Writes take effect immediately without commit, rollback or
automatic retries. MongoDB account permissions and Elasticsearch server permissions still apply.

- Replacement and deletion check for conflicts. Elasticsearch sends the original sequence number and
  primary term; MongoDB matches `_id` and the entire original document with BSON types preserved.
  Changed documents, incomplete projections or transformed aggregation results can fail the check,
  retaining drafts for review. MongoDB replacement cannot change `_id`.

- TLS verifies certificates and hostnames, with optional PEM CA files. Both reuse the authenticated
  loopback-only SSH SOCKS channel, restricted to the configured endpoint; MongoDB does not discover
  additional nodes. Passwords and API Keys can use the existing system credential store, bound to
  endpoint, authentication method/database, TLS trust and SSH identity.

- Timeouts or lost connections can leave write results unknown. Reconnect and check server state
  before trying again. Fixed diagnostic codes avoid echoing documents or credentials from vendor
  errors. Connections and handshakes share the existing eight database slots; document connections
  do not create SQL browsing workers.

Protocol references:
[Elasticsearch Search API](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-search),
[MongoDB Extended JSON](https://www.mongodb.com/docs/drivers/java/sync/current/data-formats/document-data-format-extended-json/)
and [MongoDB SOCKS5](https://www.mongodb.com/docs/drivers/java/sync/current/security/socks/).

### Object browsing and menus

Expand catalogs/schemas to load tables and views; system objects are folded. Object filtering
searches loaded names.

- Double-click, Enter or View data opens the current table's Data/Structure views without replacing
  SQL. Object menus open beside their table's action button, stay within the window and open upward
  near the bottom, outside the scrolling tree's clipping area.

- View data, View structure and Generate SELECT remain available for tables at the bottom of a long
  list. Only one object menu opens at a time.

- Outside pointer input, Escape, scrolling the tree, resizing, losing window focus or hiding the
  browser/workbench closes it; Escape returns focus to its trigger. Arrow keys and Home/End navigate
  the actions.

- Generate SELECT quotes actual names and confirms replacing an unsaved draft. Metadata treats `%`
  and `_` literally.

- Eight loaded namespace groups are cached per workbench, with up to 500 metadata rows per request.

### SQL tabs and execution scope

Up to eight SQL query tabs retain separate drafts, undo, selections and results during this run. All
tabs explicitly share one connection and transaction.

- Execute SQL runs the selection or caret statement by default; the scope selector also offers
  current/selection/all. Ctrl/Cmd+Enter uses automatic scope; Ctrl/Cmd+Shift+Enter runs all.

- Batches contain at most 100 statements, execute sequentially and stop on the first failure.
  Statement boundaries understand MySQL strings/comments, PostgreSQL dollar quotes/nested comments
  and Oracle alternative quotes.

- DELIMITER scripts and Oracle procedural blocks are rejected rather than split incorrectly.
  Commented SELECT and nonwriting WITH queries work read-only; mutating CTEs, locks and ambiguous
  MySQL backslash-quote strings require editing.

- Server account permissions remain authoritative.

### Completion, formatting and SQL drafts

Completion uses the selected dialect and loaded object/column names. Formatting changes whitespace,
retains identifier case, literals, comments and compound operators, and has its own undo step.

- Format a selection or the entire draft. Numeric server error positions/lines support Jump to
  failed statement; otherwise it jumps to that statement's start.

- Vendor error messages and SQL values are not returned in diagnostics. History retains the latest
  50 attempts within 262,144 SQL characters in memory; restore confirms replacing an unsaved draft,
  and Clear removes history.

- Restart recovery is unavailable. Each SQL draft is limited to 262,144 characters; each tab retains
  up to four recent result sets within a two-million-cell-character cache budget.

- Disconnection clears results, while SQL drafts remain. Copy SQL and Discard SQL changes are flat
  toolbar buttons; copy retains draft protection and discard requires confirmation.

- Save SQL clears that draft's guard only after the selected file is written.

### Result-grid layout and filtering

Hide/resize the object browser and resize the editor/result split with pointer or focused arrow
keys. Toolbars scroll horizontally on narrow windows and pagination stays at the bottom.

- Column headers and row numbers stay fixed while scrolling, with opaque backgrounds covering the
  cells beneath them. When columns exceed the result viewport, a visible horizontal scrollbar at its
  bottom lets you drag to additional columns without scrolling to the last row.

- The grid renders visible rows and columns rather than a complete wide table. Drag/Shift-arrow
  selection, row selection, Ctrl/Cmd+A/C, TSV copying with optional headers and adjustable column
  widths are supported.

- Double-click/Enter inspects the complete loaded value as literal text. NULL differs from empty
  text; truncated values are never fetched in full.

- Filter loaded page searches only the current result, including draft overlays. Server-side
  filtering instead issues a prepared table query; equality, comparison, literal substring and NULL
  conditions apply before paging.

- Pages use primary-key order when available and rerun the query; they do not hold a snapshot or
  count the entire table.

### Read-only workers and cancellation

Connections start read-only. In this mode browsing reuses the existing worker and rolls back reads;
enabling editing opens an independent read-only browser worker only when needed, so browsing never
settles SQL writes.

- Turning editing off releases that auxiliary worker. Disconnect closes both.

- The eight-worker limit includes owners, auxiliary browser workers and opening connections: eight
  read-only workbenches or four using both workers fill it. Browser-worker failure preserves the SQL
  connection and transaction; retry opens a fresh browser worker.

- SQL reply timeout/confirmed loss closes the connection and retains drafts. Queries have a
  30-second server timeout and a 40-second reply deadline.

- Cancel query deliberately closes the connection; connection-preserving driver cancellation remains
  deferred because write outcomes must stay explicit. Uncertain writes are never retried
  automatically.

### Editing tables and transactions

Enable editing to execute other SQL after confirmation. Commit and Roll back explicitly settle the
shared transaction; DDL may commit automatically.

- The pending indicator is conservative, including SELECT in editing mode. Editable table grids
  require an ordinary table, non-null primary key, supported scalar columns and transaction support
  (InnoDB for MySQL).

- Views, missing primary keys, BLOB/CLOB/vendor-specific columns and nontransactional tables stay
  read-only; arbitrary SQL query results are also read-only. Primary keys/generated columns cannot
  be updated; generated insert values are omitted.

- Double-click a writable cell or use Edit cell, distinguish NULL from text, then Stage cell change.
  Add row and Delete/Restore current row create drafts.

- At most 100 row changes and 768 KiB of draft payload are retained; values are limited to 16,384
  characters. Rows with truncated values cannot be edited or deleted.

### Applying drafts and recovering failures

Preview table changes shows generated SQL with placeholders and bound parameters. Apply to
transaction locks rows by primary key and compares original scalar values; stale/deleted rows or
changed table metadata fail visibly.

- A failure rolls back this batch's savepoint, retaining drafts and earlier SQL writes. The batch
  has a 25-second execution budget before its bounded refresh.

- Successful apply displays the current transaction's data and still requires Commit; Roll back
  restores committed data. Refresh, server filtering, export and paging cannot replace unapplied
  table drafts; switching tables, disconnecting or discarding requires confirmation.

- Unexpected connection loss retains the table snapshot and drafts for inspection, but requires
  reconnecting and checking server state before reuse. Quit/update guards cover all SQL and table
  drafts, active work and transactions, revealing hidden workbenches that require action.

### Export and execution plans

Export CSV/JSON writes only the loaded page through a native save dialog, with an 8 MiB output limit
and atomic save. CSV uses UTF-8 BOM, quoted fields, `\N` for NULL and spreadsheet-formula
protection; JSON preserves column descriptors, precision strings, NULL, binary and truncation
markers.

- Export excludes unapplied grid drafts and does not query all rows. Execution plan explains one
  selected/current read query without ANALYZE.

- MySQL uses EXPLAIN and PostgreSQL uses EXPLAIN (FORMAT JSON). Oracle requires editing plus
  PLAN_TABLE/DBMS_XPLAN permissions; it uses a savepoint to remove plan rows without settling
  earlier writes.

- PostgreSQL/Oracle live acceptance remains pending.

### Result and memory limits

Result limits: 256 columns, 200 rows per page, offset at most 10,000, 16,384 text characters or
4,096 binary bytes per cell, 1,048,576 serialized-cell characters and 8 MiB transport. Numerics
remain strings and binary is Base64.

- Each JVM has a 192 MiB heap cap; drivers may buffer data internally, so these result limits are
  not process RSS guarantees. History, drafts and result caches stay in memory unless explicitly
  saved/exported.

- Development JDKs, Cargo targets, test databases and node_modules never enter installers.

### Database validation

#### Elasticsearch address checks on macOS

- All 287 frontend/build-helper tests pass, with ten optional checks skipped. Address and dialog
  regressions cover HTTP/HTTPS default and explicit ports, IPv6, retained manual settings, rejected
  URL options/credentials, normalized connection tests and credential saves, default names and
  unchanged SQL URL restrictions. IPC replies are simulated and credentials are not stored in the
  system keychain during these tests.
- TypeScript, localization, formatting, documentation checks, local-session and backend suites,
  production and isolated desktop builds pass. The production build retains its existing large-chunk
  warning.
- The isolated macOS app (`sh.uterm.desktop.qa.esaddress`) verifies the Chinese connection dialog,
  HTTPS host/port normalization, explicit port retention and visible path errors without clipping
  the dialog controls. The installed app was not restarted. No credentialed Elasticsearch deployment
  was contacted; Windows/Linux runtime acceptance remains pending.

#### Document database checks on Windows

- The ordinary `pnpm test` suite passes with 241 tests and 11 opt-in/platform skips. A separate run
  enabling the MongoDB driver wire fixture passes both document-database tests. The final 19 focused
  frontend checks pass, including query-change pagination protection and retained drafts. Backend
  validation passes with 104 tests and six opt-in skips; the local-session service passes 26 tests.

- Focused checks cover exact JSON/BSON numbers, ObjectId, NULL, nested aggregation write guards,
  default read-only access, explicit write confirmation, original-document conflicts, encoded
  Elasticsearch document IDs, sequence/primary-term conditions, projection protection and bounded
  pagination and disconnecting an in-flight Elasticsearch request. The MongoDB fixture uses the real
  pinned Java driver against a disposable loopback protocol server; it does not connect to an
  existing database.

- Frozen dependency installation, TypeScript/production build, bundled-engine verification and
  `pnpm desktop:check` pass. Database source formatting and the global localization check pass.
  Documentation metadata/index and changed Markdown formatting pass. Production builds retain the
  existing large-chunk warning.

- Isolated Windows applications (`sh.uterm.desktop.qa.documents` and `.documents.narrow`) use the
  real workbench with simulated replies to inspect Elasticsearch and MongoDB queries, 40 object
  names, 50-document pages, immediate-write confirmation, Chinese/English switching and light/dark
  appearances. The 1,000-pixel window and the 640-pixel narrow window keep query and pagination
  controls usable; the narrow layout retains the pagination bar while results scroll.

- These fixtures do not establish acceptance against live Elasticsearch/MongoDB deployments,
  authenticated TLS/SSH servers or native credential/export dialogs. macOS/Linux runtime acceptance
  remains pending. The installed application and existing database services were not restarted.
  Java, MongoDB drivers and database servers remain outside the main installer; an isolated final
  installer-size comparison has not been measured.

#### Grid-scrolling checks on macOS

- Grid scrolling validation on macOS: 209 frontend/build-helper tests pass, with eight optional
  checks skipped. The isolated native app (`sh.uterm.desktop.qa.dbgrid`) uses simulated 256-column,
  200-row results to verify fixed opaque headers and row numbers, visible draggable bottom
  horizontal scrollbars, access to the final column and retained pagination at 900×600 and 640×420.

- Both light and dark appearances are inspected after scrolling. Formatting, localization,
  TypeScript/production build and isolated desktop builds pass; production builds retain the
  existing large-chunk warning.

- This validates the WebView layout rather than a live database connection. Windows/Linux runtime
  acceptance of this scrolling layout remains pending.

#### Object-menu checks on macOS

- Object-menu validation on macOS: 209 frontend/build-helper tests pass, with eight optional checks
  skipped. A focused 40-table regression covers bottom/right edge positioning, all three actions on
  the final table, one open menu, keyboard focus/navigation, scroll/resize/blur dismissal and
  cleanup when hidden, disabled, collapsed or unmounted.

- Formatting, localization, TypeScript/production build and the isolated macOS QA application build
  pass. Native QA (`sh.uterm.desktop.qa.dbmenufix`) at 900×600 verifies the menu opening upward on
  the final table of a 39-table list and all three actions targeting `user_roles`, using the real
  workbench with simulated database replies.

- This validates WebView interaction, not a live database connection. Production builds retain the
  existing large-chunk warning.

- Windows/Linux runtime acceptance of menu positioning remains pending.

#### Database automated checks on Windows

- Validation on Windows: 200 frontend/build-helper tests pass and ten opt-in/platform checks skip;
  69 backend tests and 22 local-session service tests pass, with four opt-in Redis tests ignored.
  Focused regressions cover SQL dialect boundaries/read-only guards, formatting (including Unicode
  prefixes, variables and compound operators), NULL/precision/CSV safety, draft coalescing, bounded
  wide-grid rendering and keyboard navigation, menu dismissal, retained SQL/results and transaction
  guards.

- An explicitly enabled write suite passes using uniquely named tables in a disposable loopback
  MySQL 5.7.33 schema on port 33379. It verifies bound Unicode/quoted values, preview, observer
  isolation, commit/rollback, duplicate-key batch rollback preserving earlier SQL, stale-row
  rejection, literal filters, insertion/deletion, read-only table restrictions and EXPLAIN.

- Java probes verify independent SQL guards and allocation-free JSON length accounting; real
  read-only MySQL checks pass directly and through authenticated SOCKS.

#### Database native checks on Windows

- The isolated native Windows app (`sh.uterm.desktop.qa.dbmenus`, local Java 21) verifies batch
  execution shortcuts without modifying SQL, query/result retention across tabs, formatting undo,
  in-memory history, loaded-table completion, outside-click/Escape menu dismissal and focus, staged
  cell editing, parameter previews, apply and rollback. Table viewports at 1280×800, 900×600 and
  640×420 keep the result footer visible.

- Turning editing off removes the auxiliary Java worker (two workers become one). An idle two-second
  snapshot records no CPU increase for the app/Java workers: the app main process is about 47 MiB
  RSS and Java workers about 66–68 MiB each; these exclude WebView subprocesses and do not establish
  peaks.

- Frozen installation, TypeScript/production build, pinned-JDK engine verification, isolated desktop
  build, changed-source formatting, localization and documentation checks pass. Production builds
  retain the existing large-chunk warning.

- New native export-save dialogs, macOS UI, PostgreSQL/Oracle live servers and complete database
  SSH/TLS acceptance remain unverified; authenticated SOCKS does not establish full SSH acceptance.
  The installed app/database service was not restarted.
