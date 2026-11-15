"""Drive the production panel only through an explicitly labelled memory demo."""
import argparse
import json
from pathlib import Path
import subprocess
from urllib.parse import urlsplit


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url', default='http://127.0.0.1:18778')
parser.add_argument('--out', default='.local/verification/generic-playback/browser')
parser.add_argument('--session', default='stremio-generic-qa')
args = parser.parse_args()
address = urlsplit(args.url)
if (address.scheme != 'http' or address.hostname != '127.0.0.1'
        or address.port in (None, 18766, 18767) or address.path not in ('', '/')):
    parser.error('Use an isolated loopback demo, never the production bridge.')
output = Path(args.out).resolve()
output.mkdir(parents=True, exist_ok=True)
checks = []
failure = None


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


def verify(name, expression):
    result = evaluate(expression)
    if result is not True:
        raise AssertionError(f'{name}: {result!r}')
    checks.append({'name': name, 'result': 'PASS'})


def wait_for(name, expression):
    verify(name, '(async () => { const end=performance.now()+10000; '
           'while(performance.now()<end) { if(await (' + expression + ')) return true; '
           'await new Promise(resolve=>setTimeout(resolve,100)); } return false; })()')


def capture(name):
    for width, height, label in ((1440, 1000, 'desktop'), (390, 844, 'mobile'), (320, 740, 'narrow')):
        browser('set', 'viewport', str(width), str(height))
        evaluate('scrollTo(0,0)')
        verify(f'{name} fits {width}px', 'document.documentElement.scrollWidth <= innerWidth')
        browser('screenshot', 'body', str(output / f'{label}-{name}.png'), '--full')


try:
    browser('--executable-path', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '--headed', 'false', 'open', args.url)
    wait_for('The demo banner becomes visible', '!document.getElementById("demo-banner").hidden')
    verify('The server is a labelled memory-only demo',
           'fetch("/api/status").then(r=>r.json()).then(s=>s.demo === true)')
    wait_for('Device and movie lists load without a discovery click', 'document.querySelectorAll("input[name=device]").length >= 2 && document.querySelectorAll("input[name=source]").length >= 2')
    verify('Setup is in the page without a chooser dialog',
           '!document.getElementById("settings").open && [...document.querySelectorAll("input[name=source],input[name=device]")].every(e=>e.getClientRects().length>0)')
    verify('Initial discovery selects nothing and starts nothing',
           '!document.querySelector("input[name=device]:checked,input[name=source]:checked") && document.getElementById("start").disabled && fetch("/api/status").then(r=>r.json()).then(s=>s.phase === "idle" && !s.selected_device)')
    capture('setup')
    device_id = evaluate('document.querySelector("input[name=device]").value')
    source_id = evaluate('document.querySelector("input[name=source]").value')
    browser('click', f'input[name=device][value={json.dumps(device_id)}]')
    wait_for('The explicit destination selection is confirmed', 'document.querySelector("input[name=device]:checked") !== null')
    browser('click', f'input[name=source][value={json.dumps(source_id)}]')
    wait_for('The chosen movie catalogue becomes ready', '!document.getElementById("start").disabled')
    catalogue = evaluate('fetch("/api/status").then(r=>r.json()).then(s=>s.catalogues[document.querySelector("input[name=source]:checked").value].catalogue)')
    entries = catalogue['entries']
    alternative = next(entry for entry in entries if entry['supported'] and entry.get('language') not in (None, 'und', 'es', 'spa'))
    selector = evaluate(f'(() => {{const id={json.dumps(alternative["id"])}; const e=[...document.querySelectorAll("select")].find(e=>e.getClientRects().length && [...e.options].some(o=>o.value===id)); return e?.id;}})()')
    if not selector:
        raise AssertionError('No native subtitle selector for the chosen movie.')
    verify('No language is forced as the initial subtitle choice',
           f'document.getElementById({json.dumps(selector)}).selectedOptions[0].textContent.includes("Sin subtítulos")')
    verify('Unsupported image tracks cannot be selected',
           f'(() => {{const ids={json.dumps([entry["id"] for entry in entries if not entry["supported"]])}; return ids.length>0 && ids.every(id=>[...document.getElementById({json.dumps(selector)}).options].some(o=>o.value===id && o.disabled));}})()')
    upload_input = evaluate('[...document.querySelectorAll("input[type=file]")].find(e=>e.getClientRects().length)?.id')
    if not upload_input:
        raise AssertionError('No native subtitle upload control in setup.')
    subtitle_file = output / 'browser-qualification.srt'
    subtitle_file.write_text('1\n00:00:01,000 --> 00:00:03,000\nLocal subtitle qualification\n', encoding='utf-8')
    browser('upload', '#' + upload_input, str(subtitle_file))
    wait_for('A local SRT upload becomes a source-bound option',
             'fetch("/api/status").then(r=>r.json()).then(s=>s.catalogues[document.querySelector("input[name=source]:checked").value]?.catalogue?.entries.some(e=>e.kind === "upload"))')
    uploaded = evaluate('fetch("/api/status").then(r=>r.json()).then(s=>s.catalogues[document.querySelector("input[name=source]:checked").value].catalogue.entries.find(e=>e.kind === "upload"))')
    browser('select', '#' + selector, alternative['id'])
    verify('Choosing a subtitle does not start playback',
           'fetch("/api/status").then(r=>r.json()).then(s=>s.phase === "idle")')
    browser('click', '#start')
    wait_for('The chosen movie starts', 'fetch("/api/status").then(r=>r.json()).then(s=>s.phase === "playing")')
    verify('Explicit Start uses the chosen non-Spanish track',
           f'fetch("/api/status").then(r=>r.json()).then(s=>s.subtitle_choice?.subtitle_id === {json.dumps(alternative["id"])})')
    wait_for('The active player is usable', '!document.getElementById("toggle").disabled')
    evaluate('scrollTo(0,0)')
    wait_for('Active transport leads the first viewport instead of the setup form',
             '(() => {const r=document.getElementById("toggle").getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight && document.getElementById("setup").hidden;})()')
    capture('player')
    active_playback = evaluate('fetch("/api/status").then(r=>r.json()).then(s=>({playback_id:s.playback_id,source_id:s.source_id,device_id:s.selected_device.id}))')
    if not evaluate('document.getElementById("discover-devices").getClientRects().length > 0'):
        browser('click', '#choose-device')
    browser('click', '#discover-devices')
    verify('Device refresh leaves playback transport available', '!document.getElementById("toggle").disabled')
    wait_for('Device refresh completes without replacing playback',
             f'fetch("/api/status").then(r=>r.json()).then(s=>s.device_discovery === "ready" && s.phase === "playing" && s.playback_id === {json.dumps(active_playback["playback_id"])} && s.selected_device.id === {json.dumps(device_id)})')
    browser('click', '#toggle')
    wait_for('Pause is confirmed by the backend', 'fetch("/api/status").then(r=>r.json()).then(s=>s.phase === "paused")')
    wait_for('The paused transport is usable', '!document.getElementById("toggle").disabled')
    browser('click', '#open-more')
    browser('fill', '#position', '1:00')
    browser('click', '#seek')
    browser('click', '#exact-apply')
    wait_for('The paused movie seeks to a nonzero position',
             'fetch("/api/status").then(r=>r.json()).then(s=>s.phase === "paused" && s.absolute_time === 60)')
    browser('click', '#close-sheet')
    if not evaluate('document.getElementById("setup").getClientRects().length > 0'):
        browser('click', '#change-source')
    next_source = evaluate(f'[...document.querySelectorAll("input[name=source]")].find(e=>e.value!=={json.dumps(source_id)})?.value')
    browser('click', f'input[name=source][value={json.dumps(next_source)}]')
    wait_for('The next movie draft is ready without replacing the active movie',
             f'fetch("/api/status").then(r=>r.json()).then(s=>s.catalogues[{json.dumps(next_source)}]?.state === "ready" && s.source_id === {json.dumps(source_id)} && s.active_catalogue?.source_id === {json.dumps(source_id)} && s.playback_id === {json.dumps(active_playback["playback_id"])})')
    browser('click', '#open-subtitles')
    verify('Runtime subtitle selection does not open another chooser dialog', '!document.getElementById("settings").open')
    runtime_selector = evaluate(f'(() => {{const id={json.dumps(uploaded["id"])}; return [...document.querySelectorAll("select")].filter(e=>e.getClientRects().length && [...e.options].some(o=>o.value===id)).find(e=>e.id!=={json.dumps(selector)})?.id;}})()')
    if not runtime_selector:
        raise AssertionError('The active subtitle editor cannot select the uploaded file.')
    browser('select', '#' + runtime_selector, uploaded['id'])
    browser('click', '#delay-plus')
    browser('click', '#apply')
    wait_for('An uploaded subtitle applies without resuming paused playback',
             f'fetch("/api/status").then(r=>r.json()).then(s=>s.phase === "paused" && s.absolute_time === 60 && s.playback_id === {json.dumps(active_playback["playback_id"])} && s.source_id === {json.dumps(source_id)} && s.subtitle_choice?.subtitle_id === {json.dumps(uploaded["id"])} && s.subtitle_choice?.delay_ms === 100)')
    wait_for('Positive subtitle timing receives a complete readback', '!document.getElementById("active-subtitle").disabled')
    browser('click', '#delay-minus')
    browser('click', '#delay-minus')
    browser('click', '#apply')
    wait_for('Negative subtitle timing preserves position and pause',
             'fetch("/api/status").then(r=>r.json()).then(s=>s.phase === "paused" && s.absolute_time === 60 && s.subtitle_choice?.delay_ms === -100)')
    wait_for('Negative subtitle timing receives a complete readback', '!document.getElementById("subtitles").disabled')
    browser('uncheck', '#subtitles')
    browser('click', '#apply')
    wait_for('Visibility changes retain the selected track and paused position',
             f'fetch("/api/status").then(r=>r.json()).then(s=>s.phase === "paused" && s.absolute_time === 60 && s.subtitle_choice?.subtitle_id === {json.dumps(uploaded["id"])} && s.subtitle_choice?.enabled === false)')
    wait_for('Visibility receives a complete readback', '!document.getElementById("active-subtitle").disabled')
    none_option = evaluate(f'[...document.getElementById({json.dumps(runtime_selector)}).options].find(o=>o.textContent.includes("Sin subtítulos"))?.value')
    if none_option is None:
        raise AssertionError('The active subtitle editor has no explicit no-subtitle option.')
    browser('select', '#' + runtime_selector, none_option)
    browser('click', '#apply')
    wait_for('No subtitles remains a playable paused choice',
             'fetch("/api/status").then(r=>r.json()).then(s=>s.phase === "paused" && s.subtitle_choice?.subtitle_id === null && s.subtitle_choice?.enabled === false)')
    wait_for('The no-subtitle plan settles in the editor', '!document.getElementById("active-subtitle").disabled && !document.getElementById("toggle").disabled')
    browser('select', '#scenario', 'devices-error')
    wait_for('A discovery failure leaves the owned player usable',
             f'fetch("/api/status").then(r=>r.json()).then(s=>s.device_discovery === "error" && s.phase === "paused" && s.playback_id === {json.dumps(active_playback["playback_id"])} && !document.getElementById("toggle").disabled)')
    if not evaluate('document.getElementById("device-status").getClientRects().length > 0'):
        browser('click', '#choose-device')
    browser('set', 'viewport', '390', '844')
    verify('The discovery error is readable without horizontal overflow',
           'document.getElementById("device-status").getClientRects().length > 0 && document.getElementById("device-status").textContent.length > 0 && document.documentElement.scrollWidth <= innerWidth')
    verify('Discovery uncertainty does not claim the paused TV is disconnected',
           '!/No disponible|desconectad/i.test(document.getElementById("destination-name").textContent)')
    browser('screenshot', 'body', str(output / 'mobile-discovery-error.png'), '--full')
    browser('click', '#discover-devices')
    wait_for('Refresh recovers discovery without changing the chosen TV or movie',
             f'fetch("/api/status").then(r=>r.json()).then(s=>s.device_discovery === "ready" && s.phase === "paused" && s.source_id === {json.dumps(source_id)} && s.selected_device.id === {json.dumps(device_id)})')
    browser('click', '#setup-cancel')
    if not evaluate('document.getElementById("subtitles-panel").getClientRects().length > 0'):
        browser('click', '#open-subtitles')
    verify('The current movie caption editor remains available after closing the next-movie draft',
           'document.getElementById("subtitles-panel").getClientRects().length > 0 && !document.getElementById("active-subtitle").disabled')
    capture('captions')
    browser('set', 'viewport', '390', '844')
    browser('click', '#open-more')
    evaluate('scrollTo(0,0)')
    browser('screenshot', 'body', str(output / 'mobile-more.png'), '--full')
    browser('click', '#stop')
    evaluate('scrollTo(0,0)')
    browser('screenshot', 'body', str(output / 'mobile-stop-confirmation.png'), '--full')
    browser('click', '#confirm-accept')
    wait_for('Confirmed Stop ends only the captured synthetic playback and returns to setup',
             'fetch("/api/status").then(r=>r.json()).then(s=>s.phase === "stopped" && s.playback_id === null && !document.getElementById("setup").hidden)')
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
