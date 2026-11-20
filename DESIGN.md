---
name: Cast · Stremio
description: Un pase de embarque para elegir película y TV, y un tablero de salidas con mando para vigilar de reojo.
colors:
  platform-black: "#101214"
  pass-stock: "#171a1d"
  cell: "#1f2327"
  cell-raised: "#262b30"
  rule: "#2b3036"
  perforation: "#3a4047"
  ink: "#f2f2ee"
  ink-soft: "#c4c6c0"
  mute: "#8a929c"
  signal-yellow: "#ffcc00"
  signal-ink: "#15130a"
typography:
  title:
    fontFamily: "Archivo, Arial Narrow, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0.02em"
  headline:
    fontFamily: "Archivo, Arial Narrow, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 800
    lineHeight: 1.02
  selected:
    fontFamily: "Archivo, Arial Narrow, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.05
  body:
    fontFamily: "Archivo, Arial Narrow, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.4
  option:
    fontFamily: "Archivo, Arial Narrow, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.15
  label:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.14em"
  readout:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0.06em"
  figure:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "52px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.02em"
rounded:
  mark: "2px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "14px"
  sheet: "18px"
spacing:
  gap: "6px"
  inset: "14px"
  pad: "18px"
  gutter: "20px"
components:
  button-signal:
    backgroundColor: "{colors.signal-yellow}"
    textColor: "{colors.signal-ink}"
    rounded: "{rounded.lg}"
    height: "48px"
    padding: "0 18px"
  button-board:
    backgroundColor: "{colors.signal-yellow}"
    textColor: "{colors.signal-ink}"
    rounded: "{rounded.lg}"
    height: "64px"
    padding: "10px 20px"
  button-board-disabled:
    backgroundColor: "{colors.cell}"
    textColor: "{colors.mute}"
  button-neutral:
    backgroundColor: "{colors.cell-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    height: "48px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 14px"
  button-toggle:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.platform-black}"
    rounded: "{rounded.xl}"
    size: "104px"
  button-jump:
    backgroundColor: "{colors.cell}"
    textColor: "{colors.ink}"
    rounded: "10px"
    height: "64px"
  pass:
    backgroundColor: "{colors.pass-stock}"
    rounded: "{rounded.xl}"
  board:
    backgroundColor: "{colors.pass-stock}"
    rounded: "12px"
    padding: "14px 14px 16px"
  flap:
    backgroundColor: "{colors.cell-raised}"
    textColor: "{colors.ink}"
    rounded: "3px"
    width: "22px"
    height: "34px"
  problem:
    backgroundColor: "{colors.pass-stock}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
  sheet:
    backgroundColor: "{colors.pass-stock}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
---

# Design System: Cast · Stremio

## Overview

**Creative North Star: "Pase y tablero"**

The panel is two paper objects from a station. In Preparar the page is a boarding pass: a stock card with numbered segments (01 Película, 02 Destino, 03 Subtítulos), a perforated stub at the bottom that says what is still missing or which TV the pass is for, and one yellow boarding button. In Mando the page becomes a departures board with a remote under it: the movie title, a split-flap clock, a state cell and the room, then the timeline, sound, and a thumb-sized transport. Both objects sit on the same near-black platform, so the switch between them reads as one trip, not two screens.

The register is Operate, for a glance across a dim room and a thumb on a narrow phone. Density is low and the column is narrow (440px). Nothing decorates; the paper material (perforation, notches, barcode, split-flap seam) exists because the world is a station, and each piece carries information or the sense of the object, never ornament alone. Technical detail stays in a monospace voice that is quieter than the Archivo voice that carries the movie and the choices.

PRODUCT.md's commitments shape the surface: Spanish plain-language copy, one problem block per state, one Detener on screen, drafts that wait for Aplicar. This file records only how those look.

**Key Characteristics:**
- One dark platform, one paper-stock surface, one signal yellow.
- Condensed Archivo for what you choose and read; JetBrains Mono for what the system reports.
- Square marks, dotted perforation, hairline rules; no shadows.
- Tonal layering (platform, pass, cell, raised cell) is the whole depth system.
- Every tap target is at least 44px; the primary targets are 48 to 104px.

## Colors

A cold graphite platform with warm off-white ink and exactly one hot color. Contrast comes from lightness steps, not from hue.

### Primary
- **Signal Yellow** (#ffcc00): the one color that means "your hand is needed". It fills the commit action (Iniciar, Aplicar, Ir, the Cambiar película confirmation) and marks anything pending or unconfirmed: the problem block's left rule, the unapplied subtitle chip and sync panel, the seek preview and ghost marker, the stub's "Falta" value, a device note, an invalid time field. Text on it is **Signal Ink** (#15130a).

### Neutral
- **Platform Black** (#101214): the page, the input wells, the notch cut-outs, and the ink of selected marks.
- **Pass Stock** (#171a1d): the pass, the board, the sheet, the problem block. The card material.
- **Cell** (#1f2327): resting fills for disabled buttons, jump buttons, the demo banner.
- **Cell Raised** (#262b30): fills one step above, for the split-flaps, state cell, neutral buttons, the empty rail, pressed segments.
- **Rule** (#2b3036): hairlines, borders, dashed option dividers.
- **Perforation** (#3a4047): the dotted tear line on the stub.
- **Ink** (#f2f2ee): primary text, the progress fill, the playhead and the central play button.
- **Ink Soft** (#c4c6c0): secondary text, unselected options, quiet buttons.
- **Mute** (#8a929c): labels, hints, idle marks, muted-state icon.

### Named Rules
**The One Signal Rule.** Yellow is the only hue. It appears as a fill on a committing action or as a rule, text or marker on a pending or unconfirmed state. It never decorates, never fills a whole surface, and never appears twice for the same meaning in one block.

**The Ink Is The Selection Rule.** A chosen option is shown by white ink, a filled square mark and a larger name, never by a color. Yellow stays reserved for actions and pending state.

## Typography

**Display and body font:** Archivo (variable, 100 to 900 weight, 62 to 125% width), falling back to Arial Narrow then system-ui. Stored in `fonts/archivo.woff2`.
**Label and readout font:** JetBrains Mono, falling back to ui-monospace and Menlo. Stored in `fonts/jetbrains-mono.woff2`.

The bridge serves each font at a URL carrying a hash of its bytes, such as `/fonts/archivo.<sha256 prefix>.woff2`, and caches it as immutable. Changing a font file changes its URL, so a browser never keeps a stale copy.

**Character:** Archivo is pulled into its condensed widths (75 to 90%) for titles and choices, which gives the signage feel of a departures board at 22 to 28px without a second display face. Mono carries every figure, time, host and system status, always with tabular numerals.

### Hierarchy
- **Title** (800, 22px, 1, uppercase, width 75%): the pass heading «Pase de función».
- **Headline** (800, 28px, 1.02, width 78%): the movie on the board. Sheet headings (26px) and the confirm heading (24px) share this voice at their own sizes.
- **Selected** (700, 24px, 1.05, width 82%): the chosen movie, the chosen TV name. The selected option grows to this size from the 16px option size.
- **Body** (500, 15px, 1.4): page default; 14px for problem and confirm copy.
- **Option** (600, 16px, 1.15, width 90%): rows in the movie, TV and subtitle lists.
- **Label** (mono 500, 11px, 0.14em, uppercase, Mute): segment headings, board field names (Hora, Estado, Sala), the stub label, the problem kind.
- **Readout** (mono 600, 12 to 15px, 0.06em): host, status lines, stub value, volume, elapsed and total time, skip buttons (17px), the sync delay figure (52px, 700).

### Named Rules
**The Two Voices Rule.** Archivo speaks for the person (what to watch, where, what to press); mono speaks for the machine (time, address, state, count). Do not set a figure in Archivo or a choice in mono.

**The Narrow Width Rule.** Condensed width (75 to 90%) is the display device. Letter-spacing is added only to mono labels and the pass title, never to condensed titles.

## Layout

A single column, `max-width: 440px`, centered, full dynamic viewport height. From 700px the column gains a 1px Rule outline and the rest stays platform; it never becomes a multi-column dashboard. Below 360px, horizontal padding drops from 18 to 14px, the subtitle segmented control to 12px type and the central button from 104 to 88px; the page holds at a 320px minimum width.

The rhythm is a 6, 8, 12, 14, 18, 20 set: 14px page gutter around cards, 18 to 20px inside them, 6 to 8px between controls, 12 to 14px between groups. The pass fills the viewport and its stub is sticky at the bottom, so the boarding button is always in reach. In Mando the transport is pinned to the bottom with `margin-top: auto` and safe-area padding, the board and timeline lead, and the sound row spans the full width above a subtitle chip and a Más button.

Modes swap in place (`#prep` and `#mando`); the same document carries both. Secondary work opens as a bottom sheet (max 440px, 18px top corners, rises 24px in 240ms) or, for destructive confirmation, a centered 380px dialog. At most one sheet is open and a confirm stacks above it.

### Named Rules
**The Thumb Floor Rule.** Every control is 44px or larger in both axes. Primary actions are larger: 48px (Aplicar, Ir), 52px (sound, subtitle chip, Más, sheet Detener), 56 to 64px (confirm, sheet actions, boarding button, jumps) and 104px (play and pause).

**The Order Is The Flow Rule.** Segment numbers follow the order of the task, even where the markup differs: movie 01, TV 02, subtitles 03. The stub names the first missing piece and the button then names the TV.

## Elevation & Depth

Flat. Depth is tonal layering: platform (#101214), pass (#171a1d), cell (#1f2327), raised cell (#262b30). There are no drop shadows. The only `box-shadow` values are a 1px Rule outline that frames the column on wide screens and the sheet, and an inset 3px Ink underline on the pressed segment. Overlays use a 72% near-black backdrop. Motion is limited to the sheet and confirm rising in (200 to 240ms, ease `cubic-bezier(.2,.8,.2,1)`) and the spinner turning; `prefers-reduced-motion` removes all of it.

### Named Rules
**The Flat Card Rule.** Cards separate from the platform by lightness alone. If a surface needs to feel lifted, change its tone one step, do not add a shadow.

## Shapes

Paper with trimmed corners, never pills. Large objects (pass 14px, board 12px, toggle 14px, jumps 10px, sheet 18px at the top) are softly rounded; controls and fields are 6 to 8px; tags, flaps and the preview bubble 3 to 4px; selection marks, switches and the problem square are 2px squares. Checks and radios are both squares: a filled inner square marks the choice. The perforation is the one round form: two 22px platform-colored notches cut into the pass edges on either side of a 2px dotted line. The state glyph (play triangle, pause bars, spinner) is drawn in CSS inside the state cell; icons elsewhere are 2px round-stroke SVG on a 22px box.

## Components

### Buttons
- **Shape:** 8px corners (6px for quiet, 10px for jumps, 14px for the central toggle).
- **Signal (primary):** Signal Yellow fill, Signal Ink text, Archivo 800 at 85% width. 48px high in sheets and forms; the boarding button is 64px, full width, label left and arrow right at stroke 2.6. Disabled becomes Cell with Mute text.
- **Neutral:** Cell Raised fill, Archivo 700, full width (Usar este subtítulo).
- **Quiet:** 1px Rule outline, mono 12px uppercase in the page; in sheet action rows it switches to Archivo 15px sentence case at 52 to 60px. Hover brightens text and border to Mute. Used for Detener, Cancelar, and the problem action.
- **Link button:** underlined Ink Soft, 44px target, for secondary refresh and reset actions.
- **Toggle:** a 104px Ink square-ish button with a Platform Black glyph. It is the largest thing on the page on purpose.
- **Focus:** a 2px Ink outline at 2px offset on everything; inset on segmented buttons.

### Pass and its segments
- **Corner Style:** 14px. **Background:** Pass Stock. **Border:** hairline Rule between segments (heading, then 01, 02, 03 each closed by a rule).
- **Option rows:** 48px minimum, separated by dashed Rule lines, with an 18px square mark. The selected row loses its divider, gets extra padding and the 24px selected name.
- **Segmented control:** four equal buttons (Sin, Del archivo, Stremio, Subir) in a 6px-corner bordered box; the pressed one raises to Cell Raised with an inset 3px Ink underline.
- **Chips:** 44px, 6px corners, 1px Rule outline; pressed is Cell Raised with a Mute border.

### Stub
The sticky footer of the pass: dotted perforation with two notches, a label («Falta» or «Embarque»), a mono uppercase value (missing pieces joined by a dot, or the TV), a decorative barcode of repeated 2 to 5px bars (aria-hidden, 22% opacity when something is missing, 70% when ready), an optional status note and the boarding button. The value turns yellow while pieces are missing.

### Board
The Mando header card: label «Ahora en pantalla» with the Cambiar película link, the movie as the headline, then a hairline and three fields. Hora is a split-flap clock (22 by 34px cells, 3px gaps, Cell Raised with a 1px seam through the middle, mono 21px, tabular, display-only and aria-hidden with a text twin for readers). Estado is a flap-style cell with a CSS glyph and an uppercase mono state word. Sala is the TV name, right-aligned.

### Timeline
A 56px touch zone over an 8px rail: Cell Raised rail, a lighter band for the prepared range, Ink fill for the real position, 4px Ink playhead, 10% hairline ticks. While dragging, a yellow bubble shows `→ h:mm:ss`; after release a yellow ghost marker and dashed yellow span show the unsettled target. The hint line below turns yellow while a seek is pending. Elapsed and total are mono 15px at the two ends.

### Problem block
One per state, in the page or, while a sheet is open, only in the sheet. 1px Rule outline with a 4px Signal Yellow left rule; informational kinds (`.info`) get a Rule-colored left rule and a smaller heading. Heading Archivo 700 17px at 88% width, optional body in Ink Soft, optional quiet action.

### Inputs and switch
Text and time fields are 48 to 52px, 8px corners, Platform Black well, 1px Rule border; the time field is mono 20px and its border turns yellow when invalid, with the error in yellow mono beneath. The visibility switch is a 52 by 30px rounded-4px track with a 24px square knob: Mute knob off, Ink track with Platform Black knob on. The volume slider is a 6px bar with a 4 by 20px Ink thumb, the mute button an icon in a 44px target.

### Sheet and confirm
The sheet holds three panels in one native dialog: «Enmienda al pase» (subtitle track, visibility, sync), «Más» (exact time, details, Detener) and «Cambiar película» (the same plan as Preparar). Sync shows its offset in 52px mono, yellow while unapplied, in a panel with a left rule that turns yellow when a draft exists; four step buttons (−1 s, −0,1 s, +0,1 s, +1 s) sit in a 4-column grid. The action row sticks to the bottom: Cancelar (quiet) and Aplicar (signal). The confirm dialog is 380px wide with a 4px yellow top rule, Archivo 24px heading, and Signal accept above a quiet cancel that holds initial focus.

## Do's and Don'ts

### Do:
- **Do** hold every surface to the four-step tonal ladder (#101214, #171a1d, #1f2327, #262b30) and let lightness make the hierarchy.
- **Do** spend Signal Yellow (#ffcc00) on a committing action or a pending state, and nothing else.
- **Do** set times, hosts and counts in JetBrains Mono with tabular numerals, and choices and titles in condensed Archivo.
- **Do** show a chosen item with Ink, a filled 18px square and the larger 24px name.
- **Do** keep controls at 44px or more, with bigger targets for the actions that matter most.
- **Do** render a missing piece as «Falta» on the stub in yellow, and the movie and TV name in Ink once complete.
- **Do** label drafts as drafts: a yellow border or rule while unapplied, cleared when applied or discarded.
- **Do** keep one problem block and one Detener visible; the header drops its own when the problem block offers one.
- **Do** give every color-only cue a text twin (state word beside glyph, status line beside border).

### Don't:
- **Don't** add a second hue, a gradient fill, or a yellow surface wider than a button.
- **Don't** use drop shadows to lift a card; change its tone instead.
- **Don't** round controls into pills or circles; the only circles are the perforation notches and the spinner.
- **Don't** set Archivo at normal width for titles; the narrow signage width is the identity.
- **Don't** invent decoration from the paper world. The perforation, notches, barcode and split-flap exist; a new ticket motif must carry information or stay out.
- **Don't** let the split-flap clock stand alone for assistive reading; the sr-only text twin is part of the component.

### Not canonized (defects the build carries)
- The problem block's small uppercase «Aviso» line and its 8px yellow square above the heading, and the same label-with-square on the unapplied subtitle chip: an eyebrow device on top of a heading that already says the thing. Future blocks should lead with the heading.
- The uppercase mono 01 to 03 numbering inside segment labels is a step index of a three-step task, not a pattern for other labels or for numbering unrelated sections.
- One-off values not promoted to tokens: the prepared-range gray (#4a515a), the neutral hover (#30363c), the barcode bar color (#b9bbb4).
