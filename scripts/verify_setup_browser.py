"""Drive the production panel (Preparar and Mando) only through an explicitly labelled memory demo."""
import argparse
import json
from pathlib import Path
import subprocess
from urllib.parse import urlsplit


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url', default='http://127.0.0.1:18778')
parser.add_argument('--out', default='.local/verification/generic-playback/browser')
parser.add_argument('--session', default='stremio-generic-qa')
parser.add_argument('--chrome', default='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                    help='Chrome or Chromium executable for agent-browser')
args = parser.parse_args()
address = urlsplit(args.url)
if (address.scheme != 'http' or address.hostname != '127.0.0.1'
        or address.port in (None, 18766, 18767) or address.path not in ('', '/')):
    parser.error('Use an isolated loopback demo, never the production bridge.')
output = Path(args.out).resolve()
output.mkdir(parents=True, exist_ok=True)
checks = []
failure = None
STATUS = 'fetch("/api/status").then(r=>r.json())'
PRELUDE = f'const S=()=>{STATUS};'


def browser(*command):
    if command[0] in ('click', 'fill', 'select', 'upload', 'uncheck', 'check'):
        browser('scrollintoview', command[1])
    process = subprocess.run(
        ['agent-browser', '--session', args.session, '--json', *command],
        capture_output=True, text=True, timeout=40,
    )
    if process.returncode:
        raise RuntimeError(f'Browser command failed: {command[0]}: {process.stderr.strip()}')
    result = json.loads(process.stdout)
    if not result.get('success'):
        raise RuntimeError(f'Browser command failed: {command[0]}: {result.get("error")}')
    return result.get('data', {})


def evaluate(code):
    return browser('eval', code).get('result')


def on_status(condition):
    """A JS expression that holds when `condition` is true of the freshly fetched /api/status as `s`."""
    return f'(((s) => {condition})(await S()))'


def verify(name, expression):
    result = evaluate(f'(async () => {{ {PRELUDE} return !!({expression}); }})()')
    if result is not True:
        raise AssertionError(f'{name}: {result!r}')
    checks.append({'name': name, 'result': 'PASS'})


def wait_for(name, expression):
    result = evaluate(f'(async () => {{ {PRELUDE} const end=performance.now()+10000; '
                      f'while(performance.now()<end) {{ if(await (async () => !!({expression}))()) return true; '
                      'await new Promise(resolve=>setTimeout(resolve,100)); } return false; })()')
    if result is not True:
        raise AssertionError(f'{name}: {result!r}')
    checks.append({'name': name, 'result': 'PASS'})


def capture(name):
    for width, height, label in ((1440, 1000, 'desktop'), (390, 844, 'mobile'), (320, 740, 'narrow')):
        browser('set', 'viewport', str(width), str(height))
        evaluate('scrollTo(0,0)')
        verify(f'{name} fits {width}px', 'document.documentElement.scrollWidth <= innerWidth')
        browser('screenshot', 'body', str(output / f'{label}-{name}.png'), '--full')


def shows(selector):
    return f'(() => {{const e=document.querySelector({json.dumps(selector)}); return !!e && !e.closest("[hidden]") && e.getClientRects().length>0;}})()'


def by_id(element_id):
    return f'document.getElementById({json.dumps(element_id)})'


def drag(value, release):
    """Press the timeline thumb and move it, as a pointer does. `release` lets go: pointerup, then the change it brings."""
    fire = 't.dispatchEvent(new Event("input",{bubbles:true}));'
    if release:
        fire += 't.dispatchEvent(new PointerEvent("pointerup",{bubbles:true})); t.dispatchEvent(new Event("change",{bubbles:true}));'
    return ('(() => {const t=document.getElementById("track"); t.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true})); '
            f'Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(t,{value}); {fire} return true;}})()')


def pressed(selector):
    return f'document.querySelector({json.dumps(selector)})?.getAttribute("aria-pressed") === "true"'


try:
    browser('--executable-path', args.chrome, '--headed', 'false', 'open', args.url)

    wait_for('The demo banner becomes visible', f'!{by_id("demo-banner")}.hidden')
    verify('The server is a labelled memory-only demo', on_status('s.demo === true'))
    wait_for('Preparar lists the TVs and the movies without a discovery click',
             'document.querySelectorAll("#device-list .opt").length >= 2 && document.querySelectorAll("#source-list .opt").length >= 2')
    verify('Preparar is the page and Mando is hidden', f'{shows("#prep")} && !{by_id("mando")}.getClientRects().length')
    verify('Setup is in the page without a chooser dialog',
           f'!{by_id("sheet")}.open && [...document.querySelectorAll("#device-list .opt,#source-list .opt")].every(e=>e.getClientRects().length>0)')
    verify('Initial discovery selects nothing and starts nothing',
           f'{by_id("start")}.disabled && !document.querySelector("#device-list [aria-pressed=true],#source-list [aria-pressed=true]") '
           f'&& {on_status("s.phase === \"idle\" && !s.selected_device")}')
    verify('The stub says what is missing',
           f'{by_id("stub-label")}.textContent === "Falta" && {by_id("stub-value")}.textContent.includes("PELÍCULA")')
    capture('preparar')

    device_id = evaluate('document.querySelector("#device-list .opt").getAttribute("data-key")')
    source_id = evaluate('document.querySelector("#source-list .opt").getAttribute("data-key")')
    browser('click', f'#device-list [data-key={json.dumps(device_id)}]')
    wait_for('The explicit TV choice is confirmed by the server',
             f'{on_status("s.selected_device?.id === " + json.dumps(device_id))} && {pressed("#device-list .opt")}')
    verify('Choosing a TV casts nothing', on_status('s.phase === "idle"'))
    browser('click', f'#source-list [data-key={json.dumps(source_id)}]')
    wait_for('The chosen movie is read and Iniciar names the TV',
             f'!{by_id("start")}.disabled && {by_id("start-label")}.textContent.startsWith("Iniciar en Sala")')
    verify('Three taps are enough and the subtitle decision starts on Sin',
           f'{pressed("#branch-none")} && {by_id("stub-label")}.textContent === "Embarque"')
    verify('The subtitle decision is one choice among Sin, Del archivo, Stremio and Subir',
           '[...document.querySelectorAll("#subs-branches button")].map(b=>b.textContent).join("|") === "Sin|Del archivo|Stremio|Subir"')
    catalogue = evaluate(f'{STATUS}.then(s=>s.catalogues[{json.dumps(source_id)}].catalogue)')
    entries = catalogue['entries']
    alternative = next(entry for entry in entries if entry['supported'] and entry.get('language') not in (None, 'und', 'es', 'spa'))

    browser('click', '#branch-file')
    wait_for('Del archivo lists the embedded tracks', f'document.querySelectorAll("#file-entries .opt").length === {len(entries)}')
    verify('No language is forced as the initial subtitle choice',
           f'{pressed("#branch-file")} && !document.querySelector("#file-entries [aria-pressed=true]")')
    unsupported = json.dumps([entry['id'] for entry in entries if not entry['supported']])
    verify('Unsupported image tracks cannot be selected',
           f'(() => {{const ids={unsupported}; return ids.length>0 && ids.every(id=>document.querySelector(`#file-entries [data-key="${{id}}"]`).disabled);}})()')
    browser('click', '#branch-stremio')
    verify('The Stremio branch opens its own block', shows('#stremio'))
    browser('click', '#branch-upload')
    verify('The upload branch offers an SRT or VTT picker', shows('#upload-label'))
    subtitle_file = output / 'browser-qualification.srt'
    subtitle_file.write_text('1\n00:00:01,000 --> 00:00:03,000\nLocal subtitle qualification\n', encoding='utf-8')
    browser('upload', '#upload-input', str(subtitle_file))
    wait_for('A local SRT upload becomes a source-bound option',
             on_status(f's.catalogues[{json.dumps(source_id)}]?.catalogue?.entries.some(e=>e.kind === "upload")'))
    uploaded = evaluate(f'{STATUS}.then(s=>s.catalogues[{json.dumps(source_id)}].catalogue.entries.find(e=>e.kind === "upload"))')
    verify('The upload is the chosen subtitle and Iniciar is still enabled', f'{pressed("#branch-upload")} && !{by_id("start")}.disabled')
    browser('click', '#branch-file')
    browser('click', f'#file-entries [data-key={json.dumps(alternative["id"])}]')
    verify('Choosing a subtitle does not start playback', on_status('s.phase === "idle"'))
    browser('click', '#start')
    wait_for('The chosen movie starts', on_status('s.phase === "playing"'))
    verify('Explicit Iniciar uses the chosen non-Spanish track', on_status(f's.subtitle_choice?.subtitle_id === {json.dumps(alternative["id"])}'))

    wait_for('Mando replaces Preparar and the remote is usable',
             f'{shows("#mando")} && !{by_id("prep")}.getClientRects().length && !{by_id("toggle")}.disabled')
    browser('set', 'viewport', '390', '844')
    evaluate('scrollTo(0,0)')
    wait_for('Mando is one screen tall and the remote sits inside it',
             '(() => {const m=document.getElementById("mando").getBoundingClientRect(), t=document.getElementById("toggle").getBoundingClientRect(); '
             'return m.height <= innerHeight + 1 && t.top >= m.top && t.bottom <= m.bottom + 1;})()')
    verify('The board names the movie, the state and the room',
           f'{by_id("board-title")}.textContent.includes("La noche del faro") && {by_id("board-state-text")}.textContent === "REPRODUCIENDO" '
           f'&& {by_id("board-state")}.dataset.glyph === "play" && {by_id("board-room")}.textContent.startsWith("Sala")')
    capture('mando')
    active = evaluate(f'{STATUS}.then(s=>({{playback_id:s.playback_id,source_id:s.source_id,device_id:s.selected_device.id}}))')

    browser('click', '#toggle')
    wait_for('Pause is confirmed by the backend', on_status('s.phase === "paused"'))
    wait_for('The paused transport is usable and the board says so',
             f'!{by_id("toggle")}.disabled && {by_id("board-state-text")}.textContent === "EN PAUSA" && {by_id("board-state")}.dataset.glyph === "pause"')

    evaluate(drag(1200, release=False))
    verify('Dragging the timeline only previews the target',
           f'{shows("#track-preview")} && {by_id("track-preview")}.textContent.includes("20:00")')
    evaluate('new Promise(resolve=>setTimeout(resolve,900))')
    verify('A drag that is not released sends no seek', on_status('s.absolute_time === 0'))
    browser('press', 'Escape')
    verify('Escape abandons the drag and the TV position stays',
           f'!{by_id("track-preview")}.getClientRects().length && {on_status("s.absolute_time === 0")}')
    evaluate(drag(1800, release=True))
    wait_for('Releasing the timeline seeks and keeps the pause', on_status('s.phase === "paused" && s.absolute_time === 1800'))
    wait_for('The seek settles and the transport is usable again', f'!{by_id("toggle")}.disabled && !{by_id("track-hint")}.textContent')

    evaluate('(() => {const b=document.getElementById("forward"); b.click(); b.click(); return true;})()')
    verify('Two taps on +30 s add up in the badge before any seek is sent', f'{by_id("skip-badge")}.textContent === "+60 s" && {on_status("s.absolute_time === 1800")}')
    wait_for('One seek of +60 s follows the last tap', on_status('s.phase === "paused" && s.absolute_time === 1860'))
    wait_for('The skip settles', f'!{by_id("toggle")}.disabled && {by_id("skip-badge")}.hidden')
    browser('click', '#back')
    wait_for('A single -30 s skip seeks back', on_status('s.phase === "paused" && s.absolute_time === 1830'))
    wait_for('The skip settles again', f'!{by_id("toggle")}.disabled && {by_id("skip-badge")}.hidden')

    browser('click', '#open-subs')
    wait_for('The subtitle sheet opens', f'{by_id("sheet")}.open && !{by_id("sheet-subs")}.hidden')
    browser('click', f'#cap-tracks [data-key={json.dumps(uploaded["id"])}]')
    browser('click', '#cap-p100')
    verify('A subtitle edit is a draft until Aplicar',
           f'!{by_id("cap-apply")}.disabled && {by_id("cap-sync")}.dataset.unapplied === "true" '
           f'&& {on_status("s.subtitle_choice?.subtitle_id === " + json.dumps(alternative["id"]) + " && s.subtitle_choice?.delay_ms === 0")}')
    browser('click', '#cap-discard')
    wait_for('Cancelar closes the sheet and throws the draft away',
             f'!{by_id("sheet")}.open && {by_id("open-subs")}.dataset.unapplied !== "true" '
             f'&& {on_status("s.subtitle_choice?.subtitle_id === " + json.dumps(alternative["id"]) + " && s.subtitle_choice?.delay_ms === 0")}')
    browser('click', '#open-subs')
    wait_for('The sheet reopens on what the TV has', f'{by_id("sheet")}.open && {by_id("cap-apply")}.disabled && {by_id("cap-delay")}.textContent === "+0,0 s"')
    browser('click', f'#cap-tracks [data-key={json.dumps(uploaded["id"])}]')
    browser('click', '#cap-p100')
    browser('click', '#cap-apply')
    wait_for('An uploaded subtitle applies without resuming paused playback',
             on_status(f's.phase === "paused" && s.absolute_time === 1830 && s.playback_id === {json.dumps(active["playback_id"])} '
                       f'&& s.source_id === {json.dumps(source_id)} && s.subtitle_choice?.subtitle_id === {json.dumps(uploaded["id"])} && s.subtitle_choice?.delay_ms === 100'))
    wait_for('A confirmed Aplicar closes the sheet and the chip shows the new timing',
             f'!{by_id("sheet")}.open && {by_id("chip-value")}.textContent.endsWith("+0,1 s") && {by_id("open-subs")}.dataset.unapplied !== "true"')
    browser('click', '#open-subs')
    wait_for('The sheet reopens on the applied timing', f'{by_id("sheet")}.open && {by_id("cap-delay")}.textContent === "+0,1 s"')
    browser('click', '#cap-m100')
    browser('click', '#cap-m100')
    browser('click', '#cap-apply')
    wait_for('Negative subtitle timing preserves position and pause',
             on_status('s.phase === "paused" && s.absolute_time === 1830 && s.subtitle_choice?.delay_ms === -100'))
    wait_for('The negative timing is confirmed and the sheet closes', f'!{by_id("sheet")}.open && {by_id("chip-value")}.textContent.endsWith("−0,1 s")')
    browser('click', '#open-subs')
    wait_for('The sheet reopens on the negative timing', f'{by_id("sheet")}.open && {by_id("cap-delay")}.textContent === "−0,1 s"')
    browser('click', '#cap-visible')
    wait_for('Hiding the subtitles applies at once and keeps the track and the paused position',
             on_status(f's.phase === "paused" && s.absolute_time === 1830 && s.subtitle_choice?.subtitle_id === {json.dumps(uploaded["id"])} && s.subtitle_choice?.enabled === false'))
    wait_for('Hiding does not close the sheet and the switch reads off', f'{by_id("sheet")}.open && !{by_id("cap-visible")}.checked')
    browser('set', 'viewport', '390', '844')
    browser('screenshot', str(output / 'mobile-captions-sheet.png'))
    browser('click', '#cap-tracks [data-key=""]')
    browser('click', '#cap-apply')
    wait_for('Sin subtítulos remains a playable paused choice', on_status('s.phase === "paused" && s.subtitle_choice?.subtitle_id === null'))
    wait_for('The sheet closes and the chip names the choice',
             f'!{by_id("sheet")}.open && {by_id("chip-value")}.textContent.startsWith("Sin subtítulos")')
    capture('captions')

    browser('click', '#open-more')
    wait_for('The Más sheet opens', f'{by_id("sheet")}.open && !{by_id("sheet-more")}.hidden')
    browser('fill', '#exact', '25:00')
    browser('click', '#exact-go')
    wait_for('An exact time seeks the paused movie', on_status('s.phase === "paused" && s.absolute_time === 1500'))
    wait_for('The exact time closes the sheet', f'!{by_id("sheet")}.open')
    browser('click', '#open-more')
    browser('click', '#details > summary')
    verify('Detalles names the file and the prepared range',
           f'{by_id("detail-file")}.textContent.includes("La.noche.del.faro") && {by_id("detail-prepared")}.textContent.startsWith("De ")')
    browser('set', 'viewport', '390', '844')
    browser('screenshot', str(output / 'mobile-more.png'))
    browser('click', '#sheet-close')

    browser('click', '#open-change')
    wait_for('Cambiar película opens the plan in a sheet', f'{by_id("sheet")}.open && {by_id("plan")}.parentNode.id === "sheet-change-slot"')
    next_source = evaluate(f'[...document.querySelectorAll("#source-list .opt")].find(e=>e.getAttribute("data-key")!=={json.dumps(source_id)})?.getAttribute("data-key")')
    browser('click', f'#source-list [data-key={json.dumps(next_source)}]')
    wait_for('The next movie is ready without replacing the active one',
             f'!{by_id("change-start")}.disabled && {on_status("s.source_id === " + json.dumps(source_id) + " && s.playback_id === " + json.dumps(active["playback_id"]))}')
    browser('click', '#change-start')
    wait_for('Replacing the movie asks for confirmation', by_id('confirm') + '.open')
    browser('click', '#confirm-cancel')
    verify('Volver leaves the active movie alone',
           f'!{by_id("confirm")}.open && {on_status("s.source_id === " + json.dumps(source_id) + " && s.playback_id === " + json.dumps(active["playback_id"]))}')
    browser('click', '#sheet-close')

    browser('click', '#stop')
    wait_for('Detener asks first', f'{by_id("confirm")}.open && {by_id("confirm-title")}.textContent.includes("Detener")')
    verify('The TV keeps playing until the user confirms', on_status(f's.phase === "paused" && s.playback_id === {json.dumps(active["playback_id"])}'))
    browser('set', 'viewport', '390', '844')
    browser('screenshot', str(output / 'mobile-stop-confirmation.png'))
    browser('click', '#confirm-cancel')
    verify('Seguir viendo keeps the movie', f'!{by_id("confirm")}.open && {on_status("s.phase === \"paused\"")}')
    browser('click', '#stop')
    browser('click', '#confirm-accept')
    wait_for('Confirmed Detener ends only the synthetic playback and returns to Preparar with the plan kept',
             f'{on_status("s.phase === \"stopped\" && s.playback_id === null")} && {shows("#prep")} && !{by_id("mando")}.getClientRects().length '
             f'&& document.querySelector("#device-list [aria-pressed=true]")?.getAttribute("data-key") === {json.dumps(device_id)} && {pressed("#branch-none")}')
    verify('A dismissible line says where the movie stopped',
           f'{by_id("problem-title")}.textContent.startsWith("Película detenida en Sala") && !{by_id("problem-action")}.hidden')
    capture('stopped')

    browser('select', '#scenario', 'error')
    wait_for('The error scenario puts the remote on the page with its problem block', f'{shows("#mando")} && {shows("#problem")}')
    verify('The error offers Detener once, in the problem block and not in the header',
           '[...document.querySelectorAll("[data-act=stop]")].filter(e=>e.getClientRects().length>0).map(e=>e.id).join() === "problem-action"')
    capture('error')
    browser('click', '#problem-action')
    wait_for('Detener from the problem block returns to Preparar', f'{on_status("s.phase === \"stopped\"")} && {shows("#prep")}')

    browser('select', '#scenario', 'devices-error')
    wait_for('A discovery failure is readable and does not call the TV disconnected',
             f'{on_status("s.device_discovery === \"error\"")} && {by_id("device-status")}.textContent.length > 0 '
             f'&& !/desconectad/i.test({by_id("device-name")}.textContent + {by_id("device-note")}.textContent)')
    browser('set', 'viewport', '390', '844')
    verify('The discovery error fits without horizontal overflow', 'document.documentElement.scrollWidth <= innerWidth')
    browser('screenshot', 'body', str(output / 'mobile-discovery-error.png'), '--full')
    browser('click', '#refresh-devices')
    wait_for('Actualizar recovers discovery', on_status('s.device_discovery === "ready"'))

    errors = browser('errors')
    if errors.get('errors'):
        raise AssertionError('The browser reported JavaScript errors.')
except Exception as error:
    checks.append({'name': str(error), 'result': 'FAIL'})
    failure = error
finally:
    try:
        browser('close')
        checks.append({'name': 'The owned browser session closes', 'result': 'PASS'})
    except Exception as error:
        checks.append({'name': f'Browser cleanup failed: {error}', 'result': 'FAIL'})
        if failure is None:
            failure = error
    report = {'result': 'FAIL' if failure else 'PASS', 'checks': checks, 'screenshots': str(output)}
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
if failure:
    raise SystemExit(1)
