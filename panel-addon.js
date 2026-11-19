// ───────── addon (Stremio): one state machine for the plan and for the live subtitle sheet
// Depends on: panel-core.js.
const ADDON_LOADING = 'Buscando subtítulos de Stremio…';
const ADDON_ERROR = 'No se pudieron buscar subtítulos de Stremio. Las pistas y los archivos locales siguen disponibles.';
const addonKey = cat => cat?.addon ? `${cat.id}:${cat.addon.revision}` : '';
const addonSay = (a, cat, text) => { a.message = text ? {text, key: addonKey(cat)} : null; };
const addonFailure = msg => msg.timeout ? 'La consulta tardó demasiado. Reintentá.' : commandError(msg);
const stremioScope = m => m.ui.sheet === 'subs' ? 'remote' : 'plan';
function addonCtx(m, scope) {
  const c = caps(m), s = m.link.status;
  if (scope === 'plan') {
    const p = m.plan;
    return {
      addon: p.addon, catalogue: p.catalogue, shown: p.choice.branch === 'stremio', when: 'Se usará solo al iniciar.',
      canAct: c.online && !!p.catalogue && p.load.s === 'idle' && p.upload.s === 'idle',
      accept(cat, entry) {
        planAcceptCatalogue(m, cat);
        if (!entry) return true;
        if (!entryOf(m.plan.catalogue, entry.id)?.supported) return false;
        planTouch(m);
        m.plan.choice = {branch: 'stremio', entryId: entry.id};
        return true;
      },
    };
  }
  const r = m.remote;
  return {
    addon: r.addon, catalogue: remoteCatalogue(m), shown: m.ui.sheet === 'subs', when: 'Se usará solo al aplicar.',
    canAct: c.online && !c.foreign && !!s.playback_id && !r.captions.apply,
    accept(cat, entry) {
      if (!notOlder(cat, remoteCatalogue(m))) return false;
      r.overlay = cat;
      if (!entry) return true;
      if (!entryOf(cat, entry.id)?.supported) return false;
      r.captions.draft = {subtitleId: entry.id, delayMs: capDraft(m).delayMs};
      return true;
    },
  };
}
/** Languages, versions and the effective selection, derived (never written) so view and handlers agree. */
function addonOffers(a, cat) {
  const info = cat?.addon, key = addonKey(cat);
  const listing = info && a.listingKey === key && a.listing?.revision === info.revision ? a.listing : null;
  const offers = listing?.offers || [], languages = [];
  for (const o of offers) {
    const found = languages.find(l => l.code === o.language);
    if (found) found.count++; else languages.push({code: o.language, name: o.language_name, count: 1});
  }
  const language = languages.some(l => l.code === a.language) ? a.language : languages[0]?.code || '';
  const versions = offers.filter(o => o.language === language);
  const offerId = versions.some(o => o.id === a.offerId) ? a.offerId : versions[0]?.id || '';
  return {listing, offers, languages, versions, language, offerId};
}
function addonReady(m, scope) {
  const x = addonCtx(m, scope);
  return x.canAct && !x.addon.op && x.catalogue?.addon ? x : null;
}
function addonLanguage(m, scope, code) {
  const x = addonReady(m, scope);
  if (x) { x.addon.language = String(code); x.addon.offerId = ''; }
}
function addonVersion(m, scope, id) {
  const x = addonReady(m, scope);
  if (x) x.addon.offerId = String(id);
}
function addonWrong(m, scope) {
  const x = addonReady(m, scope);
  if (x) x.addon.correcting = !x.addon.correcting;
}
function addonUse(m, fx, scope) {
  const x = addonReady(m, scope);
  if (!x || x.catalogue.addon.state !== 'ready') return;
  const eff = addonOffers(x.addon, x.catalogue), offer = eff.offers.find(o => o.id === eff.offerId);
  if (!offer) return;
  const ticket = ticketOf(m);
  x.addon.message = null;
  x.addon.op = {kind: 'fetch', ticket, offerId: offer.id};
  fx.push({fx: 'post', ticket, action: 'subtitle_fetch', body: {source_id: x.catalogue.source_id, catalogue_id: x.catalogue.id, offer_id: offer.id}});
}
function addonLookup(m, fx, scope, hint) {
  const x = addonReady(m, scope);
  if (!x) return;
  const ticket = ticketOf(m);
  x.addon.lastHint = hint;
  x.addon.message = null;
  x.addon.op = {kind: 'lookup', ticket};
  fx.push({fx: 'post', ticket, action: 'subtitle_lookup', body: {source_id: x.catalogue.source_id, catalogue_id: x.catalogue.id, hint}});
}
function addonRetry(m, fx, scope) {
  const x = addonReady(m, scope);
  if (x) addonLookup(m, fx, scope, x.addon.lastHint);
}
function addonAlternative(m, fx, scope, index) {
  const x = addonReady(m, scope), alt = x && addonOffers(x.addon, x.catalogue).listing?.alternatives?.slice(0, 4)[index];
  if (alt) addonLookup(m, fx, scope, `${alt.id} ${alt.title} ${alt.year ?? ''}`.trim().slice(0, 200));
}
function addonSearch(m, fx, scope, text) {
  const x = addonReady(m, scope), hint = String(text ?? '').trim();
  if (!x || !hint) return;
  if (hint.length > 200) { addonSay(x.addon, x.catalogue, 'Escribí un título de hasta 200 caracteres.'); return; }
  addonLookup(m, fx, scope, hint);
}
function addonOnReply(m, fx, scope, msg) {
  const x = addonCtx(m, scope), a = x.addon, op = a.op;
  a.op = null;
  if (op.kind === 'lookup') {
    if (!msg.ok) return addonSay(a, x.catalogue, addonFailure(msg));
    x.accept(msg.body?.catalogue, null);
    a.correcting = false;
    fx.push({fx: 'clearSearch'});
  } else if (!msg.ok) {
    if (msg.code === 'invalid_subtitle' && !a.unreadable.includes(op.offerId)) a.unreadable.push(op.offerId);
    addonSay(a, x.catalogue, addonFailure(msg));
  } else {
    const entry = verifiedEntry(msg.body, x.catalogue);
    if (entry && x.accept(msg.body.catalogue, entry)) addonSay(a, addonCtx(m, scope).catalogue, `Subtítulo listo: ${entry.label}. ${x.when}`);
    else addonSay(a, x.catalogue, 'La lista de pistas cambió. Actualizala y probá otra vez.');
  }
}
function addonOnPull(m, scope, msg) {
  const a = addonCtx(m, scope).addon, key = a.pull.key;
  if (msg.ok) { a.listing = msg.body; a.listingKey = key; a.pull = {s: 'idle'}; } else a.pull = {s: 'failed', key};
}
/** Offers are pulled when someone is looking at the block and the listing for this catalogue revision is missing. */
function addonReconcile(m, fx, scope) {
  const x = addonCtx(m, scope), a = x.addon, cat = x.catalogue, info = cat?.addon;
  if (!x.shown || !m.link.online || !info || !(info.state === 'ready' || info.state === 'unidentified')) return;
  const key = addonKey(cat);
  if (a.listingKey === key || (a.pull.s !== 'idle' && a.pull.key === key)) return;
  const ticket = ticketOf(m);
  a.pull = {s: 'pulling', key, ticket};
  fx.push({fx: 'post', ticket, action: 'subtitle_offers', body: {source_id: cat.source_id, catalogue_id: cat.id}});
}
/** A reply for an offers pull, a lookup or a download, in either scope. */
function addonRouteReply(m, fx, msg) {
  for (const [scope, a] of [['plan', m.plan.addon], ['remote', m.remote.addon]]) {
    if (a.pull.s === 'pulling' && a.pull.ticket === msg.ticket) return addonOnPull(m, scope, msg);
    if (a.op?.ticket === msg.ticket) return addonOnReply(m, fx, scope, msg);
  }
}
