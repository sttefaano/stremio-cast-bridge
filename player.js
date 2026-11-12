function formatTime(value) {
  if (!Number.isFinite(value)) return '—';
  const n = Math.max(0, Math.floor(value)), h = Math.floor(n / 3600);
  return `${h ? h + ':' + String(Math.floor(n / 60) % 60).padStart(2,'0') : Math.floor(n / 60)}:${String(n % 60).padStart(2,'0')}`;
}
function parseTime(value) {
  if (!/^\d{1,3}:\d{2}(:\d{2})?$/.test(value.trim())) return null;
  const parts = value.trim().split(':').map(Number);
  if (parts.slice(1).some(n => n >= 60)) return null;
  return parts.reduce((a,n) => a * 60 + n,0);
}
function shortcut(e) {
  if (e.target?.id !== 'remote' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || e.target?.isContentEditable) return null;
  return ({' ':'toggle',ArrowLeft:'back',ArrowRight:'forward'})[e.key] || null;
}
if (typeof module !== 'undefined') module.exports = {formatTime,parseTime,shortcut};
if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  let state = {}, online = false, inFlight = false, generation = 0, pollPromise = null;
  let selectedId = '', sourceSignature = '', playingSource = null, deviceSignature = '';
  let setup = {epoch:0,catalogue:null,analysis:null,subtitleId:null,request:0,loading:false,error:'',upload:0,uploading:false,uploadMessage:'',uploadFilename:''};
  const view = {setup:false,captions:false};
  const metadata = {discover:false,discover_devices:false};
  const metadataErrors = {discover:'',discover_devices:''};
  let seekDraft = null, exactDraft = null, seekTarget = null;
  let captionDraft = {catalogueId:null,subtitleId:null,enabled:null,delay:null}, dirtyCaption = false, captionApply = null;
  let dismissedBackendError = null, observedBackendError = null, visibleError = '', focusTicket = null, interaction = 0;
  let sheetPanel = null, returnFocus = null, confirmation = null, startTicket = null;
  const KIND_LABEL = {upload:'Archivo local',addon:'Stremio'};
  const ADDON_LOADING = 'Buscando subtítulos de Stremio…', ADDON_ERROR = 'No se pudieron buscar subtítulos de Stremio. Las pistas y los archivos locales siguen disponibles.';
  const errorIdentity = s => s.action_error ? `${s.action_error_revision || 0}:${s.action_error}` : null;
  const busy = () => inFlight || !!state.command_pending || !!state.pending || ['preparing','buffering','loading'].includes(state.phase);
  const active = () => online && ['playing','paused'].includes(state.phase) && !busy();
  const foreign = () => ['receiver_changed','foreign','disconnected'].includes(state.phase);
  const canStart = () => online && !busy() && !foreign() && state.selected_device?.available === true && state.device_discovery !== 'error' && state.source_discovery !== 'error';
  const samePlan = (sourceId,catalogueId,subtitleId) => sourceId === state.source_id && catalogueId === state.subtitle_choice?.catalogue_id && subtitleId === state.subtitle_choice?.subtitle_id && (state.subtitle_choice?.delay_ms ?? 0) === 0 && state.subtitle_choice?.enabled === (subtitleId !== null) && ['playing','paused'].includes(state.phase);
  const canStop = () => online && (state.can_change_device === false || busy() || ['playing','paused','preparing','buffering','loading','receiver_changed','foreign','disconnected','error'].includes(state.phase));
  const signed = n => Number.isFinite(n) ? `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(1).replace('.',',')} s` : '—';
  function icon(id,kind) { $(id).innerHTML = `<svg aria-hidden="true"><use href="#i-${kind}"/></svg>`; }
  function awaitingControlFocus(e) {
    return focusTicket && focusTicket.interaction === interaction &&
      (!document.activeElement || document.activeElement === document.body) &&
      /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(focusTicket.element.tagName) &&
      ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End',' '].includes(e.key);
  }
  for (const type of ['pointerdown','keydown','focusin']) document.addEventListener(type,e => {
    if (type !== 'keydown' || !awaitingControlFocus(e)) interaction++;
  });
  function showError(message) {
    visibleError = message;
    for (const prefix of ['','sheet-']) { $(prefix+'error-text').textContent = message; $(prefix+'error').hidden = !message; }
  }
  function dismissError() { dismissedBackendError = errorIdentity(state); showError(''); }
  $('dismiss').onclick = dismissError; $('sheet-dismiss').onclick = dismissError;
  async function request(path,options = {}) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(),6000);
    try {
      const response = await fetch(path,{...options,signal:controller.signal}), body = await response.json();
      if (!response.ok) throw Object.assign(Error(typeof body.message === 'string' ? body.message : 'No se pudo completar la acción. Revisá el estado y reintentá.'),{code:body.code});
      return body;
    } finally { clearTimeout(timeout); }
  }
  const post = (action,data) => request('/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Token':token},body:JSON.stringify(data)});
  function abandonSetup() {
    startTicket = null; selectedId = '';
    setup = {epoch:setup.epoch+1,catalogue:null,analysis:null,subtitleId:null,request:setup.request+1,loading:false,error:'',upload:setup.upload+1,uploading:false,uploadMessage:'',uploadFilename:''};
    $('subtitle-file').value = ''; render(state);
  }
  function chooseSource(id) {
    abandonSetup(); selectedId = id;
    const cached = state.catalogues?.[id];
    if (cached?.state === 'ready') setup.catalogue = cached.catalogue;
    render(state); requestCatalogue(false);
  }
  async function refresh(action) {
    if (!online || metadata[action] || $(action === 'discover' ? 'discover' : 'discover-devices').disabled) return;
    metadata[action] = true; metadataErrors[action] = ''; render(state);
    try { await post(action,{}); await poll(); }
    catch (e) { metadataErrors[action] = e.message; }
    finally { metadata[action] = false; render(state); }
  }
  async function requestCatalogue(refresh) {
    if (!online || !selectedId || setup.loading) return;
    const source = selectedId, epoch = setup.epoch, ticket = ++setup.request;
    setup.upload++; setup.uploading = false; setup.uploadMessage = ''; setup.ignoreSnapshot = null;
    setup.loading = refresh || !setup.catalogue; setup.analysis = null; setup.previousId = setup.catalogue?.id; setup.error = ''; render(state);
    try {
      const result = await post('catalogue',{source_id:source,refresh});
      if (epoch !== setup.epoch || ticket !== setup.request || source !== selectedId) return;
      if (result.catalogue) { acceptCatalogue(result.catalogue); setup.loading = false; setup.ignoreSnapshot = JSON.stringify(state.catalogues?.[source]); }
      else setup.analysis = result.analysis_id;
    } catch (e) {
      if (epoch !== setup.epoch || ticket !== setup.request) return;
      setup.loading = false; setup.error = e.message; setup.ignoreSnapshot = JSON.stringify(state.catalogues?.[source]);
    }
    render(state);
  }
  const addonRevision = catalogue => catalogue?.addon?.revision ?? 0;
  function acceptCatalogue(catalogue) {
    if (!catalogue || catalogue.source_id !== selectedId) return;
    if (setup.catalogue?.id === catalogue.id && (catalogue.entries.length < setup.catalogue.entries.length || addonRevision(catalogue) < addonRevision(setup.catalogue))) return;
    if (setup.catalogue?.id !== catalogue.id) { setup.subtitleId = null; setup.upload++; setup.uploading = false; setup.uploadMessage = ''; startTicket = null; }
    setup.catalogue = catalogue;
  }
  function subtitleOptions(element,catalogue,value) {
    const signature = JSON.stringify(catalogue?.entries || []);
    if (element.catalogueSignature !== signature) {
      element.catalogueSignature = signature; element.replaceChildren();
      const none = document.createElement('option'); none.value = ''; none.textContent = 'Sin subtítulos'; element.append(none);
      for (const entry of catalogue?.entries || []) {
        const option = document.createElement('option'); option.value = entry.id; option.disabled = entry.supported !== true;
        option.textContent = [entry.label || 'Pista sin nombre',entry.language,KIND_LABEL[entry.kind],entry.supported !== true ? entry.reason || 'Formato no compatible' : null].filter(Boolean).join(' · ');
        element.append(option);
      }
    }
    element.value = value || '';
  }
  function renderSetup() {
    const snapshot = state.catalogues?.[selectedId];
    if (snapshot && JSON.stringify(snapshot) !== setup.ignoreSnapshot && (!setup.loading || setup.analysis && (setup.analysis === snapshot.analysis_id || snapshot.state === 'ready' && snapshot.catalogue?.id !== setup.previousId))) {
      if (snapshot.state === 'ready') {
        const catalogue = snapshot.catalogue;
        acceptCatalogue(catalogue);
        setup.loading = false; setup.error = '';
      } else if (snapshot.state === 'error') { setup.loading = false; setup.error = snapshot.message; }
    }
    const catalogue = setup.catalogue, selected = (state.sources || []).find(s => s.id === selectedId);
    const replacing = !$('remote').hidden && !!state.title;
    $('setup-title').textContent = replacing ? 'Elegir otra película' : 'Elegí qué ver en la TV.';
    $('setup-intro').textContent = replacing ? 'La película actual sigue en la TV. Solo Cambiar película en la TV la reemplaza.' : 'Elegí una película y un destino. Solo Iniciar en la TV envía la película.';
    $('setup-subtitles').hidden = !selected; $('start-review').hidden = !selected;
    $('setup-subtitles-heading').textContent = selected ? `Subtítulos para ${selected.title || 'la película elegida'}` : 'Subtítulos para la película elegida';
    subtitleOptions($('setup-subtitle'),catalogue,setup.subtitleId);
    $('setup-subtitle').disabled = !online || !catalogue || setup.loading;
    $('refresh-catalogue').disabled = !online || !selected || setup.loading;
    $('subtitle-file').disabled = !online || !catalogue || setup.loading || setup.uploading || setupAddon.fetching;
    $('catalogue-status').textContent = setup.error || (setup.loading ? 'Consultando pistas de esta película…' : catalogue ? catalogue.entries?.length ? 'Elegí cualquier idioma o continuá sin subtítulos. Las pistas de imagen no son compatibles.' : 'No hay pistas de texto. Podés subir un archivo o continuar sin subtítulos.' : 'Elegí una película para consultar sus pistas.');
    $('upload-status').textContent = setup.uploading ? 'Validando y subiendo el archivo…' : setup.uploadMessage;
    $('upload-action').textContent = setup.uploading ? 'Subiendo archivo…' : 'Subir archivo SRT / VTT';
    $('upload-filename').textContent = setup.uploadFilename ? `Archivo: ${setup.uploadFilename}` : 'Sin archivo elegido';
    const entry = catalogue?.entries?.find(e => e.id === setup.subtitleId);
    $('setup-summary').textContent = selected?.title || '';
    $('setup-choice').textContent = entry ? [entry.label,entry.language].filter(Boolean).join(' · ') : 'Sin subtítulos';
    const duplicate = samePlan(selectedId,catalogue?.id,setup.subtitleId);
    $('start').disabled = !canStart() || !selected || !catalogue || setup.loading || setup.uploading || setupAddon.fetching || !!setup.error || duplicate || !!(setup.subtitleId && entry?.supported !== true);
    $('start').textContent = duplicate ? 'Ya está en la TV' : replacing ? 'Cambiar película en la TV' : 'Iniciar en la TV';
    $('setup').hidden = !$('remote').hidden && !view.setup;
    setupAddon.render();
    for (const id of ['change-source','choose-film','choose-device']) { $(id).setAttribute('aria-controls','setup'); $(id).setAttribute('aria-expanded',String(!$('setup').hidden)); }
  }
  $('setup-subtitle').onchange = () => {
    if ($('setup-subtitle').disabled) return;
    const id = $('setup-subtitle').value || null;
    if (id && !setup.catalogue?.entries.some(e => e.id === id && e.supported === true)) return;
    startTicket = null; setup.upload++; setup.uploading = false; setup.uploadMessage = ''; setup.subtitleId = id; render(state);
  };
  $('refresh-catalogue').onclick = () => { if (!$('refresh-catalogue').disabled) requestCatalogue(true); };
  $('subtitle-file').onchange = async () => {
    if ($('subtitle-file').disabled) return;
    const file = $('subtitle-file').files?.[0]; if (!file) return;
    const source = selectedId, catalogue = setup.catalogue?.id, epoch = setup.epoch, catalogueRequest = setup.request, ticket = ++setup.upload;
    const current = () => epoch === setup.epoch && source === selectedId && catalogue === setup.catalogue?.id && catalogueRequest === setup.request && ticket === setup.upload;
    const filename = file.name.split(/[\\/]/).pop();
    setup.uploading = true; setup.uploadMessage = ''; setup.uploadFilename = filename; startTicket = null; render(state);
    try {
      const format = /\.(srt|vtt)$/i.exec(file.name)?.[1].toLowerCase();
      if (!format) throw Error('Elegí un archivo .srt o .vtt en UTF-8.');
      if (file.size > 1024*1024) throw Error('El archivo supera 1 MiB. Elegí uno más pequeño.');
      const bytes = await file.arrayBuffer();
      if (!current()) return;
      if (bytes.byteLength > 1024*1024) throw Error('El archivo supera 1 MiB.');
      let text;
      try { text = new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
      catch (_) { throw Error('El archivo no es UTF-8 válido. Guardalo como UTF-8 y reintentá.'); }
      const result = await post('subtitle_upload',{source_id:source,catalogue_id:catalogue,filename,format,text});
      if (!current()) return;
      if (result.catalogue?.id !== catalogue || result.catalogue?.source_id !== source || result.entry?.supported !== true || !result.catalogue.entries?.some(e => e.id === result.entry.id && e.supported === true)) throw Error('La lista de pistas cambió. Actualizala antes de subir el archivo otra vez.');
      acceptCatalogue(result.catalogue); setup.subtitleId = result.entry.id; setup.uploadMessage = `Archivo listo: ${filename}. Se usará solo al iniciar.`;
    } catch (e) { if (current()) setup.uploadMessage = e.message; }
    finally { if (current()) { setup.uploading = false; $('subtitle-file').value = ''; render(state); } }
  };
  function addonPanel(prefix,ctx) {
    const part = name => $(`${prefix}-${name}`);
    const panel = {listing:null,listingKey:'',pulling:'',pullFailed:'',pullTicket:0,language:'',offerId:'',correction:false,fetching:false,looking:false,message:null,lastHint:null,unreadable:new Set()};
    const keyOf = catalogue => catalogue?.addon ? `${catalogue.id}:${catalogue.addon.revision}` : '';
    const say = (catalogue,text) => { panel.message = text ? {text,key:keyOf(catalogue)} : null; };
    const failure = e => e.name === 'AbortError' ? 'La consulta tardó demasiado. Reintentá.' : e.message;
    const offersOf = () => { const catalogue = ctx.catalogue(); return catalogue?.addon && panel.listingKey === keyOf(catalogue) && panel.listing?.revision === catalogue.addon.revision ? panel.listing : null; };
    async function pull(catalogue) {
      const key = keyOf(catalogue), ticket = ++panel.pullTicket; panel.pulling = key;
      try {
        const listing = await post('subtitle_offers',{source_id:catalogue.source_id,catalogue_id:catalogue.id});
        if (ticket !== panel.pullTicket) return;
        panel.listing = listing; panel.listingKey = key; panel.pullFailed = '';
      } catch (_) { if (ticket === panel.pullTicket) panel.pullFailed = key; }
      finally { if (ticket === panel.pullTicket) { panel.pulling = ''; render(state); } }
    }
    function fill(select,pairs,value) {
      const signature = JSON.stringify(pairs);
      if (select.pairsSignature !== signature) {
        select.pairsSignature = signature; select.replaceChildren();
        for (const [id,text] of pairs) { const option = document.createElement('option'); option.value = id; option.textContent = text; select.append(option); }
      }
      select.value = value;
    }
    function alternatives(list,enabled) {
      const container = part('alternatives'), signature = JSON.stringify(list);
      if (container.listSignature !== signature) {
        container.listSignature = signature; container.replaceChildren(); container.buttons = [];
        for (const candidate of list.slice(0,4)) {
          const button = document.createElement('button'); button.type = 'button';
          button.textContent = candidate.year ? `${candidate.title} (${candidate.year})` : candidate.title;
          button.onclick = () => { if (!button.disabled) lookup(`${candidate.id} ${candidate.title} ${candidate.year ?? ''}`.trim().slice(0,200)); };
          container.append(button); container.buttons.push(button);
        }
      }
      for (const button of container.buttons) button.disabled = !enabled;
    }
    function show() {
      const catalogue = ctx.catalogue(), addon = catalogue?.addon;
      $(prefix).hidden = !addon || addon.state === 'off'; if ($(prefix).hidden) return;
      const key = keyOf(catalogue), listable = addon.state === 'ready' || addon.state === 'unidentified';
      if (listable && ctx.shown() && panel.listingKey !== key && panel.pulling !== key && panel.pullFailed !== key) pull(catalogue);
      const listing = listable ? offersOf() : null, offers = listing?.offers || [], enabled = ctx.canAct() && !panel.fetching && !panel.looking;
      const pullFailed = listable && panel.pullFailed === key, unidentified = addon.state === 'unidentified';
      part('match').hidden = !addon.match;
      part('match').textContent = addon.match ? addon.match.confidence === 'doubtful' ? `Coincidencia dudosa: ¿${addon.match.label}?` : `Coincidencia: ${addon.match.label}` : '';
      const languages = [];
      for (const offer of offers) { const found = languages.find(l => l.code === offer.language); if (found) found.count++; else languages.push({code:offer.language,name:offer.language_name,count:1}); }
      if (!languages.some(l => l.code === panel.language)) panel.language = languages[0]?.code || '';
      const versions = offers.filter(o => o.language === panel.language);
      if (!versions.some(o => o.id === panel.offerId)) panel.offerId = versions[0]?.id || '';
      const picking = addon.state === 'ready' && versions.length > 0;
      part('picker').hidden = !picking;
      fill(part('language'),languages.map(l => [l.code,`${l.name} · ${l.count}`]),panel.language);
      fill(part('version'),versions.map(o => [o.id,[o.label,o.note].filter(Boolean).join(' · ') + (panel.unreadable.has(o.id) ? ' · no se pudo leer' : '')]),panel.offerId);
      part('language').disabled = part('version').disabled = !enabled;
      part('use').hidden = !picking; part('use').disabled = !enabled || !panel.offerId; part('use').textContent = panel.fetching ? 'Descargando…' : 'Usar este subtítulo';
      part('retry').hidden = !(addon.state === 'error' || pullFailed); part('retry').disabled = !enabled;
      part('wrong').hidden = addon.state !== 'ready'; part('wrong').disabled = !enabled;
      const open = unidentified || addon.state === 'ready' && panel.correction;
      part('wrong').setAttribute('aria-expanded',String(open)); part('correction').hidden = !open;
      alternatives(listing?.alternatives || [],enabled);
      part('hint').disabled = part('search').disabled = !enabled;
      const status = panel.message?.key === key ? panel.message.text : pullFailed ? ADDON_ERROR : addon.state === 'ready' ? addon.count === 0 ? `Stremio no tiene subtítulos para ${addon.match?.label || 'esta película'}.` : listing ? '' : ADDON_LOADING : addon.message || '';
      part('status').textContent = status; part('status').hidden = !status;
    }
    async function lookup(hint) {
      const catalogue = ctx.catalogue();
      if (!catalogue || panel.fetching || panel.looking || !ctx.canAct()) return;
      const current = ctx.guard(false); panel.looking = true; panel.lastHint = hint; say(catalogue,''); render(state);
      try {
        const result = await post('subtitle_lookup',{source_id:catalogue.source_id,catalogue_id:catalogue.id,hint});
        if (!current()) return;
        ctx.accept(result.catalogue,null); panel.correction = false; part('hint').value = '';
      } catch (e) { if (current()) say(ctx.catalogue(),failure(e)); }
      finally { panel.looking = false; render(state); }
    }
    async function use() {
      const catalogue = ctx.catalogue(), offer = offersOf()?.offers.find(o => o.id === panel.offerId);
      if (!catalogue || !offer || panel.fetching || panel.looking || !ctx.canAct()) return;
      const current = ctx.guard(true); panel.fetching = true; say(catalogue,''); render(state);
      try {
        const result = await post('subtitle_fetch',{source_id:catalogue.source_id,catalogue_id:catalogue.id,offer_id:offer.id});
        if (!current()) return;
        if (result.catalogue?.id !== catalogue.id || result.catalogue?.source_id !== catalogue.source_id || result.entry?.supported !== true || !result.catalogue.entries?.some(e => e.id === result.entry.id && e.supported === true)) throw Error('La lista de pistas cambió. Actualizala y probá otra vez.');
        ctx.accept(result.catalogue,result.entry); say(ctx.catalogue(),`Subtítulo listo: ${result.entry.label}. ${ctx.when}`);
      } catch (e) { if (current()) { if (e.code === 'invalid_subtitle') panel.unreadable.add(offer.id); say(ctx.catalogue(),failure(e)); } }
      finally { panel.fetching = false; render(state); }
    }
    part('language').onchange = () => { if (!part('language').disabled) { panel.language = part('language').value; panel.offerId = ''; render(state); } };
    part('version').onchange = () => { if (!part('version').disabled) { panel.offerId = part('version').value; render(state); } };
    part('use').onclick = use;
    part('retry').onclick = () => { if (!part('retry').disabled) lookup(panel.lastHint); };
    part('wrong').onclick = () => { if (part('wrong').disabled) return; panel.correction = !panel.correction; render(state); if (panel.correction) part('hint').focus(); };
    part('form').onsubmit = e => {
      e.preventDefault(); const hint = part('hint').value.trim();
      if (part('search').disabled || !hint) return;
      if (hint.length > 200) { say(ctx.catalogue(),'Escribí un título de hasta 200 caracteres.'); render(state); return; }
      lookup(hint);
    };
    return {render:show,get fetching() { return panel.fetching; }};
  }
  const setupAddon = addonPanel('setup-addon',{
    when:'Se usará solo al iniciar.',
    catalogue:() => setup.catalogue,
    shown:() => !$('setup').hidden && !$('setup-subtitles').hidden,
    canAct:() => online && !setup.loading && !setup.uploading && !!setup.catalogue,
    guard:strong => {
      const epoch = setup.epoch, source = selectedId, id = setup.catalogue?.id, request = setup.request, ticket = strong ? ++setup.upload : setup.upload;
      return () => epoch === setup.epoch && source === selectedId && id === setup.catalogue?.id && request === setup.request && (!strong || ticket === setup.upload);
    },
    accept:(catalogue,entry) => { acceptCatalogue(catalogue); if (entry) { startTicket = null; setup.subtitleId = entry.id; } }
  });
  const activeAddon = addonPanel('active-addon',{
    when:'Se usará solo al aplicar.',
    catalogue:() => state.active_catalogue,
    shown:() => !$('subtitles-panel').hidden,
    canAct:() => online && !!state.playback_id && !captionApply && state.active_catalogue?.id === captionDraft.catalogueId,
    guard:() => { const identity = playingSource, id = state.active_catalogue?.id; return () => identity === playingSource && id === state.active_catalogue?.id; },
    accept:(catalogue,entry) => {
      const current = state.active_catalogue;
      if (!catalogue || catalogue.id !== current?.id || catalogue.entries.length < current.entries.length || addonRevision(catalogue) < addonRevision(current)) return;
      state = {...state,active_catalogue:catalogue};
      if (entry) { dirtyCaption = true; captionDraft.subtitleId = entry.id; captionDraft.enabled = true; }
    }
  });
  function renderSources() {
    const sources = state.sources || [], signature = JSON.stringify(sources);
    if (selectedId && !sources.some(s => s.id === selectedId)) abandonSetup();
    if (signature !== sourceSignature) {
      sourceSignature = signature; $('source-list').replaceChildren();
      const legend = document.createElement('legend'); legend.className = 'sr-only'; legend.textContent = 'Películas disponibles'; $('source-list').append(legend);
      for (const source of sources) {
        const row = document.createElement('div'); row.className = 'source-option';
        const label = document.createElement('label'); label.className = 'source-choice';
        const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'source'; radio.value = source.id;
        radio.onchange = () => { if (!radio.disabled && selectedId !== source.id) chooseSource(source.id); };
        const copy = document.createElement('span'), title = document.createElement('strong'), note = document.createElement('small');
        title.textContent = source.title || 'Película sin nombre';
        note.textContent = source.saved ? 'Fuente guardada' : 'Caché de Stremio';
        copy.append(title,note); label.append(radio,copy);
        const detail = document.createElement('details'), summary = document.createElement('summary'), filename = document.createElement('span');
        summary.textContent = 'Nombre original'; filename.textContent = source.filename || 'Nombre no disponible; verificá antes de continuar.';
        detail.append(summary,filename); row.append(label,detail); $('source-list').append(row);
        row.sourceRadio = radio;
      }
    }
    for (const row of $('source-list').children) if (row.sourceRadio) { row.sourceRadio.checked = row.sourceRadio.value === selectedId; row.sourceRadio.disabled = !online; }
    const selected = sources.find(s => s.id === selectedId);
    $('source-detail').textContent = selected ? selected.filename || 'Nombre original no disponible.' : '';
    $('source-detail').hidden = !selected;
    $('empty').hidden = !!sources.length || state.source_discovery !== 'ready';
    const sourceError = metadataErrors.discover || (state.source_discovery === 'error' ? state.source_error || 'Reintentá la búsqueda.' : '');
    $('source-status').textContent = sourceError ? `No se pudo actualizar la lista de películas. Usá Actualizar películas para reintentar. ${sourceError}` : state.source_discovery === 'loading' || metadata.discover ? 'Buscando películas en la caché de Stremio…' : sources.length ? '' : 'No hay películas en la caché.';
    $('source-status').hidden = !$('source-status').textContent;
  }
  function renderDevices() {
    const selected = state.selected_device, devices = state.devices || [];
    const deviceError = metadataErrors.discover_devices || (state.device_discovery === 'error' ? state.device_error || 'Reintentá la búsqueda.' : '');
    $('destination-name').textContent = selected ? selected.name + (state.phase === 'disconnected' ? ' · No disponible' : deviceError ? ' · Lista sin confirmar' : selected.available || ['playing','paused'].includes(state.phase) ? '' : ' · No disponible') : 'Sin dispositivo elegido';
    $('choose-device').disabled = !online;
    $('discover-devices').disabled = !online || metadata.discover_devices || state.device_discovery === 'loading';
    $('discover-devices').textContent = 'Actualizar dispositivos';
    $('device-status').textContent = deviceError ? `No se pudo actualizar la lista de dispositivos. Usá Actualizar dispositivos para reintentar. ${deviceError}` : (state.device_discovery === 'loading' || metadata.discover_devices ? 'Buscando dispositivos Google Cast…' :
      devices.length ? '' :
      state.device_discovery === 'ready' ? 'No se encontraron receptores de video. Revisá que estén encendidos en la misma red y actualizá.' : 'Buscando dispositivos Google Cast…');
    $('device-status').hidden = !$('device-status').textContent;
    $('device-rule').textContent = state.can_change_device ? '' : 'Primero detené la sesión para cambiar de dispositivo.';
    $('device-rule').hidden = !!state.can_change_device;
    $('device-stop').hidden = state.can_change_device !== false;
    $('device-stop').disabled = !canStop();
    const signature = JSON.stringify(devices);
    if (signature !== deviceSignature) {
      deviceSignature = signature; $('device-list').replaceChildren();
      const legend = document.createElement('legend'); legend.className = 'sr-only'; legend.textContent = 'Dispositivos disponibles'; $('device-list').append(legend);
      for (const device of devices) {
        const row = document.createElement('label'); row.className = 'source-choice source-option';
        const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'device'; radio.value = device.id;
        radio.onchange = () => { if (!radio.disabled && state.can_change_device && online && !busy()) command('select_device',{device_id:device.id,device_revision:state.device_revision}); };
        const copy = document.createElement('span'), title = document.createElement('strong'), note = document.createElement('small');
        title.textContent = device.name; note.textContent = [device.model,device.host].filter(Boolean).join(' · ');
        copy.append(title,note); row.append(radio,copy); row.deviceRadio = radio; $('device-list').append(row);
      }
    }
    for (const row of $('device-list').children) if (row.deviceRadio) {
      row.deviceRadio.checked = row.deviceRadio.value === selected?.id;
      row.deviceRadio.disabled = !online || busy() || !state.can_change_device;
    }
    $('start-destination').textContent = selected?.available ? 'Destino: '+selected.name : 'Elegí un dispositivo disponible antes de iniciar la película.';
  }
  function render(s) {
    const usable = active(), pending = busy() || ['preparing','buffering','loading'].includes(s.phase);
    const playbackIdentity = JSON.stringify([s.selected_device?.id,s.device_revision,s.source_id || null,s.playback_id || null,s.active_catalogue?.id]);
    if (playbackIdentity !== playingSource) {
      playingSource = playbackIdentity; dirtyCaption = false; captionApply = null;
      view.captions = false;
      seekDraft = null; exactDraft = null; seekTarget = null; $('exact-review').hidden = true;
    }
    if (!dirtyCaption) captionDraft = {catalogueId:s.subtitle_choice?.catalogue_id || null,subtitleId:s.subtitle_choice?.subtitle_id || null,enabled:typeof s.subtitle_choice?.enabled === 'boolean' ? s.subtitle_choice.enabled : null,delay:Number.isFinite(s.subtitle_choice?.delay_ms) ? s.subtitle_choice.delay_ms / 1000 : null};
    for (const id of ['demo-banner','qa','sheet-demo']) $(id).hidden = s.demo !== true;
    if (s.demo === true && s.scenario) $('scenario').value = s.scenario;
    const title = s.title || 'Tu película en la TV';
    $('title').textContent = title; $('plate-text').textContent = title; $('mini-title').textContent = s.title || 'Sin película';
    $('metadata').textContent = Number.isFinite(s.duration) && s.duration > 0 ? `Duración ${formatTime(s.duration)}` : 'Duración —';
    const choiceFirst = online && ['idle','stopped','ended'].includes(s.phase) || online && s.phase === 'error' && !s.title;
    $('remote').hidden = choiceFirst;
    $('session-view').hidden = choiceFirst; $('empty-view').hidden = !choiceFirst;
    $('empty-copy').textContent = s.phase === 'ended' ? 'La película terminó. Elegí qué ver a continuación.' : s.phase === 'stopped' ? 'La sesión está detenida. Elegí una película para empezar.' : 'No hay una película en esta sesión. Abrí una en Stremio y luego elegí una entrada de la caché.';
    const problems = {
      receiver_changed:['Hay otro contenido en la TV','Este mando no controla ese contenido. Cancelá este control antes de volver a elegir.'],
      foreign:['Hay otro contenido en la TV','Este mando no controla ese contenido. Cancelá este control antes de volver a elegir.'],
      disconnected:['TV no disponible','Se perdió la conexión con la TV. Detené la sesión antes de volver a intentarlo.'],
      error:['No se pudo completar la acción',s.message || 'Revisá la fuente y volvé a intentarlo.']
    };
    const problem = !online ? ['Panel sin conexión','No se puede confirmar el estado de la TV. Reintentando la conexión…'] : problems[s.phase];
    $('problem').hidden = !problem;
    if (problem) { $('problem-title').textContent = problem[0]; $('problem-copy').textContent = problem[1]; }
    const phaseLabel = !online ? 'Panel sin conexión · Estado de la TV sin confirmar' : ['preparing','buffering','loading'].includes(s.phase) ? s.message || ({preparing:'Preparando la película para la TV…',buffering:'Preparando más contenido para la TV…',loading:'Cargando la película en la TV…'})[s.phase] : inFlight || s.command_pending ? 'Enviando la acción…' : s.phase === 'playing' ? 'Reproduciendo en la TV' : s.phase === 'paused' ? 'En pausa en la TV' : s.message || 'Esperando a la TV…';
    $('message').textContent = phaseLabel; $('mini-status').textContent = `${formatTime(s.absolute_time)} · ${phaseLabel}`;
    for (const id of ['toggle','mini-play','back','forward','position','seek','exact-apply']) $(id).disabled = !usable;
    $('timeline').disabled = !usable || !(s.duration > 0 && Number.isFinite(s.duration));
    $('seek-apply').disabled = !usable || seekDraft === null || !validPosition(seekDraft);
    for (const id of ['toggle','mini-play']) { icon(id,s.phase === 'playing' ? 'pause' : 'play'); $(id).setAttribute('aria-label',s.phase === 'playing' ? 'Pausar' : 'Continuar'); }
    $('stop').disabled = !canStop(); $('stop').textContent = ['playing','paused'].includes(s.phase) && !pending ? 'Detener película' : 'Cancelar preparación';
    renderDevices();
    $('discover').disabled = !online || metadata.discover || s.source_discovery === 'loading'; renderSources(); renderSetup();
    const duration = Number.isFinite(s.duration) && s.duration > 0 ? s.duration : null;
    $('timeline').max = duration || 1; $('timeline').value = seekDraft === null ? Number.isFinite(s.absolute_time) ? s.absolute_time : 0 : seekDraft;
    $('elapsed').textContent = formatTime(s.absolute_time); $('total').textContent = formatTime(duration);
    $('timeline').setAttribute('aria-valuetext',formatTime(seekDraft === null ? s.absolute_time : seekDraft));
    $('timeline-progress').style.width = duration && Number.isFinite(s.absolute_time) ? `${100 * Math.min(1,Math.max(0,s.absolute_time / duration))}%` : '0%';
    const buffered = online && ['playing','paused','buffering','loading'].includes(s.phase) && duration && Number.isFinite(s.buffered_start) && Number.isFinite(s.buffered_end);
    const start = buffered ? Math.max(0,Math.min(duration,s.buffered_start)) : 0, end = buffered ? Math.max(start,Math.min(duration,s.buffered_end)) : 0;
    $('buffer-range').hidden = !buffered; $('buffer-range').style.left = buffered ? `${100 * start / duration}%` : '0%'; $('buffer-range').style.width = buffered ? `${100 * (end - start) / duration}%` : '0%';
    $('buffer-status').textContent = buffered && Number.isFinite(s.buffer_ahead_seconds) ? `${Math.floor(s.buffer_ahead_seconds)} s preparados por delante para la TV · ${formatTime(start)} a ${formatTime(end)}` : 'Preparación para la TV: sin datos todavía';
    $('seek-review').hidden = seekDraft === null; $('seek-destination').textContent = `Ir a ${formatTime(seekDraft)}`;
    if (seekTarget) {
      if (s.pending || s.command_pending) seekTarget.observedBusy = true;
      if (usable && (seekTarget.observedBusy || Number.isFinite(s.absolute_time) && Math.abs(s.absolute_time-seekTarget.position) < 2)) seekTarget = null;
    }
    $('operation').hidden = !pending && !foreign() && !seekTarget;
    $('operation-text').textContent = `${seekTarget ? 'Destino '+formatTime(seekTarget.position)+' · ' : ''}${phaseLabel}`;
    for (const id of ['cancel-operation','mini-cancel']) { $(id).disabled = !canStop(); $(id).hidden = !pending && !foreign() && !seekTarget; }
    $('volume').disabled = !usable || !Number.isFinite(s.volume);
    if (document.activeElement !== $('volume')) $('volume').value = Number.isFinite(s.volume) ? Math.round(s.volume * 100) : 0;
    $('volume-value').textContent = Number.isFinite(s.volume) ? `${Math.round(s.volume * 100)}%` : '—';
    $('mute').disabled = !usable || typeof s.muted !== 'boolean'; icon('mute',s.muted ? 'muted' : 'volume');
    $('mute').setAttribute('aria-label',s.muted ? 'Activar sonido' : 'Silenciar'); $('mute').setAttribute('aria-pressed',String(s.muted === true));
    $('subtitle-label').textContent = typeof s.subtitles_enabled !== 'boolean' ? 'Subtítulos · Sin confirmar' : s.subtitles_enabled ? 'Subtítulos · Visibles' : 'Subtítulos · Ocultos';
    const hasCaptions = !!s.active_catalogue && !!s.playback_id;
    $('subtitles-panel').hidden = !view.captions || !hasCaptions;
    $('open-subtitles').disabled = !hasCaptions;
    $('open-subtitles').setAttribute('aria-controls','subtitles-panel'); $('open-subtitles').setAttribute('aria-expanded',String(!$('subtitles-panel').hidden));
    activeAddon.render();
    $('active-movie').textContent = s.title || 'Película actual';
    subtitleOptions($('active-subtitle'),s.active_catalogue,captionDraft.subtitleId);
    const captionUsable = usable && !!s.playback_id && !!s.active_catalogue && s.active_catalogue.id === captionDraft.catalogueId;
    $('active-subtitle').disabled = !captionUsable || !!captionApply;
    $('subtitles').checked = captionDraft.enabled === true; $('subtitles').disabled = !captionUsable || !captionDraft.subtitleId || captionDraft.enabled === null || !!captionApply;
    $('caption-controls').hidden = !captionDraft.subtitleId;
    for (const id of ['delay-minus','delay-plus','delay-reset']) $(id).disabled = !captionUsable || !captionDraft.subtitleId || !Number.isFinite(captionDraft.delay) || !!captionApply;
    $('delay-value').textContent = signed(captionDraft.delay); $('delay-meaning').textContent = !Number.isFinite(captionDraft.delay) ? 'Sin datos' : captionDraft.delay === 0 ? 'Sin ajuste' : captionDraft.delay < 0 ? 'Antes' : 'Después';
    $('subtitle-actual').textContent = `En la TV: ${typeof s.subtitles_enabled !== 'boolean' ? 'sin confirmar' : s.subtitles_enabled ? 'visibles' : 'ocultos'} · ${signed(Number.isFinite(s.subtitle_delay_ms) ? s.subtitle_delay_ms / 1000 : null)}.`;
    $('subtitle-plan').textContent = `Pista del plan actual: ${s.subtitle_choice?.label || (s.subtitle_choice?.subtitle_id ? 'Pista elegida' : 'Sin subtítulos')}.`;
    $('apply').disabled = !captionUsable || !dirtyCaption || !!captionApply;
    if (s.action_error && errorIdentity(s) !== observedBackendError) {
      observedBackendError = errorIdentity(s);
      if (errorIdentity(s) !== dismissedBackendError && !captionApply) showError(s.action_error);
      seekTarget = null;
    }
    if (focusTicket && focusTicket.interaction !== interaction) focusTicket = null;
    if (focusTicket && !focusTicket.element.disabled && !busy()) {
      const element = focusTicket.element; focusTicket = null;
      if (!document.activeElement || document.activeElement === document.body || document.activeElement === element) element.focus({preventScroll:true});
    }
    advanceCaptions();
  }
  function poll() {
    if (pollPromise) return pollPromise;
    const version = generation;
    pollPromise = (async () => {
      try {
        const s = await request('/api/status');
        if (!s || typeof s.phase !== 'string' || !Array.isArray(s.sources)) throw Error('Respuesta inválida');
        if (version === generation) { state = s; online = true; render(state); }
      } catch (_) { if (version === generation) { online = false; render(state); } }
      finally { pollPromise = null; }
    })();
    return pollPromise;
  }
  async function command(action,data = {},isCurrent = () => true) {
    if (!online || inFlight && action !== 'stop') return false;
    const focused = document.activeElement === $('seek-apply') ? $('timeline') : document.activeElement === $('exact-apply') ? $('position') : document.activeElement;
    if (focused && focused !== document.body) focusTicket = {element:focused,interaction};
    if (['start','pause','resume','seek','stop','volume','mute','subtitles'].includes(action)) data = {device_id:state.selected_device?.id,device_revision:state.device_revision,...data};
    const version = ++generation; inFlight = true; render(state);
    let accepted = false;
    try {
      await request('/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Token':token},body:JSON.stringify(data)});
      accepted = true;
    } catch (e) { if (version === generation && isCurrent()) showError(e.name === 'AbortError' ? 'La acción tardó demasiado. Revisá el estado antes de reintentar.' : e.message); }
    finally {
      if (version === generation) {
        if (pollPromise) await pollPromise;
        if (version === generation) await poll();
        if (version === generation) { inFlight = false; render(state); }
      }
    }
    return accepted;
  }
  function showPanel(panel) {
    sheetPanel = panel;
    for (const name of ['more','confirm']) $(name+'-panel').hidden = name !== panel;
    $('sheet-title').textContent = ({more:'Más opciones',confirm:confirmation?.title})[panel];
  }
  function openSheet(panel,trigger) {
    if (!$('settings').open) { returnFocus = trigger; $('settings').showModal(); }
    showPanel(panel); $('close-sheet').focus();
  }
  function restoreSheetFocus() {
    if ($('settings').open) return;
    if (confirmation) startTicket = null;
    const trigger = returnFocus; returnFocus = null; confirmation = null; sheetPanel = null;
    if (trigger && !trigger.disabled && !trigger.hidden) trigger.focus({preventScroll:true}); else $('remote').focus({preventScroll:true});
  }
  function closeSheet() { startTicket = null; $('settings').close(); }
  $('settings').onclose = restoreSheetFocus;
  $('settings').oncancel = e => { e.preventDefault(); if (confirmation) dismissConfirmation(); else closeSheet(); };
  $('close-sheet').onclick = closeSheet;
  function focusSetup() { view.setup = true; render(state); $('setup').scrollIntoView({block:'start',behavior:'auto'}); $('setup').focus({preventScroll:true}); }
  for (const id of ['change-source','choose-film','choose-device']) $(id).onclick = focusSetup;
  function cancelSetup() {
    view.setup = false; abandonSetup();
    const target = $('remote').hidden ? $('setup') : $('remote');
    target.scrollIntoView({block:'start',behavior:'auto'}); target.focus({preventScroll:true});
  }
  $('setup-cancel').onclick = cancelSetup;
  $('discover-devices').onclick = () => refresh('discover_devices');
  $('device-stop').onclick = () => stop($('device-stop'));
  $('open-subtitles').onclick = () => { if ($('open-subtitles').disabled) return; view.captions = !view.captions; render(state); if (!$('subtitles-panel').hidden) { $('subtitles-panel').scrollIntoView({block:'start',behavior:'auto'}); $('subtitles-panel').focus({preventScroll:true}); } };
  $('open-more').onclick = () => openSheet('more',$('open-more'));
  $('discover').onclick = () => refresh('discover');
  function askConfirmation(trigger,title,body,label,accept) {
    if (confirmation) return;
    const previousPanel = sheetPanel;
    confirmation = {trigger,title,accept,previousPanel}; $('confirm-body').textContent = body; $('confirm-accept').textContent = label;
    openSheet('confirm',trigger); $('confirm-cancel').focus();
  }
  function dismissConfirmation() {
    startTicket = null;
    const pending = confirmation; confirmation = null;
    if (pending?.previousPanel) { showPanel(pending.previousPanel); if (!pending.trigger.disabled) pending.trigger.focus({preventScroll:true}); else $('close-sheet').focus(); }
    else closeSheet();
    return pending;
  }
  $('confirm-cancel').onclick = dismissConfirmation;
  $('confirm-accept').onclick = () => { const pending = dismissConfirmation(); if (pending) pending.accept(); };
  $('start').onclick = () => {
    const deviceId = state.selected_device?.id, deviceRevision = state.device_revision;
    const sourceId = selectedId, selected = (state.sources || []).find(s => s.id === sourceId);
    if (!selected || $('start').disabled) return;
    const catalogueId = setup.catalogue.id, subtitleId = setup.subtitleId, epoch = setup.epoch, catalogueRequest = setup.request, uploadRequest = setup.upload;
    const replacementIdentity = () => ['playing','paused'].includes(state.phase) ? JSON.stringify([deviceId,deviceRevision,state.source_id,state.playback_id ?? null,state.session ?? null,state.session_id ?? null,state.subtitle_choice]) : null;
    const confirmReplacement = identity => askConfirmation($('start'),'¿Cambiar la película en la TV?',`Vas a ver ${selected.title}. La nueva película empieza desde el principio.`,'Cambiar',() => start(identity));
    const start = async (consent = null) => {
      const ticket = {}; startTicket = ticket;
      await poll();
      if (startTicket !== ticket || epoch !== setup.epoch || catalogueRequest !== setup.request || selectedId !== sourceId || setup.catalogue?.id !== catalogueId || setup.subtitleId !== subtitleId) return;
      if (state.selected_device?.id !== deviceId || state.device_revision !== deviceRevision) { showError('El destino cambió. Revisá el dispositivo y volvé a intentar.'); return; }
      const authoritative = state.catalogues?.[sourceId];
      if (!canStart() || !(state.sources || []).some(s => s.id === sourceId) || samePlan(sourceId,catalogueId,subtitleId)) return;
      if (authoritative?.state !== 'ready' || authoritative.catalogue.id !== catalogueId || subtitleId && !authoritative.catalogue.entries.some(e => e.id === subtitleId && e.supported === true)) { showError('La lista de pistas cambió. Revisá la película y volvé a iniciar.'); return; }
      const replacement = replacementIdentity();
      if (replacement && replacement !== consent) { confirmReplacement(replacement); return; }
      const current = () => epoch === setup.epoch && catalogueRequest === setup.request && uploadRequest === setup.upload && selectedId === sourceId && setup.catalogue?.id === catalogueId && setup.subtitleId === subtitleId;
      closeSheet();
      const accepted = await command('start',{source_id:sourceId,device_id:deviceId,device_revision:deviceRevision,catalogue_id:catalogueId,subtitle_id:subtitleId,delay_ms:0},current);
      if (accepted && current()) { view.setup = false; render(state); }
    };
    if (replacementIdentity()) confirmReplacement(replacementIdentity());
    else start();
  };
  function stop(trigger) {
    if (!canStop()) return;
    const deviceId = state.selected_device?.id, deviceRevision = state.device_revision;
    const playbackId = state.playback_id;
    const needsConfirmation = ['playing','paused'].includes(state.phase) && !busy();
    const send = async () => {
      const version = generation;
      if (needsConfirmation) await poll();
      if (version !== generation) return;
      if (state.selected_device?.id !== deviceId || state.device_revision !== deviceRevision || state.playback_id !== playbackId) { showError('El destino cambió o hay otra sesión. Revisá el dispositivo antes de detener.'); return; }
      if (canStop()) { startTicket = null; captionApply = null; seekTarget = null; command('stop',needsConfirmation ? {playback_id:playbackId} : {}); }
    };
    if (needsConfirmation) askConfirmation(trigger,'¿Detener la película en la TV?','La reproducción se va a detener.','Detener',send);
    else send();
  }
  $('stop').onclick = () => stop($('stop'));
  for (const id of ['cancel-operation','mini-cancel']) $(id).onclick = () => stop($(id));
  for (const id of ['toggle','mini-play']) $(id).onclick = () => { if (active()) command(state.phase === 'playing' ? 'pause' : 'resume'); };
  function validPosition(value) { return Number.isFinite(value) && value >= 0 && Number.isFinite(state.duration) && state.duration > 0 && value <= state.duration; }
  function seek(data) {
    if (!active()) return;
    const position = 'position' in data ? data.position : Number.isFinite(state.absolute_time) ? Math.max(0,Math.min(state.duration,state.absolute_time+data.delta)) : null;
    if ('position' in data && !validPosition(position)) { showError('El tiempo está fuera de la duración de la película.'); return; }
    const target = {position,observedBusy:false}; seekTarget = target;
    seekDraft = null; exactDraft = null; $('exact-review').hidden = true;
    command('seek',data).then(ok => {
      if (!ok && seekTarget === target) { seekTarget = null; render(state); }
    });
  }
  $('back').onclick = () => seek({delta:-30}); $('forward').onclick = () => seek({delta:30});
  $('timeline').oninput = () => { if (active()) { seekDraft = Number($('timeline').value); render(state); } };
  $('timeline').onchange = () => {};
  $('seek-apply').onclick = () => { if (seekDraft !== null) seek({position:seekDraft}); };
  $('seek-cancel').onclick = () => { seekDraft = null; render(state); $('timeline').focus(); };
  $('exact-form').onsubmit = e => {
    e.preventDefault(); if (!active()) return;
    const value = parseTime($('position').value);
    if (value === null || !validPosition(value)) { $('exact-error').textContent = `Usá minutos:segundos u horas:minutos:segundos, hasta ${formatTime(state.duration)}.`; $('exact-error').hidden = false; $('position').setAttribute('aria-invalid','true'); return; }
    $('exact-error').hidden = true; $('position').setAttribute('aria-invalid','false'); exactDraft = value;
    $('exact-target').textContent = `Ir a ${formatTime(value)}. Saltar requiere recargar.`; $('exact-review').hidden = false; $('exact-apply').focus();
  };
  $('exact-cancel').onclick = () => { exactDraft = null; $('exact-review').hidden = true; $('position').focus(); };
  $('exact-apply').onclick = () => { if (exactDraft !== null) seek({position:exactDraft}); };
  $('volume').oninput = () => { $('volume-value').textContent = `${$('volume').value}%`; };
  $('volume').onchange = () => { if (active() && Number.isFinite(state.volume)) command('volume',{level:Number($('volume').value)/100}); };
  $('mute').onclick = () => { if (active() && typeof state.muted === 'boolean') command('mute',{muted:!state.muted}); };
  $('subtitles').onchange = () => { if (!$('subtitles').disabled) { dirtyCaption = true; captionDraft.enabled = $('subtitles').checked; render(state); } };
  $('active-subtitle').onchange = () => {
    if ($('active-subtitle').disabled) return;
    const id = $('active-subtitle').value || null;
    if (id && !state.active_catalogue?.entries.some(e => e.id === id && e.supported === true)) return;
    dirtyCaption = true; captionDraft.subtitleId = id; captionDraft.enabled = id !== null;
    if (!id) captionDraft.delay = 0;
    render(state);
  };
  function adjustDelay(value) { if (!active() || captionApply || !Number.isFinite(value)) return; dirtyCaption = true; captionDraft.delay = Math.round(Math.min(30,Math.max(-30,value))*10)/10; render(state); }
  $('delay-minus').onclick = () => adjustDelay(captionDraft.delay-.1); $('delay-plus').onclick = () => adjustDelay(captionDraft.delay+.1); $('delay-reset').onclick = () => adjustDelay(0);
  function captionFailure(message) {
    const partial = captionApply && state.playback_id === captionApply.playback && typeof captionApply.previousVisibility === 'boolean' && state.subtitles_enabled !== captionApply.previousVisibility && state.subtitles_enabled === captionApply.enabled && state.subtitle_delay_ms !== captionApply.delay;
    captionApply = null; showError(`${partial ? 'La visibilidad ya cambió; el ajuste de tiempo sigue sin confirmar. ' : ''}${message} El borrador sigue disponible.`); render(state);
  }
  function advanceCaptions() {
    const pending = captionApply;
    if (!pending) return;
    if (pending.device !== state.selected_device?.id || pending.revision !== state.device_revision || pending.source !== state.source_id || pending.playback !== state.playback_id || pending.catalogue !== state.active_catalogue?.id) { captionApply = null; return; }
    if (!online || foreign() || state.phase === 'error') { captionFailure('Se interrumpió la aplicación. Revisá el estado de la TV.'); return; }
    if (busy()) return;
    if (errorIdentity(state) && errorIdentity(state) !== pending.error) { captionFailure(state.action_error); return; }
    if (!active()) return;
    const choice = state.subtitle_choice;
    const visibilitySettled = typeof state.subtitles_enabled !== 'boolean' || state.subtitles_enabled === pending.enabled;
    if (pending.accepted && choice?.catalogue_id === pending.catalogue && choice?.subtitle_id === pending.subtitle && choice?.enabled === pending.enabled && choice?.delay_ms === pending.delay && state.subtitle_delay_ms === pending.delay && visibilitySettled) {
      captionApply = null;
      if (captionDraft.subtitleId === pending.subtitle && captionDraft.enabled === pending.enabled && Math.round(captionDraft.delay*1000) === pending.delay) dirtyCaption = false;
      render(state); return;
    }
  }
  $('apply').onclick = async () => {
    if ($('apply').disabled || !active() || captionApply || !dirtyCaption || typeof captionDraft.enabled !== 'boolean' || !Number.isFinite(captionDraft.delay)) return;
    const pending = {device:state.selected_device?.id,revision:state.device_revision,source:state.source_id,playback:state.playback_id,catalogue:captionDraft.catalogueId,subtitle:captionDraft.subtitleId,enabled:captionDraft.subtitleId ? captionDraft.enabled : false,delay:captionDraft.subtitleId ? Math.round(captionDraft.delay*1000) : 0,previousVisibility:state.subtitles_enabled,error:errorIdentity(state),accepted:false};
    captionApply = pending; render(state);
    await poll();
    if (captionApply !== pending) return;
    if (!active() || state.playback_id !== pending.playback || state.active_catalogue?.id !== pending.catalogue || state.selected_device?.id !== pending.device || state.device_revision !== pending.revision) { captionApply = null; render(state); return; }
    const ok = await command('subtitles',{device_id:pending.device,device_revision:pending.revision,playback_id:pending.playback,catalogue_id:pending.catalogue,subtitle_id:pending.subtitle,enabled:pending.enabled,delay_ms:pending.delay},() => captionApply === pending);
    if (captionApply !== pending) return;
    if (!ok) captionFailure(visibleError || 'No se pudo aplicar el cambio.');
    else { pending.accepted = true; advanceCaptions(); render(state); }
  };
  $('scenario').onchange = () => { if (state.demo === true) command('scenario',{state:$('scenario').value}); };
  document.addEventListener('keydown',e => {
    if ($('settings').open) return;
    if (e.key === 'Escape' && (e.target === $('setup') || e.target?.closest?.('#setup'))) { e.preventDefault(); cancelSetup(); return; }
    if (awaitingControlFocus(e)) { e.preventDefault(); return; }
    const id = shortcut(e); if (id && !$(id).disabled) { e.preventDefault(); $(id).click(); }
  });
  async function cycle() { await poll(); setTimeout(cycle,1500); }
  cycle();
}
