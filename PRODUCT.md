# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Stefano uses this local panel to watch a Stremio movie on a classic Chromecast without a remote. Spanish, plain-language controls must work on desktop and a narrow screen.

## Product Purpose

Choose a video-capable Google Cast destination and the intended movie, then control its TV playback. The panel has two modes on one page. Preparar takes three taps: the movie, the TV and Iniciar. The last TV used is preselected, never started. The subtitle decision is one choice among Sin (the default), Del archivo (an embedded text track in any available language), Stremio (a subtitle from Stremio's own addon) and Subir (a local SRT or VTT file). After Iniciar the page becomes Mando: a departures board with title, clock, state and room, then the timeline, the transport, volume and mute, the subtitle chip and Más.

## Operating Context

The Mac runs Stremio and a Python bridge. The current user-owned movie session must remain untouched during development. Interactive QA uses the production panel with an explicitly labelled, isolated synthetic fixture and no receiver or Stremio connections. Starting the fixture and browser QA are separate authorized stages; implementation checks do not start services.

## Capabilities and Constraints

The panel starts with no receiver or movie selected and needs no receiver or LAN route to open. Bounded metadata discovery runs at startup and every 30 seconds. Each list has its own Refresh action. Discovery and UUID-based selection never start content or block playback commands. Destination changes require an explicit Stop while owned playback resources remain. Only the explicit movie-start action casts in ordinary mode.

The bridge provides start, pause, resume, stop, seeking, subtitle selection and timing, volume, mute and subtitle visibility with ownership checks. Seeking, subtitle-track changes and timing changes rebuild playback and retain position or pause as appropriate. Visibility-only changes do not rebuild. Source discovery lists cached files, not a reliably detected active movie. A saved source may be stale. Embedded text tracks have no mandatory language. Image subtitles remain visible as unsupported choices and never prevent playback without subtitles. Local UTF-8 SRT and VTT uploads and downloaded Stremio subtitles are bounded, privately stored and bound to their source catalogue. Stremio subtitles come only from Stremio's own OpenSubtitles v3 addon and Cinemeta, looked up in the background once a movie's tracks are ready and never delaying them. The title parsed from the file or torrent name, and whether it is a movie or a series, go to Cinemeta. The IMDb id, season, episode and original file name go to the addon. The year is never sent. Downloads happen only on an explicit choice and go through the local Stremio engine, which follows redirects itself, a residual risk. Start and Apply never query or download from Stremio's services. `--no-stremio-subtitles` turns the lookup off and hides the block. There is no other provider and no image OCR. Real-device verification remains separate from offline and synthetic QA.

## Product Principles

- Familiar player controls lead; technical details remain secondary.
- Clearly distinguish a selected movie from the movie playing on the TV.
- Keep preparation in one in-page flow. During playback the current movie and transport lead. Subtitles, exact time, details and Cambiar película open as sheets only when requested.
- A seek happens when the user releases the timeline, never while dragging. Escape or a cancelled gesture sends nothing. Taps on ±30 s add up and send one seek.
- A subtitle track or timing edit is a draft until the user chooses Aplicar. Showing or hiding the subtitles applies at once.
- Detener asks first while the movie plays or is paused. In a problem block, and as Cancelar while the TV is still preparing, it stops at once.
- One problem block per state and one Detener on screen. When the problem block offers Detener, the header drops its own.
- State, waiting, errors and recovery must be understandable without jargon.
- Never control receiver content that does not belong to this bridge.

## Evidence on Hand

README.md and bridge.py describe incumbent behavior. Existing tests cover playback ownership, input-seek restart, subtitle timing, growing HLS and startup lifecycle. The `tests/panel-core-*.test.cjs` files and `tests/panel-shell.test.cjs` cover the panel's rules and its page, and `scripts/verify_setup_browser.py` drives both modes in a browser against the demo. Neither a complete movie run nor new control behavior on hardware is certified by preview tests.
