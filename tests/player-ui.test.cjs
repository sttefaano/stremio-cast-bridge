const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('player.html','utf8');
const markupIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]));
test('timestamps and keyboard shortcuts follow player conventions', () => {
  const context = {module: {exports: {}}};
  vm.runInNewContext(fs.readFileSync('player.js', 'utf8'), context);
  const {formatTime, parseTime, shortcut} = context.module.exports;
  assert.equal(formatTime(3665), '1:01:05');
  assert.equal(formatTime(NaN), '—');
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(parseTime('02:30'), 150);
  for (const value of ['90', '-1:00', '1:60:00', 'a:b', '1:2:3:4']) assert.equal(parseTime(value), null);
  assert.equal(shortcut({key:' ', target:{id:'remote',tagName:'SECTION'}}), 'toggle');
  assert.equal(shortcut({key:' ', target:{tagName:'BODY'}}), null);
  assert.equal(shortcut({key:'m', target:{id:'remote',tagName:'SECTION'}}), null);
  assert.equal(shortcut({key:'m', target:{tagName:'INPUT'}}), null);
  assert.equal(shortcut({key:'ArrowRight', ctrlKey:true, target:{tagName:'BODY'}}), null);
  assert.equal(shortcut({key:' ', target:{tagName:'DIV', isContentEditable:true}}), null);
});

function harness(initial) {
  const elements = new Map(), timers = [], requests = [], listeners = new Map(), responders = new Map();
  let document;
  const node = tagName => ({tagName:tagName.toUpperCase(),children:[],attributes:{},disabled:false,
    append(...nodes){this.children.push(...nodes);},setAttribute(k,v){this.attributes[k]=v;},focus(){document.activeElement=this;}});
  const element = id => {
    assert.ok(markupIds.has(id),`real DOM element #${id} exists`);
    if (!elements.has(id)) elements.set(id, {id, tagName:['volume','timeline','subtitles','position'].includes(id)?'INPUT':id==='remote'?'SECTION':'BUTTON', value: '', _disabled:false, hidden:false, attributes:{}, children:[],style:{setProperty(k,v){this[k]=v;}},
      get disabled(){return this._disabled;}, set disabled(v){this._disabled=v;if(v && document.activeElement===this)document.activeElement=document.body;},
      focus(){document.activeElement=this;},scrollIntoView(){this.scrolls=(this.scrolls||0)+1;}, open:false, showModal(){this.open=true;}, close(){this.open=false;this.onclose?.();},
      setAttribute(k,v){this.attributes[k]=v;}, replaceChildren(){this.children=[];this.value='';},
      append(...nodes){this.children.push(...nodes);}, click(){if(!this.disabled)this.onclick?.();}});
    return elements.get(id);
  };
  let status = fixture(initial);
  document = {getElementById:element, createElement:node, addEventListener(k,fn){if(!listeners.has(k))listeners.set(k,[]);listeners.get(k).push(fn);}, activeElement:null,body:{tagName:'BODY'}};
  const context = {document, token:'test', AbortController, TextDecoder,
    setTimeout:(fn,ms)=>{if(ms===1500)timers.push(fn);return 1;}, clearTimeout(){},
    fetch:async(path,options)=>{requests.push({path,options});if(responders.has(path))return responders.get(path)(options);
      if(path==='/api/volume')status={...status,volume:JSON.parse(options.body).level};
      if(path==='/api/catalogue')return {ok:true,json:async()=>({catalogue:status.catalogues?.[JSON.parse(options.body).source_id]?.catalogue})};
      return {ok:true,json:async()=> path==='/api/status'?status:{accepted:true}};}};
  vm.runInNewContext(fs.readFileSync('player.js','utf8'),context);
  const settle = async()=>{await new Promise(resolve=>setImmediate(resolve));};
  return {element,requests,settle,document,setStatus(s){status=fixture(s);},respond(path,fn){responders.set(path,fn);},
    select(id){const radio=element('source-list').children.flatMap(n=>n.children||[]).flatMap(n=>n.children||[]).find(n=>n.type==='radio'&&n.value===id);assert.ok(radio,`source ${id} available`);radio.checked=true;radio.onchange();},
    selected(){return element('source-list').children.flatMap(n=>n.children||[]).flatMap(n=>n.children||[]).find(n=>n.type==='radio'&&n.checked)?.value||'';},
    delay(value){element('delay-reset').click();for(let i=0;i<Math.round(Math.abs(value)*10);i++)element(value<0?'delay-minus':'delay-plus').click();},
    event(type,event){for(const fn of listeners.get(type)||[])fn(event);},
    key(key){const target=document.activeElement||document.body;let prevented=false;for(const fn of listeners.get('keydown')||[])fn({key,target,preventDefault(){prevented=true;}});
      if(!prevented&&target.tagName==='BUTTON'&&[' ','Enter'].includes(key))target.click();
      if(target===element('volume')&&!target.disabled&&['Home','ArrowRight'].includes(key)){target.value=key==='Home'?0:Math.min(100,Number(target.value)+1);target.oninput();target.onchange();}},
     async poll(s){status=fixture(s);timers.shift()();await settle();}};
}

const addonOff = {state:'off',revision:0,match:null,message:null,count:0};
const catalogue = (id,addon=addonOff,extra=[]) => ({id:'cat-'+id,source_id:id,duration:500,entries:[{id:'text-'+id,kind:'embedded',label:'日本語',language:'jpn',supported:true,reason:null},{id:'image-'+id,kind:'embedded',label:'Image',language:'eng',supported:false,reason:'Subtítulos de imagen no compatibles'},...extra],addon});
function fixture(s) {
  const catalogues = Object.fromEntries((s.sources || []).map(source=>[source.id,{state:'ready',catalogue:catalogue(source.id,s.addons?.[source.id],s.extra?.[source.id])}]));
  const active = ['playing','paused','preparing','buffering','loading'].includes(s.phase);
  return {...destination,source_discovery:'ready',catalogues,...(active ? {playback_id:'play-a',active_catalogue:catalogue(s.source_id || 'a',s.addons?.[s.source_id || 'a'],s.extra?.[s.source_id || 'a']),subtitle_choice:{catalogue_id:'cat-'+(s.source_id || 'a'),subtitle_id:'text-'+(s.source_id || 'a'),enabled:true,delay_ms:s.subtitle_delay_ms ?? 0,label:'日本語',language:'jpn'}} : {}),...s};
}
const playbackPost = r => r.options?.method === 'POST' && !['/api/catalogue','/api/subtitle_upload','/api/subtitle_lookup','/api/subtitle_offers','/api/subtitle_fetch','/api/discover','/api/discover_devices'].includes(r.path);
const startBody = source => ({device_id:'tv-a',device_revision:1,source_id:source,catalogue_id:'cat-'+source,subtitle_id:null,delay_ms:0});
const captionBody = (enabled,delay_ms=0) => ({device_id:'tv-a',device_revision:1,playback_id:'play-a',catalogue_id:'cat-a',subtitle_id:'text-a',enabled,delay_ms});
const destination = {selected_device:{id:'tv-a',name:'Sala',host:'192.0.2.2',model:'Chromecast',available:true},device_revision:1,devices:[{id:'tv-a',name:'Sala',host:'192.0.2.2',model:'Chromecast'},{id:'tv-b',name:'Sala',host:'192.0.2.3',model:'Google TV'}],device_discovery:'ready',can_change_device:false};
const playing = {...destination,phase:'playing',title:'Alpha',source_id:'a',sources:[{id:'a',title:'Alpha'},{id:'b',title:'Beta'}],duration:500,absolute_time:50,volume:.3,muted:false,subtitle_delay_ms:0,subtitles_enabled:true};
test('idle setup joins movie device and subtitle choice without a chooser or discovery click gate',async()=>{
  const h=harness({...playing,phase:'idle',source_id:null,device_discovery:'loading',source_discovery:'loading'});await h.settle();const $=h.element;
  assert.equal($('setup').hidden,false);
  assert.match($('source-status').textContent,/Buscando/);
  $('choose-device').click();assert.equal($('settings').open,false);assert.equal(h.document.activeElement,$('setup'));
  $('change-source').click();assert.equal($('settings').open,false);assert.equal(h.document.activeElement,$('setup'));
  h.select('b');await h.settle();
  assert.equal(h.requests.filter(r=>r.path==='/api/catalogue').length,1);
  assert.equal($('setup-subtitle').value,'');
  assert.equal(h.requests.filter(r=>r.path==='/api/start').length,0);
});
test('in-page device choices use UUIDs, distinguish names, and block changing an owned destination',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $('choose-device').click();assert.equal($('settings').open,false);assert.equal($('device-panel').hidden,false);
  assert.match($('device-rule').textContent,/deten/);
  const rows=$('device-list').children.filter(n=>n.deviceRadio);
  assert.equal(rows.length,2);assert.equal(rows[1].deviceRadio.disabled,true);
  assert.match(rows[1].children[1].children[1].textContent,/192.0.2.3/);
  await h.poll({...playing,phase:'stopped',can_change_device:true});
  rows[1].deviceRadio.onchange();await h.settle();
  const post=h.requests.find(r=>r.path==='/api/select_device');
  assert.deepEqual(JSON.parse(post.options.body),{device_id:'tv-b',device_revision:1});
});
test('destination changes during deferred start invalidate the captured consent',async()=>{
  for(const changed of [{id:'tv-b',revision:2},{id:'tv-a',revision:3}]) {
  const h=harness({...playing,phase:'idle',can_change_device:true});await h.settle();const $=h.element;
  $('choose-film').click();h.select('b');let resolveStatus;
  h.respond('/api/status',()=>new Promise(resolve=>{resolveStatus=resolve;}));
  $('start').click();await h.settle();
  resolveStatus({ok:true,json:async()=>({...playing,phase:'idle',selected_device:{...destination.selected_device,id:changed.id},device_revision:changed.revision})});await h.settle();
  assert.equal(h.requests.filter(r=>r.path==='/api/start').length,0);
  assert.match($('error-text').textContent,/destino cambió/);
  }
});
test('device empty loading and error states never enable movie start or invent a target',async()=>{
  const h=harness({...playing,phase:'idle',selected_device:null,devices:[],can_change_device:true,device_discovery:'idle'});await h.settle();const $=h.element;
  $('choose-device').click();assert.match($('device-status').textContent,/Buscando dispositivos/);
  h.select('b');assert.equal($('start').disabled,true);assert.match($('destination-name').textContent,/Sin dispositivo/);
  for(const [discovery,copy] of [['loading',/Buscando/],['ready',/No se encontraron/],['error',/falló/]]){
    await h.poll({...playing,phase:'idle',selected_device:null,devices:[],can_change_device:true,device_discovery:discovery,device_error:'La búsqueda falló. Reintentá.'});
    assert.match($('device-status').textContent,copy);assert.equal($('start').disabled,true);
  }
  assert.equal(h.requests.filter(playbackPost).length,0);
});
test('device UUID remains checked through reorder and terminal owned states still offer Stop',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  await h.poll({...playing,devices:[...destination.devices].reverse(),phase:'ended'});
  const rows=$('device-list').children.filter(n=>n.deviceRadio);
  assert.equal(rows.find(n=>n.deviceRadio.checked).deviceRadio.value,'tv-a');
  $('choose-device').click();assert.equal($('device-stop').hidden,false);assert.equal($('device-stop').disabled,false);
  $('device-stop').click();await h.settle();
  assert.deepEqual(JSON.parse(h.requests.find(r=>r.path==='/api/stop').options.body),{device_id:'tv-a',device_revision:1});
});
test('cancelling or escaping in-page setup cancels its deferred start revalidation',async()=>{
  for(const close of ['escape','button']) {
    const idle={...playing,phase:'idle',source_id:null};
    const h=harness(idle);await h.settle();const $=h.element;
    $('choose-film').click();h.select('b');await h.settle();
    let resolveStatus;h.respond('/api/status',()=>new Promise(resolve=>{resolveStatus=resolve;}));
    $('start').click();await h.settle();
    if(close==='escape')h.event('keydown',{key:'Escape',target:$('setup'),preventDefault(){}});
    else $('setup-cancel').click();
    resolveStatus({ok:true,json:async()=>idle});await h.settle();
    assert.equal(h.requests.filter(playbackPost).length,0,close);
    assert.equal($('settings').open,false);
  }
});
test('idle start discovers a replacement and waits for explicit consent for its captured source',async()=>{
  const h=harness({...playing,phase:'idle',source_id:null});await h.settle();const $=h.element;
  $('choose-film').click();h.select('b');await h.settle();h.setStatus({...playing,session:'A'});
  $('start').click();await h.settle();
  assert.equal(h.requests.filter(r=>r.path==='/api/start').length,0);
  assert.equal($('confirm-panel').hidden,false);
  $('confirm-accept').click();await h.settle();
  assert.deepEqual(JSON.parse(h.requests.find(r=>r.path==='/api/start').options.body),startBody('b'));
});
test('replacement consent cannot be reused for a different source or session',async()=>{
  for(const changed of [{source_id:'c',session:'A'},{source_id:'a',session:'C'},{source_id:'a',session:'A',session_id:'new'}]) {
    const h=harness({...playing,session:'A',session_id:'old'});await h.settle();const $=h.element;
    $('change-source').click();h.select('b');await h.settle();$('start').click();
    h.setStatus({...playing,session:'A',session_id:'old',...changed});$('confirm-accept').click();await h.settle();
    assert.equal(h.requests.filter(r=>r.path==='/api/start').length,0,JSON.stringify(changed));
    assert.equal($('confirm-panel').hidden,false);
    $('confirm-cancel').click();assert.equal($('source-panel').hidden,false);
    assert.equal(h.requests.filter(r=>r.path==='/api/start').length,0);
  }
});
test('rejected or timed out seek clears fictional preparation and retains the error',async()=>{
  for(const timeout of [false,true]) {
    const h=harness(playing);await h.settle();const $=h.element;
    h.respond('/api/seek',async()=>{
      if(timeout){const error=Error('timeout');error.name='AbortError';throw error;}
      return {ok:false,status:400,json:async()=>({message:'Salto rechazado'})};
    });
    $('forward').click();await h.settle();await h.poll(playing);
    assert.equal($('operation').hidden,true);
    assert.equal($('cancel-operation').hidden,true);assert.equal($('mini-cancel').hidden,true);
    assert.equal($('elapsed').textContent,'0:50');
    assert.match($('error-text').textContent,timeout?/tardó demasiado.*Revisá el estado/:/Salto rechazado/);
    await h.poll({...playing,phase:'preparing',pending:true,message:'Preparando la película para la TV…'});
    assert.equal($('operation').hidden,false);assert.doesNotMatch($('operation-text').textContent,/Destino/);
  }
});
test('an older rejected seek cannot clear a newer seek target after cleanup',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  let finishOld;h.respond('/api/seek',()=>new Promise(resolve=>{finishOld=resolve;}));
  $('forward').click();await h.settle();
  h.setStatus({...playing,phase:'stopped'});$('cancel-operation').click();await h.settle();
  await h.poll(playing);h.respond('/api/seek',async()=>({ok:true,json:async()=>({accepted:true})}));
  $('back').click();await h.settle();assert.match($('operation-text').textContent,/Destino 0:20/);
  finishOld({ok:false,status:400,json:async()=>({message:'Rechazo anterior'})});await h.settle();
  assert.match($('operation-text').textContent,/Destino 0:20/);assert.equal($('operation').hidden,false);
});
test('real preparation phases override generic sending in main mini and seek operation',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  h.respond('/api/seek',async()=>{
    h.setStatus({...playing,phase:'preparing',pending:true,command_pending:true,message:'Preparando la película para la TV…'});
    return {ok:true,json:async()=>({accepted:true})};
  });
  $('forward').click();await h.settle();
  for(const phase of ['preparing','buffering','loading']) {
    await h.poll({...playing,phase,pending:true,command_pending:true,message:'Preparando la película para la TV…'});
    for(const id of ['message','mini-status','operation-text']) {
      assert.match($(id).textContent,/Preparando la película para la TV…/);
      assert.doesNotMatch($(id).textContent,/Enviando/);
    }
    assert.match($('operation-text').textContent,/Destino 1:20/);
    assert.equal($('toggle').disabled,true);assert.equal($('mini-cancel').hidden,false);
  }
});
test('timeline release keeps a draft until explicit Apply, or Cancel discards it',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $('timeline').value=120;$('timeline').oninput();$('timeline').onchange();await h.settle();
  assert.equal(h.requests.filter(playbackPost).length,0);
  await h.poll({...playing,absolute_time:60});assert.equal(Number($('timeline').value),120);
  $('seek-apply').click();await h.settle();
  assert.deepEqual(JSON.parse(h.requests.find(r=>r.path==='/api/seek').options.body),{device_id:'tv-a',device_revision:1,position:120});
  $('timeline').value=200;$('timeline').oninput();$('seek-cancel').click();
  assert.equal(Number($('timeline').value),60);
  assert.equal(h.requests.filter(r=>r.path==='/api/seek').length,1);
});
test('native sequential volume keys restore focus and never seek the movie',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $('volume').focus();h.key('Home');await h.settle();
  assert.equal(h.document.activeElement,$('volume'));
  h.key('ArrowRight');await h.settle();
  const posts=h.requests.filter(playbackPost);
  assert.deepEqual(posts.map(r=>[r.path,JSON.parse(r.options.body)]),[['/api/volume',{device_id:'tv-a',device_revision:1,level:0}],['/api/volume',{device_id:'tv-a',device_revision:1,level:.01}]]);
});
test('later user focus supersedes command focus restoration',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $('volume').focus();h.key('Home');
  h.event('pointerdown',{target:$('change-source')});$('change-source').focus();await h.settle();
  assert.equal(h.document.activeElement,$('change-source'));
});
test('a range key during disabling keeps restoration eligible and never becomes a seek',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $('volume').focus();h.key('Home');h.key('ArrowRight');await h.settle();
  assert.equal(h.document.activeElement,$('volume'));
  h.key('ArrowRight');await h.settle();
  assert.equal(h.requests.filter(r=>r.path==='/api/seek').length,0);
  assert.equal(JSON.parse(h.requests.filter(r=>r.path==='/api/volume').at(-1).options.body).level,.01);
});
test('explicit seek actions and transport button recover their own focus',async()=>{
  for (const id of ['seek-apply','exact-apply','toggle']) {
    const h=harness(playing);await h.settle();const $=h.element;
    if(id==='seek-apply'){$('timeline').value=100;$('timeline').oninput();}
    if(id==='exact-apply'){$('position').value='0:01:00';$('exact-form').onsubmit({preventDefault(){}});}
    $(id).focus();$(id).click();
    h.key('ArrowRight');await h.settle();
    assert.equal(h.document.activeElement,$(id==='seek-apply'?'timeline':id==='exact-apply'?'position':id));
    assert.equal(h.requests.filter(playbackPost).length,1);
  }
});
test('buffer display uses the actual prepared interval and clears on source preparation',async()=>{
  const h=harness({...playing,duration:1000,buffered_start:600,buffered_end:690,buffer_ahead_seconds:30});await h.settle();const $=h.element;
  assert.equal($('buffer-range').style.left,'60%');assert.equal($('buffer-range').style.width,'9%');
  assert.match($('buffer-status').textContent,/30 s preparados/);
  await h.poll({...playing,phase:'preparing',source_id:'b',buffered_start:null,buffered_end:null,buffer_ahead_seconds:null});
  assert.equal($('buffer-range').hidden,true);assert.match($('buffer-status').textContent,/sin datos/);
});
test('same error text has new occurrence after retry, stable polls stay dismissed',async()=>{
  const first={...playing,action_error:'No se pudo silenciar',action_error_revision:1};
  const h=harness(first);await h.settle();const $=h.element;
  $('dismiss').onclick();await h.poll(first);assert.equal($('error').hidden,true);
  h.setStatus({...first,action_error_revision:2});$('mute').click();await h.settle();
  assert.equal($('error').hidden,false);assert.equal($('error-text').textContent,first.action_error);
});
test('subtitle draft follows playing source, not selection or session',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  h.delay(1.2);h.select('b');
  assert.equal($('delay-value').textContent,'+1,2 s');
  await h.poll({...playing,session:'seek-new',absolute_time:100});assert.equal($('delay-value').textContent,'+1,2 s');
  await h.poll({...playing,source_id:'b',subtitle_delay_ms:-500});assert.equal($('delay-value').textContent,'−0,5 s');
});
test("replacement dialog cancels, validates captured selection and accepts explicitly",async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  h.select("a");$('setup-subtitle').value='text-a';$('setup-subtitle').onchange();assert.equal($("start").disabled,true);
  assert.equal($("start").textContent,"Ya está en la TV");
  h.select("b");$("start").focus();$("start").click();
  assert.equal($("settings").open,true);assert.equal(h.requests.filter(playbackPost).length,0);
  $("confirm-cancel").click();assert.equal($("settings").open,false);assert.equal(h.document.activeElement,$("start"));
  $("start").click();await h.poll({...playing,sources:[playing.sources[0]]});$("confirm-accept").click();await h.settle();
  assert.equal(h.requests.filter(playbackPost).length,0);
  await h.poll(playing);h.select("b");$("start").click();$("confirm-accept").click();await h.settle();
  assert.deepEqual(JSON.parse(h.requests.find(r=>r.path==="/api/start").options.body),startBody('b'));
});
test("stop dialog Escape cancels and acceptance alone stops; preparation cancels immediately",async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $("stop").focus();$("stop").click();assert.equal($("settings").open,true);
  $("settings").oncancel({preventDefault(){}});assert.equal($("settings").open,false);
  assert.equal(h.document.activeElement,$("stop"));assert.equal(h.requests.filter(playbackPost).length,0);
  $("stop").click();$("confirm-accept").click();await h.settle();assert.equal(h.requests.filter(r=>r.path==="/api/stop").length,1);
  assert.deepEqual(JSON.parse(h.requests.find(r=>r.path==='/api/stop').options.body),{device_id:'tv-a',device_revision:1,playback_id:'play-a'});
  await h.poll({...playing,phase:"preparing"});$("stop").click();await h.settle();assert.equal(h.requests.filter(r=>r.path==="/api/stop").length,2);
  assert.deepEqual(JSON.parse(h.requests.filter(r=>r.path==='/api/stop').at(-1).options.body),{device_id:'tv-a',device_revision:1});
});
test('Stop consent is revalidated before it can affect a different playback instance',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $('stop').click();h.setStatus({...playing,playback_id:'play-next'});
  $('confirm-accept').click();await h.settle();
  assert.equal(h.requests.filter(r=>r.path==='/api/stop').length,0);
  assert.match($('error-text').textContent,/otra sesión/);
});
test("shortcuts require the remote itself; button Space and Enter activate only once",async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $("toggle").focus();h.key("m");h.key('ArrowRight');await h.settle();assert.equal(h.requests.filter(playbackPost).length,0);
  $("toggle").focus();h.key(" ");await h.settle();assert.equal(h.requests.filter(r=>r.path==="/api/pause").length,1);
  $("remote").focus();h.key("ArrowRight");await h.settle();assert.equal(h.requests.filter(r=>r.path==="/api/seek").length,1);
  $("toggle").focus();h.key("Enter");await h.settle();assert.equal(h.requests.filter(r=>r.path==="/api/pause").length,2);
});
test('caption visibility drafts wait for Apply and visibility-only never reloads delay',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $('open-subtitles').click();$('subtitles').checked=false;$('subtitles').onchange();
  $('close-sheet').click();await h.poll(playing);$('open-subtitles').click();
  assert.equal($('subtitles').checked,false);assert.equal(h.requests.filter(playbackPost).length,0);
  h.respond('/api/subtitles',async()=>{h.setStatus({...fixture(playing),subtitles_enabled:false,subtitle_choice:{...fixture(playing).subtitle_choice,enabled:false}});return {ok:true,json:async()=>({accepted:true})};});
  $('apply').click();await h.settle();
  assert.deepEqual(h.requests.filter(playbackPost).map(r=>[r.path,JSON.parse(r.options.body)]),[['/api/subtitles',captionBody(false)]]);
  assert.match($('subtitle-actual').textContent,/ocultos/);assert.equal($('apply').disabled,true);
});
test('caption mutations wait for readback, report a partial failure, and retain unapplied draft',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $('subtitles').checked=false;$('subtitles').onchange();h.delay(.2);
  h.respond('/api/subtitles',async()=>{h.setStatus({...playing,command_pending:true});return {ok:true,json:async()=>({accepted:true})};});
  $('apply').click();await h.settle();
  assert.equal(h.requests.filter(r=>r.path==='/api/delay').length,0);
  await h.poll({...playing,subtitles_enabled:false,action_error:'No se pudo ajustar el tiempo',action_error_revision:1});
  assert.deepEqual(h.requests.filter(playbackPost).map(r=>[r.path,JSON.parse(r.options.body)]),[['/api/subtitles',captionBody(false,200)]]);
  assert.match($('error-text').textContent,/visibilidad ya cambió/);assert.match($('subtitle-actual').textContent,/ocultos · \+0,0 s/);
  assert.equal($('delay-value').textContent,'+0,2 s');assert.equal($('apply').disabled,false);
  await h.poll({...playing,subtitles_enabled:false});assert.match($('error-text').textContent,/visibilidad ya cambió/);
});
test('a rejected timing change does not claim visibility changed when it was already hidden',async()=>{
  const initial={...fixture(playing),subtitles_enabled:false,subtitle_choice:{...fixture(playing).subtitle_choice,enabled:false}};
  const h=harness(initial);await h.settle();const $=h.element;h.delay(.2);
  h.respond('/api/subtitles',async()=>({ok:false,json:async()=>({message:'No se pudo ajustar el tiempo.'})}));
  $('apply').click();await h.settle();
  assert.doesNotMatch($('error-text').textContent,/visibilidad ya cambió/);
  assert.match($('error-text').textContent,/borrador sigue disponible/);
  assert.equal($('apply').disabled,false);
});
test('scrubbing previews locally, dirty delay survives polling, and missing selection clears', async()=>{
  const initial = {phase:'playing', message:'Reproduciendo', duration:500, absolute_time:20,
    volume:null, muted:null, subtitle_delay_ms:0, subtitles_enabled:true, sources:[{id:'a',title:'Alpha',filename:'Alpha.mkv'},{id:'b',title:'Beta'}]};
  const h=harness(initial); await h.settle(); const $=h.element;
  assert.equal(h.selected(),''); assert.equal($('start').disabled,true);
  h.select('a'); assert.equal($('start').disabled,false);
  assert.equal($('volume').disabled,true); assert.equal($('volume-value').textContent,'—');
  $('timeline').value=100; $('timeline').oninput();
  assert.equal($('seek-destination').textContent,'Ir a 1:40');
  assert.equal(h.requests.filter(playbackPost).length,0);
  h.delay(1.2);
  await h.poll({...initial,absolute_time:30,sources:[initial.sources[1],initial.sources[0]]});
  assert.equal($('timeline').value,100); assert.equal(h.selected(),'a');assert.equal($('delay-value').textContent,'+1,2 s');
  await h.poll({...initial,phase:'receiver_changed',sources:[initial.sources[1]]});
  assert.equal(h.selected(),''); assert.equal($('start').disabled,true);
  assert.equal($('toggle').disabled,true);assert.equal($('stop').disabled,false);
});
test('backend errors survive polls and can be dismissed',async()=>{
  const status={phase:'playing',sources:[],action_error:'No se pudo aplicar',absolute_time:0};
  const h=harness(status);await h.settle();const $=h.element;
  assert.equal($('error-text').textContent,'No se pudo aplicar');
  await h.poll({...status,message:'Reproduciendo'});assert.equal($('error').hidden,false);
  $('dismiss').onclick(); await h.poll(status); assert.equal($('error').hidden,true);
});

test("dialog blocks player shortcuts and native Space cancels without commands",async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $("stop").focus();$("stop").click();assert.equal(h.document.activeElement,$("confirm-cancel"));
  h.key("m");h.key("ArrowRight");await h.settle();
  assert.equal(h.requests.filter(playbackPost).length,0);
  h.key(" ");assert.equal($("settings").open,false);assert.equal(h.document.activeElement,$("stop"));
  assert.equal(h.requests.filter(playbackPost).length,0);
});
test("replacement captures identity through reorder and changing selection sends nothing",async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  h.select("b");$("start").click();
  await h.poll({...playing,sources:[playing.sources[1],playing.sources[0]]});
  assert.equal(h.requests.filter(playbackPost).length,0);
  $("confirm-accept").click();await h.settle();
  assert.deepEqual(JSON.parse(h.requests.find(r=>r.path==="/api/start").options.body),startBody('b'));
});
test("foreign receiver cancellation is immediate",async()=>{
  const h=harness({...playing,phase:"receiver_changed"});await h.settle();
  h.element("stop").click();await h.settle();assert.equal(h.element("settings").open,false);
  assert.equal(h.requests.filter(r=>r.path==="/api/stop").length,1);
});
test('delay-only captions use the atomic subtitle command and read back the paused state',async()=>{
  const paused={...playing,phase:'paused'};
  const h=harness(paused);await h.settle();const $=h.element;
  h.delay(-.1);
  h.respond('/api/subtitles',async()=>{h.setStatus({...paused,subtitle_delay_ms:-100});return {ok:true,json:async()=>({accepted:true})};});
  $('apply').click();await h.settle();
  assert.deepEqual(h.requests.filter(playbackPost).map(r=>[r.path,JSON.parse(r.options.body)]),[['/api/subtitles',captionBody(true,-100)]]);
  assert.equal($('delay-value').textContent,'−0,1 s');assert.match($('mini-status').textContent,/En pausa/);
});
test('caption worker failure keeps a partial error after healthy polls and permits retry',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $('subtitles').checked=false;$('subtitles').onchange();h.delay(.1);
  h.respond('/api/subtitles',async()=>{h.setStatus({...playing,subtitles_enabled:false});return {ok:true,json:async()=>({accepted:true})};});
  $('apply').click();await h.settle();
  const failed={...playing,subtitles_enabled:false,action_error:'Falló el ajuste',action_error_revision:1};
  await h.poll(failed);assert.match($('error-text').textContent,/visibilidad ya cambió/);assert.equal($('apply').disabled,false);
  await h.poll({...failed,action_error:null});assert.match($('error-text').textContent,/visibilidad ya cambió/);
  $('dismiss').click();await h.poll(failed);assert.equal($('error').hidden,true);
  await h.poll({...failed,action_error_revision:2});assert.equal($('error').hidden,false);
});
test('busy and foreign states block transport, captions and takeover, while cleanup stays immediate',async()=>{
  for(const changes of [{pending:true},{command_pending:true},{phase:'preparing'},{phase:'buffering'},{phase:'loading'},{phase:'receiver_changed'},{phase:'disconnected'}]){
    const h=harness({...playing,...changes});await h.settle();const $=h.element;
    h.select('b');
    for(const id of ['toggle','mini-play','back','forward','timeline','volume','mute','subtitles','apply','start'])assert.equal($(id).disabled,true,`${id} blocked for ${JSON.stringify(changes)}`);
    $('toggle').click();$('start').click();$('mini-cancel').click();await h.settle();
    assert.deepEqual(h.requests.filter(playbackPost).map(r=>r.path),['/api/stop']);
  }
});
test('offline retains context, distinguishes uncertainty and disables unsafe actions',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  h.respond('/api/status',async()=>{throw Error('offline');});await h.poll(playing);
  assert.equal($('title').textContent,'Alpha');assert.equal($('elapsed').textContent,'0:50');
  assert.match($('message').textContent,/sin conexión/);assert.match($('problem-copy').textContent,/No se puede confirmar/);
  for(const id of ['toggle','start','stop','mute'])assert.equal($(id).disabled,true);
});
test('a replacement revalidates busy ownership and Escape restores in-page setup focus',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $('change-source').click();h.select('b');$('start').click();
  assert.equal($('settings').open,true);assert.equal($('source-panel').hidden,false);assert.equal($('confirm-panel').hidden,false);
  $('settings').oncancel({preventDefault(){}});assert.equal($('settings').open,false);assert.equal($('source-panel').hidden,false);assert.equal(h.document.activeElement,$('start'));
  $('start').click();await h.poll({...playing,phase:'receiver_changed'});$('confirm-accept').click();await h.settle();
  assert.equal(h.requests.filter(r=>r.path==='/api/start').length,0);
  $('settings').oncancel({preventDefault(){}});assert.equal($('settings').open,false);assert.equal(h.document.activeElement,$('remote'));
});
test('exact time reviews locally, validates bounds and applies only the reviewed value',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $('open-more').click();$('position').value='8:21';$('exact-form').onsubmit({preventDefault(){}});
  assert.equal($('exact-error').hidden,false);assert.equal(h.requests.filter(r=>r.path==='/api/seek').length,0);
  $('position').value='02:10';$('exact-form').onsubmit({preventDefault(){}});$('position').value='03:00';
  assert.equal(h.requests.filter(r=>r.path==='/api/seek').length,0);
  $('exact-apply').click();await h.settle();assert.deepEqual(JSON.parse(h.requests.find(r=>r.path==='/api/seek').options.body),{device_id:'tv-a',device_revision:1,position:130});
});
test('stale polls are fenced after a command and no optimistic phase is invented',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  let resolveOld;h.respond('/api/status',()=>new Promise(resolve=>{resolveOld=resolve;}));
  const old=h.poll(playing);await h.settle();
  $('toggle').click();await h.settle();
  assert.match($('message').textContent,/Enviando/);
  h.respond('/api/status',async()=>({ok:true,json:async()=>({...playing,phase:'paused',title:'Actual'})}));
  resolveOld({ok:true,json:async()=>({...playing,phase:'playing',title:'Obsoleto'})});await old;await h.settle();
  assert.equal($('title').textContent,'Actual');assert.match($('message').textContent,/En pausa/);
});
test('stop interrupts an inflight request and its late result cannot overwrite cleanup',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  let finishSeek;h.respond('/api/seek',()=>new Promise(resolve=>{finishSeek=resolve;}));
  $('forward').click();await h.settle();assert.equal($('mini-play').disabled,true);
  h.setStatus({...playing,phase:'stopped'});$('cancel-operation').click();await h.settle();
  assert.equal(h.requests.filter(r=>r.path==='/api/stop').length,1);assert.equal($('empty-view').hidden,false);
  finishSeek({ok:true,json:async()=>({accepted:true})});await h.settle();assert.equal($('empty-view').hidden,false);
});
test('unknown values and production mode do not expose synthetic claims or scenario mutations',async()=>{
  const h=harness({phase:'idle',sources:[],duration:null,absolute_time:null,volume:null,muted:null});await h.settle();const $=h.element;
  for(const id of ['elapsed','total','volume-value','delay-value'])assert.equal($(id).textContent,'—');
  for(const id of ['demo-banner','sheet-demo','qa'])assert.equal($(id).hidden,true);
  $('scenario').value='ready';$('scenario').onchange();await h.settle();assert.equal(h.requests.filter(playbackPost).length,0);
  await h.poll({...playing,demo:true});$('open-subtitles').click();assert.equal($('sheet-demo').hidden,false);assert.equal($('demo-banner').hidden,false);
});

test('device selection binds the current revision at click, including initial zero and rejected stale tabs',async()=>{
  const idle={...playing,phase:'idle',selected_device:null,device_revision:0,can_change_device:true};
  const stale=harness(idle), current=harness(idle);await stale.settle();await current.settle();
  const staleRadio=stale.element('device-list').children.find(n=>n.deviceRadio?.value==='tv-b').deviceRadio;
  const currentRadio=current.element('device-list').children.find(n=>n.deviceRadio?.value==='tv-b').deviceRadio;
  await current.poll({...idle,selected_device:destination.selected_device,device_revision:2});
  currentRadio.onchange();await current.settle();
  assert.deepEqual(JSON.parse(current.requests.find(r=>r.path==='/api/select_device').options.body),{device_id:'tv-b',device_revision:2});
  stale.respond('/api/select_device',async()=>({ok:false,status:400,json:async()=>({message:'El destino cambió. Revisá el dispositivo.'})}));
  staleRadio.onchange();await stale.settle();
  assert.deepEqual(JSON.parse(stale.requests.find(r=>r.path==='/api/select_device').options.body),{device_id:'tv-b',device_revision:0});
  assert.match(stale.element('error-text').textContent,/destino cambió/);
  assert.equal(stale.element('settings').open,false);
  assert.match(stale.element('destination-name').textContent,/Sin dispositivo/);
});

test('refresh requests are independent and never disable active transport or subtitle Apply',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  h.delay(.1);
  let finishDevices,finishSources;
  h.respond('/api/discover_devices',()=>new Promise(resolve=>{finishDevices=resolve;}));
  h.respond('/api/discover',()=>new Promise(resolve=>{finishSources=resolve;}));
  $('discover-devices').click();
  assert.equal($('discover-devices').disabled,true);assert.equal($('discover').disabled,false);
  $('discover').click();
  for(const id of ['toggle','back','volume','apply'])assert.equal($(id).disabled,false,id);
  assert.match($('device-status').textContent,/Buscando/);assert.match($('source-status').textContent,/Buscando/);
  finishDevices({ok:true,json:async()=>({accepted:true})});await h.settle();
  assert.equal($('discover-devices').disabled,false);assert.equal($('discover').disabled,true);
  finishSources({ok:false,json:async()=>({message:'Falló la búsqueda de películas. Actualizá para reintentar.'})});await h.settle();
  assert.match($('source-status').textContent,/Falló/);assert.equal($('toggle').disabled,false);
});
test('catalogue offers every language, explains disabled images, defaults to none and starts explicitly',async()=>{
  for(const id of [null,'text-b']) {
    const h=harness({...playing,phase:'idle',source_id:null});await h.settle();const $=h.element;
    h.select('b');await h.settle();
    assert.equal($('setup-subtitle').value,'');
    const options=$('setup-subtitle').children;
    assert.match(options.find(n=>n.value==='text-b').textContent,/jpn/);
    assert.equal(options.find(n=>n.value==='image-b').disabled,true);
    assert.match(options.find(n=>n.value==='image-b').textContent,/imagen/);
    if(id){$('setup-subtitle').value=id;$('setup-subtitle').onchange();}
    assert.match($('setup-summary').textContent,/Beta/);assert.match($('start-destination').textContent,/Sala/);
    assert.equal(h.requests.filter(r=>r.path==='/api/start').length,0);
    $('start').click();await h.settle();
    assert.deepEqual(JSON.parse(h.requests.find(r=>r.path==='/api/start').options.body),{...startBody('b'),subtitle_id:id});
  }
});
test('catalogue loading errors and refresh stay local and preserve the last usable snapshot',async()=>{
  const h=harness({...playing,catalogues:{}});await h.settle();const $=h.element;
  h.respond('/api/catalogue',async()=>({ok:true,json:async()=>({accepted:true,source_id:'b',analysis_id:'analysis-b'})}));
  h.select('b');await h.settle();
  assert.match($('catalogue-status').textContent,/Consultando/);assert.equal($('start').disabled,true);assert.equal($('toggle').disabled,false);
  await h.poll({...playing,catalogues:{b:{state:'error',analysis_id:'analysis-b',message:'No se pudo analizar. Actualizá las pistas.'}}});
  assert.match($('catalogue-status').textContent,/No se pudo/);
  h.respond('/api/catalogue',async()=>({ok:true,json:async()=>({catalogue:catalogue('b')})}));
  $('refresh-catalogue').click();await h.settle();assert.equal($('setup-subtitle').disabled,false);
  await h.poll({...playing,catalogues:{b:{state:'ready',catalogue:catalogue('b')}},source_discovery:'loading',device_discovery:'loading'});
  assert.equal($('start').disabled,false);assert.equal($('toggle').disabled,false);
  h.respond('/api/catalogue',async()=>({ok:false,json:async()=>({message:'Error de análisis. Actualizá para reintentar.'})}));
  $('refresh-catalogue').click();await h.settle();
  assert.match($('catalogue-status').textContent,/Error de análisis/);
  assert.equal($('setup-subtitle').children.length,3);assert.equal($('toggle').disabled,false);
});
const uploadFile = (name,bytes,size=bytes.byteLength) => ({name,size,arrayBuffer:async()=>bytes});
const validSrt = new TextEncoder().encode('1\n00:00:01,000 --> 00:00:03,000\nHello\n').buffer;
test('local upload uses fatal UTF-8 bytes, bounded files and filename labels, not file.text',async()=>{
  for(const [file,message] of [
    [uploadFile('captions.srt',new Uint8Array([0xc3,0x28]).buffer),/UTF-8 válido/],
    [uploadFile('captions.srt',validSrt,1024*1024+1),/1 MiB/],
    [uploadFile('captions.ass',validSrt),/\.srt o \.vtt/],
  ]) {
    const h=harness(playing);await h.settle();const $=h.element;h.select('b');await h.settle();
    $('subtitle-file').files=[file];await $('subtitle-file').onchange();
    assert.equal(h.requests.filter(r=>r.path==='/api/subtitle_upload').length,0);
    assert.match($('upload-status').textContent,message);assert.equal($('toggle').disabled,false);
  }
  const h=harness(playing);await h.settle();const $=h.element;h.select('b');await h.settle();
  const entry={id:'upload-b',kind:'upload',label:'captions.srt',language:null,supported:true};
  const uploaded={...catalogue('b'),entries:[...catalogue('b').entries,entry]};
  h.respond('/api/subtitle_upload',async()=>({ok:true,json:async()=>({entry,catalogue:uploaded})}));
  $('subtitle-file').files=[uploadFile('../private/captions.srt',validSrt)];await $('subtitle-file').onchange();
  assert.deepEqual(JSON.parse(h.requests.find(r=>r.path==='/api/subtitle_upload').options.body),{source_id:'b',catalogue_id:'cat-b',filename:'captions.srt',format:'srt',text:'1\n00:00:01,000 --> 00:00:03,000\nHello\n'});
  assert.equal($('setup-subtitle').value,'upload-b');assert.equal($('subtitle-label').textContent,'Subtítulos · Visibles');
  await h.poll(playing);assert.equal($('setup-subtitle').value,'upload-b');
  assert.equal(h.requests.filter(r=>r.path==='/api/subtitles').length,0);
});
test('malformed subtitle content is reported without selecting a track or disturbing playback',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;h.select('b');await h.settle();
  h.respond('/api/subtitle_upload',async()=>({ok:false,json:async()=>({message:'El archivo no contiene cues válidos. Corregilo y reintentá.'})}));
  $('subtitle-file').files=[uploadFile('broken.vtt',new TextEncoder().encode('WEBVTT\nnot a cue').buffer)];await $('subtitle-file').onchange();
  assert.match($('upload-status').textContent,/cues válidos/);assert.equal($('setup-subtitle').value,'');assert.equal($('toggle').disabled,false);
});
test('late upload reads and responses cannot select a different movie or an abandoned draft',async()=>{
  for(const mode of ['read','movie','cancel','choice','refresh']) {
    const h=harness(playing);await h.settle();const $=h.element;h.select('b');await h.settle();
    let finish;
    const entry={id:'upload-b',kind:'upload',label:'local.srt',supported:true};
    if(mode==='read')$('subtitle-file').files=[{name:'local.srt',size:1,arrayBuffer:()=>new Promise(resolve=>{finish=resolve;})}];
    else {
      $('subtitle-file').files=[uploadFile('local.srt',validSrt)];
      h.respond('/api/subtitle_upload',()=>new Promise(resolve=>{finish=resolve;}));
    }
    const upload=$('subtitle-file').onchange();await h.settle();
    assert.equal($('toggle').disabled,false);
    if(mode==='read'||mode==='movie')h.select('a');
    else if(mode==='cancel')$('setup-cancel').click();
    else if(mode==='choice'){$('setup-subtitle').value='text-b';$('setup-subtitle').onchange();}
    else $('refresh-catalogue').click();
    if(mode==='read')finish(validSrt);
    else finish({ok:true,json:async()=>({entry,catalogue:{...catalogue('b'),entries:[entry]}})});
    await upload;await h.settle();
    assert.notEqual($('setup-subtitle').value,'upload-b',mode);
    if(mode==='read')assert.equal(h.requests.filter(r=>r.path==='/api/subtitle_upload').length,0);
  }
});
test('late catalogue responses and refreshed ids cannot overwrite another movie draft or start an old plan',async()=>{
  const h=harness({...playing,phase:'idle',source_id:null,catalogues:{}});await h.settle();const $=h.element;
  let finish;
  h.respond('/api/catalogue',()=>new Promise(resolve=>{finish=resolve;}));h.select('b');await h.settle();
  const old=finish;
  h.select('a');await h.settle();
  old({ok:true,json:async()=>({catalogue:catalogue('b')})});await h.settle();
  assert.equal($('setup-subtitle').children.length,1);assert.equal($('start').disabled,true);
  finish({ok:true,json:async()=>({catalogue:catalogue('a')})});await h.settle();
  let status;
  h.respond('/api/status',()=>new Promise(resolve=>{status=resolve;}));$('start').click();await h.settle();
  status({ok:true,json:async()=>fixture({...playing,phase:'idle',source_id:null,catalogues:{a:{state:'ready',catalogue:{...catalogue('a'),id:'cat-new'}}}})});await h.settle();
  assert.equal(h.requests.filter(r=>r.path==='/api/start').length,0);
});
test('full plan deduplication does not confuse the same movie with a different subtitle plan',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  h.select('a');await h.settle();assert.equal($('start').disabled,false);
  $('setup-subtitle').value='text-a';$('setup-subtitle').onchange();assert.equal($('start').disabled,true);
  $('setup-subtitle').value='';$('setup-subtitle').onchange();$('start').click();
  h.setStatus({...playing,playback_id:'play-new'});$('confirm-accept').click();await h.settle();
  assert.equal(h.requests.filter(r=>r.path==='/api/start').length,0);assert.equal($('confirm-panel').hidden,false);
});
test('stale subtitle Apply is fenced by playback instance and active catalogue before submission',async()=>{
  for(const change of [{playback_id:'play-new'},{active_catalogue:{...catalogue('a'),id:'cat-new'}}]) {
    const h=harness(playing);await h.settle();const $=h.element;h.delay(.2);
    let finish;h.respond('/api/status',()=>new Promise(resolve=>{finish=resolve;}));
    $('apply').click();await h.settle();
    finish({ok:true,json:async()=>fixture({...playing,...change})});await h.settle();
    assert.equal(h.requests.filter(r=>r.path==='/api/subtitles').length,0);
  }
});
test('accepted caption plan never claims receiver visibility while readback remains unknown',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $('active-subtitle').value='';$('active-subtitle').onchange();
  h.respond('/api/subtitles',async()=>{h.setStatus({...fixture(playing),subtitles_enabled:null,subtitle_choice:{catalogue_id:'cat-a',subtitle_id:null,enabled:false,delay_ms:0}});return {ok:true,json:async()=>({accepted:true})};});
  $('apply').click();await h.settle();
  assert.deepEqual(JSON.parse(h.requests.find(r=>r.path==='/api/subtitles').options.body),{...captionBody(false),subtitle_id:null});
  assert.match($('subtitle-actual').textContent,/sin confirmar/);assert.doesNotMatch($('subtitle-actual').textContent,/ocultos/);
  assert.equal(h.requests.filter(r=>r.path==='/api/delay').length,0);
  assert.equal($('active-subtitle').disabled,false);
  $('active-subtitle').value='text-a';$('active-subtitle').onchange();
  assert.equal($('apply').disabled,false);
});
test('a queued native dialog close event after confirmation acceptance does not abandon the accepted start',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;h.select('b');await h.settle();$('start').click();
  let finish;h.respond('/api/status',()=>new Promise(resolve=>{finish=resolve;}));
  $('confirm-accept').click();await h.settle();
  $('settings').onclose();
  h.respond('/api/status',async()=>({ok:true,json:async()=>fixture(playing)}));
  finish({ok:true,json:async()=>fixture(playing)});await h.settle();
  assert.deepEqual(JSON.parse(h.requests.find(r=>r.path==='/api/start').options.body),startBody('b'));
});
test('changing a captured setup selection invalidates replacement consent without sending playback',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;h.select('b');await h.settle();$('start').click();
  h.select('a');$('confirm-accept').click();await h.settle();
  assert.equal(h.requests.filter(r=>r.path==='/api/start').length,0);
});
test('late Start and subtitle Apply receipts cannot overwrite an abandoned setup or a new playback draft',async()=>{
  const h=harness({...playing,phase:'idle',source_id:null});await h.settle();const $=h.element;h.select('b');await h.settle();
  let finishStart;h.respond('/api/start',()=>new Promise(resolve=>{finishStart=resolve;}));
  $('start').click();await h.settle();$('setup-cancel').click();
  finishStart({ok:true,json:async()=>({accepted:true})});await h.settle();
  assert.equal(h.selected(),'');assert.equal($('setup-subtitle').value,'');
  await h.poll(playing);h.delay(.1);
  let finishApply;h.respond('/api/subtitles',()=>new Promise(resolve=>{finishApply=resolve;}));
  $('apply').click();await h.settle();
  await h.poll({...playing,source_id:'b',playback_id:'play-b',subtitle_delay_ms:-500});
  finishApply({ok:false,json:async()=>({message:'Rechazo de la sesión anterior'})});await h.settle();
  assert.equal($('delay-value').textContent,'−0,5 s');
  assert.doesNotMatch($('error-text').textContent || '',/sesión anterior/);
});
test('a delayed cached catalogue receipt cannot erase a newer uploaded entry in the same catalogue',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  let finish;h.respond('/api/catalogue',()=>new Promise(resolve=>{finish=resolve;}));
  h.select('b');await h.settle();
  const entry={id:'upload-b',kind:'upload',label:'local.srt',supported:true};
  h.respond('/api/subtitle_upload',async()=>({ok:true,json:async()=>({entry,catalogue:{...catalogue('b'),entries:[...catalogue('b').entries,entry]}})}));
  $('subtitle-file').files=[uploadFile('local.srt',validSrt)];await $('subtitle-file').onchange();
  finish({ok:true,json:async()=>({catalogue:catalogue('b')})});await h.settle();
  assert.equal($('setup-subtitle').value,'upload-b');
  assert.ok($('setup-subtitle').children.some(n=>n.value==='upload-b'));
  assert.equal($('start').disabled,false);
});
test('failed discovery retains its choices but blocks a new Start without disabling owned transport',async()=>{
  for(const discovery of [{source_discovery:'error',source_error:'No se pudo confirmar la caché. Actualizá.'},{device_discovery:'error',device_error:'No se pudo confirmar la red. Actualizá.'}]) {
    const h=harness(playing);await h.settle();const $=h.element;h.select('b');await h.settle();
    await h.poll({...playing,...discovery});
    assert.equal(h.selected(),'b');assert.equal($('start').disabled,true);assert.equal($('toggle').disabled,false);
    assert.equal($('device-list').children.find(n=>n.deviceRadio?.checked).deviceRadio.value,'tv-a');
  }
});
test('no-subtitle playback remains available when the movie has no text tracks',async()=>{
  for(const entries of [[],catalogue('b').entries.filter(e=>!e.supported)]) {
    const h=harness({...playing,phase:'idle',source_id:null,catalogues:{b:{state:'ready',catalogue:{...catalogue('b'),entries}}}});await h.settle();const $=h.element;
    h.select('b');await h.settle();
    assert.equal($('setup-subtitle').value,'');assert.equal($('start').disabled,false);
    $('start').click();await h.settle();
    assert.deepEqual(JSON.parse(h.requests.find(r=>r.path==='/api/start').options.body),startBody('b'));
  }
});
test('active playback leads in DOM and opens on the remote with both editors collapsed',async()=>{
  assert.ok(html.indexOf('id="remote"')<html.indexOf('id="setup"'));
  assert.doesNotMatch(html,/\border\s*:/);
  const h=harness(playing);await h.settle();const $=h.element;
  assert.equal($('remote').hidden,false);assert.equal($('setup').hidden,true);assert.equal($('subtitles-panel').hidden,true);
  assert.equal($('title').textContent,'Alpha');assert.equal($('toggle').disabled,false);
  $('change-source').click();assert.equal($('setup').hidden,false);assert.equal($('settings').open,false);
  assert.equal($('setup-title').textContent,'Elegir otra película');
  h.select('b');await h.settle();
  assert.equal($('title').textContent,'Alpha');assert.equal($('start').textContent,'Cambiar película en la TV');
  assert.equal($('setup-subtitles-heading').textContent,'Subtítulos para Beta');
  assert.equal($('subtitles-panel').hidden,true);
  $('open-subtitles').click();assert.equal($('subtitles-panel').hidden,false);assert.equal($('active-movie').textContent,'Alpha');
  assert.equal($('settings').open,false);
});
test('idle setup hides the remote and defers subtitle upload and review until a movie is selected',async()=>{
  const h=harness({...playing,phase:'idle',title:null,source_id:null});await h.settle();const $=h.element;
  assert.equal($('setup').hidden,false);assert.equal($('remote').hidden,true);
  assert.equal($('setup-subtitles').hidden,true);assert.equal($('start-review').hidden,true);
  assert.equal($('source-detail').hidden,true);
  h.select('b');await h.settle();
  assert.equal($('setup-subtitles').hidden,false);assert.equal($('start-review').hidden,false);
  assert.equal($('setup-subtitle').value,'');assert.equal($('start').textContent,'Iniciar en la TV');
  h.respond('/api/start',async()=>{h.setStatus(playing);return {ok:true,json:async()=>({accepted:true})};});
  $('start').click();await h.settle();
  assert.equal($('remote').hidden,false);assert.equal($('setup').hidden,true);assert.equal($('subtitles-panel').hidden,true);
});
test('active setup Cancel and Escape close the editor and scroll and focus the remote while fencing deferred Start',async()=>{
  for(const close of ['button','escape']) {
    const h=harness(playing);await h.settle();const $=h.element;
    $('change-source').click();h.select('b');await h.settle();$('start').click();
    let finish;h.respond('/api/status',()=>new Promise(resolve=>{finish=resolve;}));
    $('confirm-accept').click();await h.settle();
    if(close==='button')$('setup-cancel').click();
    else h.event('keydown',{key:'Escape',target:$('setup'),preventDefault(){}});
    assert.equal($('setup').hidden,true,close);assert.equal($('remote').hidden,false);
    assert.equal(h.document.activeElement,$('remote'));assert.ok($('remote').scrolls>0);
    h.respond('/api/status',async()=>({ok:true,json:async()=>fixture(playing)}));
    finish({ok:true,json:async()=>fixture(playing)});await h.settle();
    assert.equal(h.requests.filter(r=>r.path==='/api/start').length,0);
    await h.poll(playing);assert.equal($('setup').hidden,true);
  }
});
test('None collapses only irrelevant active caption controls and keeps Apply and truthful readback',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  $('open-subtitles').click();assert.equal($('caption-controls').hidden,false);
  $('active-subtitle').value='';$('active-subtitle').onchange();
  assert.equal($('caption-controls').hidden,true);assert.equal($('active-subtitle').disabled,false);assert.equal($('apply').disabled,false);
  assert.equal($('subtitles-panel').hidden,false);assert.match($('subtitle-actual').textContent,/visibles/);
  assert.match(html,/id="caption-consequences">[^<]*recarga[^<]*posición actual[^<]*pausa/);
  assert.match($('subtitle-plan').textContent,/日本語/);
  $('active-subtitle').value='text-a';$('active-subtitle').onchange();assert.equal($('caption-controls').hidden,false);
});
test('upload exposes a Spanish native action filename and status without losing file validation',async()=>{
  assert.match(html,/<input id="subtitle-file"[^>]*type="file"[^>]*aria-label="Subir archivo SRT o VTT"/);
  assert.match(html,/id="upload-guidance"[^>]*>UTF-8 · Hasta 1 MiB/);
  const h=harness(playing);await h.settle();const $=h.element;h.select('b');await h.settle();
  assert.equal($('upload-action').textContent,'Subir archivo SRT / VTT');assert.equal($('upload-filename').textContent,'Sin archivo elegido');
  let finish;h.respond('/api/subtitle_upload',()=>new Promise(resolve=>{finish=resolve;}));
  $('subtitle-file').files=[uploadFile('../private/local.srt',validSrt)];const upload=$('subtitle-file').onchange();await h.settle();
  assert.equal($('upload-filename').textContent,'Archivo: local.srt');assert.match($('upload-status').textContent,/Validando y subiendo/);
  assert.equal($('subtitle-file').disabled,true);
  const entry={id:'upload-b',kind:'upload',label:'local.srt',supported:true};
  finish({ok:true,json:async()=>({entry,catalogue:{...catalogue('b'),entries:[entry]}})});await upload;
  assert.match($('upload-status').textContent,/Archivo listo: local.srt/);assert.equal($('subtitle-file').disabled,false);
  assert.equal($('upload-filename').textContent,'Archivo: local.srt');
  $('setup-cancel').click();assert.equal($('upload-filename').textContent,'Sin archivo elegido');
});
test('failed device discovery describes an unconfirmed list rather than a disconnected active TV',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  await h.poll({...playing,phase:'paused',device_discovery:'error',device_error:'La búsqueda falló.',selected_device:{...destination.selected_device,available:false}});
  assert.match($('destination-name').textContent,/Sala.*[Ll]ista sin confirmar/);assert.doesNotMatch($('destination-name').textContent,/No disponible|desconect/);
  assert.match($('device-status').textContent,/No se pudo actualizar la lista.*Actualizar dispositivos/);
  assert.equal($('problem').hidden,true);assert.equal($('toggle').disabled,false);assert.equal($('start').disabled,true);
  assert.equal((html.match(/Las listas se actualizan automáticamente/g)||[]).length,1);
});
test('confirmed playing and paused Stop send the captured playback instance while immediate cleanup stays compatible',async()=>{
  for(const phase of ['playing','paused','preparing','stopped']) {
    const h=harness({...playing,phase});await h.settle();const $=h.element;
    $('stop').click();
    if(['playing','paused'].includes(phase))$('confirm-accept').click();
    await h.settle();
    assert.deepEqual(JSON.parse(h.requests.find(r=>r.path==='/api/stop').options.body),{device_id:'tv-a',device_revision:1,...(['playing','paused'].includes(phase)?{playback_id:'play-a'}:{})});
  }
});
test('Stop revalidation cannot pass an intervening local mutation even if playback identity is unchanged',async()=>{
  const h=harness(playing);await h.settle();const $=h.element;
  let finish;h.respond('/api/status',()=>new Promise(resolve=>{finish=resolve;}));
  $('stop').click();$('confirm-accept').click();await h.settle();
  $('toggle').click();await h.settle();
  h.respond('/api/status',async()=>({ok:true,json:async()=>fixture({...playing,phase:'paused'})}));
  finish({ok:true,json:async()=>fixture(playing)});await h.settle();
  assert.equal(h.requests.filter(r=>r.path==='/api/stop').length,0);
  assert.equal(h.requests.filter(r=>r.path==='/api/pause').length,1);
});
test('markup keeps unique real IDs and resolves every label accessibility and icon reference',()=>{
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length);
  for(const match of html.matchAll(/\b(?:for|aria-labelledby|aria-describedby|aria-controls)="([^"]+)"/g)) {
    for(const id of match[1].split(/\s+/))assert.ok(markupIds.has(id),`markup reference #${id} exists`);
  }
  for(const match of html.matchAll(/\bhref="#([^"]+)"/g))assert.ok(markupIds.has(match[1]),`icon #${match[1]} exists`);
  for(const match of fs.readFileSync('player.js','utf8').matchAll(/\$\('([^']+)'\)/g))assert.ok(markupIds.has(match[1]),`script reference #${match[1]} exists`);
});
test('rejected and timed-out replacement Start keep the current draft visible for review and retry',async()=>{
  for(const timeout of [false,true]) {
    const h=harness(playing);await h.settle();const $=h.element;
    $('change-source').click();h.select('b');await h.settle();
    h.respond('/api/start',async()=>{
      if(timeout)throw Object.assign(new Error('timeout'),{name:'AbortError'});
      return {ok:false,json:async()=>({message:'No se pudo iniciar el ejemplo.'})};
    });
    $('start').click();$('confirm-accept').click();await h.settle();
    assert.equal($('setup').hidden,false);
    assert.equal(h.selected(),'b');assert.equal($('start').disabled,false);
    assert.match($('error-text').textContent,timeout?/tardó demasiado/:/No se pudo iniciar/);
  }
});
test('an older Start receipt cannot hide a newer subtitle upload draft',async()=>{
  for(const started of [false,true]) {
    const h=harness(playing);await h.settle();const $=h.element;
    $('change-source').click();h.select('b');await h.settle();
    let finishStart,finishFile;
    h.respond('/api/start',()=>new Promise(resolve=>{finishStart=resolve;}));
    $('start').click();$('confirm-accept').click();await h.settle();
    $('subtitle-file').files=[{name:'later.srt',size:40,arrayBuffer:()=>new Promise(resolve=>{finishFile=resolve;})}];
    $('subtitle-file').onchange();await h.settle();
    if(started)h.setStatus({...playing,source_id:'b',title:'Beta',playback_id:'play-b',subtitle_choice:{catalogue_id:'cat-b',subtitle_id:null,enabled:false,delay_ms:0}});
    finishStart({ok:true,json:async()=>({accepted:true})});await h.settle();
    assert.equal($('setup').hidden,false);
    assert.match($('upload-status').textContent,/subiendo/);
    $('setup-cancel').click();finishFile(new Uint8Array([65]).buffer);await h.settle();
    assert.equal(h.requests.filter(r=>r.path==='/api/subtitle_upload').length,0);
  }
});

const matchOf = (label='MobLand (2025) · T1 E7',confidence='exact') => ({label,confidence});
const offerList = [
  {id:'o-spl',language:'spl',language_name:'Español (Latinoamérica)',label:'MobLand S01E07 1080p WEB',note:null},
  {id:'o-spa',language:'spa',language_name:'Español',label:'MobLand S01E07 BluRay',note:'mismo origen'},
  {id:'o-sdh',language:'spa',language_name:'Español',label:'MobLand S01E07 SDH',note:'para sordos'},
  {id:'o-eng',language:'eng',language_name:'Inglés',label:'MobLand S01E07 WEB',note:null}];
const alternativeList = [1,2,3,4,5].map(n=>({id:'tt000000'+n,title:'Otra '+n,year:2000+n}));
const listingOf = (patch={}) => ({state:'ready',revision:1,match:matchOf(),message:null,alternatives:alternativeList.slice(0,2),offers:offerList,...patch});
const summaryOf = listing => ({state:listing.state,revision:listing.revision,match:listing.match,message:listing.message,count:listing.offers?.length||0});
const respondListing = (h,listing) => h.respond('/api/subtitle_offers',async()=>({ok:true,json:async()=>listing}));
const ok = body => ({ok:true,json:async()=>body}), failed = (message,code) => ({ok:false,json:async()=>({message,code})});
const idleB = (listing,extra={}) => ({...playing,phase:'idle',source_id:null,addons:{b:summaryOf(listing)},...extra});
const stremioEntry = (id,label='MobLand S01E07 BluRay') => ({id,kind:'addon',label,language:'spa',supported:true,reason:null});
const calls = (h,path) => h.requests.filter(r=>r.path===path).map(r=>JSON.parse(r.options.body));
const lookupFinished = listing => ({catalogue:catalogue('b',summaryOf(listing))});
async function openSetup(listing,extra={},respond=true) {
  const h=harness(idleB(listing,extra));if(respond)respondListing(h,listing);await h.settle();
  h.select('b');await h.settle();await h.settle();return h;
}
async function chooseOffer(h,id='o-spa',prefix='setup-addon') {
  const $=h.element,offer=offerList.find(o=>o.id===id);
  $(prefix+'-language').value=offer.language;$(prefix+'-language').onchange();
  $(prefix+'-version').value=id;$(prefix+'-version').onchange();
}

test('both Stremio blocks have every element the one renderer drives, with the contract copy',()=>{
  const names=[...new Set([...fs.readFileSync('player.js','utf8').matchAll(/part\('([a-z]+)'\)/g)].map(match=>match[1]))];
  assert.ok(names.length>=12);
  for(const prefix of ['setup-addon','active-addon']) {
    assert.ok(markupIds.has(prefix));
    for(const name of names)assert.ok(markupIds.has(`${prefix}-${name}`),`#${prefix}-${name} exists`);
    assert.match(html,new RegExp(`id="${prefix}-heading">Subtítulos de Stremio<`));
    assert.match(html,new RegExp(`for="${prefix}-language">Idioma<`));
    assert.match(html,new RegExp(`for="${prefix}-version">Versión<`));
    assert.match(html,new RegExp(`id="${prefix}-use"[^>]*>Usar este subtítulo<`));
    assert.match(html,new RegExp(`id="${prefix}-wrong"[^>]*>No es esta<`));
    assert.match(html,new RegExp(`id="${prefix}-retry"[^>]*>Reintentar<`));
    assert.match(html,new RegExp(`for="${prefix}-hint">Título con año y episodio, o ID de IMDb<`));
    assert.match(html,new RegExp(`id="${prefix}-search"[^>]*>Buscar<`));
  }
  assert.ok(html.indexOf('id="setup-addon"')>html.indexOf('id="setup-subtitle"'));
  assert.ok(html.indexOf('id="active-addon"')>html.indexOf('id="active-subtitle"'));
});
test('setup shows the match line, languages in server order and ranked versions from the offers call only',async()=>{
  const listing=listingOf(),h=await openSetup(listing),$=h.element;
  assert.equal($('setup-addon').hidden,false);
  assert.equal($('setup-addon-match').textContent,'Coincidencia: MobLand (2025) · T1 E7');
  assert.deepEqual(calls(h,'/api/subtitle_offers'),[{source_id:'b',catalogue_id:'cat-b'}]);
  assert.deepEqual($('setup-addon-language').children.map(o=>[o.value,o.textContent]),[['spl','Español (Latinoamérica) · 1'],['spa','Español · 2'],['eng','Inglés · 1']]);
  assert.equal($('setup-addon-language').value,'spl');
  assert.deepEqual($('setup-addon-version').children.map(o=>o.textContent),['MobLand S01E07 1080p WEB']);
  $('setup-addon-language').value='spa';$('setup-addon-language').onchange();
  assert.deepEqual($('setup-addon-version').children.map(o=>o.textContent),['MobLand S01E07 BluRay · mismo origen','MobLand S01E07 SDH · para sordos']);
  assert.equal($('setup-addon-version').value,'o-spa');
  assert.equal($('setup-addon-use').hidden,false);assert.equal($('setup-addon-use').disabled,false);
  assert.equal($('setup-addon-status').hidden,true);assert.equal($('setup-addon-correction').hidden,true);
  await h.poll(idleB(listing));assert.equal(calls(h,'/api/subtitle_offers').length,1,'an unchanged revision is never pulled again');
  assert.equal(h.requests.filter(playbackPost).length,0);
});
test('a doubtful match is announced as a question',async()=>{
  const listing=listingOf({match:matchOf('MobLand (2025) · T1 E7','doubtful')}),h=await openSetup(listing);
  assert.equal(h.element('setup-addon-match').textContent,'Coincidencia dudosa: ¿MobLand (2025) · T1 E7?');
});
test('Usar este subtítulo downloads once, adds a Stremio entry, selects it, and Start never touches the network for it',async()=>{
  const listing=listingOf(),entry=stremioEntry('addon-b'),h=await openSetup(listing),$=h.element;
  let finish;h.respond('/api/subtitle_fetch',()=>new Promise(resolve=>{finish=resolve;}));
  await chooseOffer(h);$('setup-addon-use').click();await h.settle();
  assert.deepEqual(calls(h,'/api/subtitle_fetch'),[{source_id:'b',catalogue_id:'cat-b',offer_id:'o-spa'}]);
  assert.equal($('setup-addon-use').textContent,'Descargando…');assert.equal($('setup-addon-use').disabled,true);
  assert.equal($('start').disabled,true);assert.equal($('subtitle-file').disabled,true);
  h.setStatus(idleB(listing,{extra:{b:[entry]}}));
  finish(ok({entry,catalogue:catalogue('b',summaryOf(listing),[entry])}));await h.settle();
  assert.equal($('setup-subtitle').value,'addon-b');
  assert.match($('setup-subtitle').children.find(n=>n.value==='addon-b').textContent,/MobLand S01E07 BluRay · spa · Stremio$/);
  assert.match($('setup-addon-status').textContent,/^Subtítulo listo: MobLand S01E07 BluRay\. Se usará solo al iniciar\.$/);
  assert.equal($('setup-addon-use').textContent,'Usar este subtítulo');assert.equal($('start').disabled,false);
  const before=h.requests.length;$('start').click();await h.settle();
  assert.deepEqual(JSON.parse(h.requests.find(r=>r.path==='/api/start').options.body),{...startBody('b'),subtitle_id:'addon-b'});
  assert.deepEqual(h.requests.slice(before).filter(r=>/subtitle_/.test(r.path)),[]);
  assert.equal(calls(h,'/api/subtitle_fetch').length,1);
});
test('every non-ready state has one status line, never disables Start and never borrows the catalogue error',async()=>{
  const cases=[
    ['loading',{state:'loading',message:'Buscando subtítulos de Stremio…',match:null,offers:[]},/^Buscando subtítulos de Stremio…$/],
    ['unidentified',{state:'unidentified',message:'No pude reconocer la película. Elegí una opción o escribí el título.',match:null,offers:[]},/^No pude reconocer la película\. Elegí una opción o escribí el título\.$/],
    ['empty',{offers:[]},/^Stremio no tiene subtítulos para MobLand \(2025\) · T1 E7\.$/],
    ['error',{state:'error',message:'No se pudieron buscar subtítulos de Stremio. Las pistas y los archivos locales siguen disponibles.',match:null,offers:[]},/^No se pudieron buscar subtítulos de Stremio\. Las pistas y los archivos locales siguen disponibles\.$/],
    ['busy',{state:'error',message:'Stremio está limitando las consultas. Esperá unos segundos y reintentá.',match:null,offers:[]},/^Stremio está limitando las consultas\. Esperá unos segundos y reintentá\.$/]];
  for(const [name,patch,copy] of cases) {
    const listing=listingOf(patch),h=await openSetup(listing),$=h.element;
    assert.equal($('setup-addon').hidden,false,name);
    assert.match($('setup-addon-status').textContent,copy,name);assert.equal($('setup-addon-status').hidden,false,name);
    assert.equal($('setup-addon-picker').hidden,true,name);assert.equal($('setup-addon-use').hidden,true,name);
    assert.equal($('setup-addon-retry').hidden,patch.state!=='error',name);
    assert.equal($('setup-addon-wrong').hidden,name!=='empty',name);
    assert.equal($('setup-addon-correction').hidden,name!=='unidentified',name);
    assert.equal($('start').disabled,false,name);assert.doesNotMatch($('catalogue-status').textContent,/Stremio/,name);
    assert.equal(h.requests.filter(playbackPost).length,0,name);
  }
});
test('Reintentar repeats the lookup for the same catalogue with an automatic hint',async()=>{
  const listing=listingOf({state:'error',message:'No se pudieron buscar subtítulos de Stremio. Las pistas y los archivos locales siguen disponibles.',match:null,offers:[]});
  const h=await openSetup(listing),$=h.element;
  assert.equal(calls(h,'/api/subtitle_offers').length,0);
  h.respond('/api/subtitle_lookup',async()=>ok(lookupFinished({...listing,state:'loading',revision:2,message:'Buscando subtítulos de Stremio…'})));
  $('setup-addon-retry').click();await h.settle();
  assert.deepEqual(calls(h,'/api/subtitle_lookup'),[{source_id:'b',catalogue_id:'cat-b',hint:null}]);
  assert.match($('setup-addon-status').textContent,/Buscando/);assert.equal($('setup-addon-retry').hidden,true);
});
test('a state of off hides the block and nothing is requested',async()=>{
  const h=harness({...playing,phase:'idle',source_id:null});await h.settle();h.select('b');await h.settle();
  assert.equal(h.element('setup-addon').hidden,true);
  assert.equal(h.requests.filter(r=>/subtitle_/.test(r.path)).length,0);
});
test('No es esta reveals at most four alternatives and a field that both feed the same lookup',async()=>{
  const listing=listingOf({alternatives:alternativeList}),h=await openSetup(listing),$=h.element;
  assert.equal($('setup-addon-correction').hidden,true);assert.equal($('setup-addon-wrong').attributes['aria-expanded'],'false');
  $('setup-addon-wrong').click();
  assert.equal($('setup-addon-correction').hidden,false);assert.equal($('setup-addon-wrong').attributes['aria-expanded'],'true');
  const buttons=$('setup-addon-alternatives').children;
  assert.deepEqual(buttons.map(b=>b.textContent),['Otra 1 (2001)','Otra 2 (2002)','Otra 3 (2003)','Otra 4 (2004)']);
  const next=listingOf({revision:2,match:matchOf('Otra 2 (2002)'),offers:[offerList[3]]});
  const loading={...next,state:'loading',match:null,offers:[],message:'Buscando subtítulos de Stremio…'};
  h.respond('/api/subtitle_lookup',async()=>{h.setStatus(idleB(loading));return ok(lookupFinished(loading));});
  buttons[1].onclick();await h.settle();
  assert.deepEqual(calls(h,'/api/subtitle_lookup'),[{source_id:'b',catalogue_id:'cat-b',hint:'tt0000002 Otra 2 2002'}]);
  assert.match($('setup-addon-status').textContent,/Buscando/);assert.equal($('setup-addon-correction').hidden,true);
  respondListing(h,next);await h.poll(idleB(next));await h.settle();
  assert.equal(calls(h,'/api/subtitle_offers').length,2);
  assert.equal($('setup-addon-match').textContent,'Coincidencia: Otra 2 (2002)');
  assert.deepEqual($('setup-addon-language').children.map(o=>o.value),['eng']);
  $('setup-addon-wrong').click();
  $('setup-addon-hint').value='  tt1234567 S01E07  ';$('setup-addon-form').onsubmit({preventDefault(){}});await h.settle();
  assert.equal(calls(h,'/api/subtitle_lookup')[1].hint,'tt1234567 S01E07');
  $('setup-addon-hint').value='   ';$('setup-addon-form').onsubmit({preventDefault(){}});await h.settle();
  $('setup-addon-hint').value='x'.repeat(201);$('setup-addon-form').onsubmit({preventDefault(){}});await h.settle();
  assert.equal(calls(h,'/api/subtitle_lookup').length,2);
  assert.match($('setup-addon-status').textContent,/200 caracteres/);
});
test('an unidentified film opens the correction on its own and has no No es esta toggle',async()=>{
  const listing=listingOf({state:'unidentified',message:'No pude reconocer la película. Elegí una opción o escribí el título.',match:null,offers:[],alternatives:alternativeList.slice(0,3)});
  const h=await openSetup(listing),$=h.element;
  assert.equal($('setup-addon-correction').hidden,false);assert.equal($('setup-addon-wrong').hidden,true);
  assert.deepEqual(calls(h,'/api/subtitle_offers'),[{source_id:'b',catalogue_id:'cat-b'}]);
  assert.deepEqual($('setup-addon-alternatives').children.map(b=>b.textContent),['Otra 1 (2001)','Otra 2 (2002)','Otra 3 (2003)']);
  assert.equal($('setup-addon-match').hidden,true);
});
test('an unreadable subtitle says so, stays listed and leaves Start and the catalogue status alone',async()=>{
  const listing=listingOf(),h=await openSetup(listing),$=h.element;
  const copy='Ese subtítulo no se pudo leer. Probá otra versión.';
  h.respond('/api/subtitle_fetch',async()=>failed(copy,'invalid_subtitle'));
  await chooseOffer(h);$('setup-addon-use').click();await h.settle();
  assert.equal($('setup-addon-status').textContent,copy);
  assert.deepEqual($('setup-addon-version').children.map(o=>o.textContent),['MobLand S01E07 BluRay · mismo origen · no se pudo leer','MobLand S01E07 SDH · para sordos']);
  assert.equal($('setup-addon-use').disabled,false);assert.equal($('start').disabled,false);
  assert.doesNotMatch($('catalogue-status').textContent,/leer/);assert.equal($('setup-subtitle').value,'');
  h.respond('/api/subtitle_fetch',async()=>failed('No se pudo conectar. Revisá tu conexión y que Stremio esté abierto.','addon_unavailable'));
  $('setup-addon-version').value='o-sdh';$('setup-addon-version').onchange();$('setup-addon-use').click();await h.settle();
  assert.match($('setup-addon-status').textContent,/No se pudo conectar/);
  assert.deepEqual($('setup-addon-version').children.map(o=>o.textContent),['MobLand S01E07 BluRay · mismo origen · no se pudo leer','MobLand S01E07 SDH · para sordos']);
  h.respond('/api/subtitle_fetch',async()=>{throw Object.assign(new Error('timeout'),{name:'AbortError'});});
  $('setup-addon-use').click();await h.settle();
  assert.equal($('setup-addon-status').textContent,'La consulta tardó demasiado. Reintentá.');assert.equal($('start').disabled,false);
});
test('late downloads cannot select a subtitle for another movie, an abandoned setup or a refreshed catalogue',async()=>{
  for(const mode of ['other-movie','cancel','refresh','pick']) {
    const listing=listingOf(),entry=stremioEntry('addon-b'),h=harness({...playing,phase:'idle',source_id:null,addons:{a:summaryOf(listing),b:summaryOf(listing)}});
    respondListing(h,listing);await h.settle();const $=h.element;
    h.select('b');await h.settle();await h.settle();
    let finish;h.respond('/api/subtitle_fetch',()=>new Promise(resolve=>{finish=resolve;}));
    await chooseOffer(h);$('setup-addon-use').click();await h.settle();
    if(mode==='other-movie'){h.select('a');await h.settle();}
    if(mode==='cancel'){$('setup-cancel').click();}
    if(mode==='refresh'){h.respond('/api/catalogue',()=>new Promise(()=>{}));$('refresh-catalogue').click();await h.settle();}
    if(mode==='pick'){$('setup-subtitle').value='text-b';$('setup-subtitle').onchange();}
    finish(ok({entry,catalogue:catalogue('b',summaryOf(listing),[entry])}));await h.settle();
    assert.notEqual($('setup-subtitle').value,'addon-b',mode);
    assert.equal(h.requests.filter(playbackPost).length,0,mode);
  }
});
test('an older addon revision of the same catalogue never replaces a newer one',async()=>{
  const first=listingOf(),third=listingOf({revision:3,match:matchOf('Newer (2024)')}),h=await openSetup(first),$=h.element;
  let finish;h.respond('/api/subtitle_lookup',()=>new Promise(resolve=>{finish=resolve;}));
  $('setup-addon-wrong').click();$('setup-addon-alternatives').children[0].onclick();await h.settle();
  respondListing(h,third);await h.poll(idleB(third));await h.settle();
  assert.equal($('setup-addon-match').textContent,'Coincidencia: Newer (2024)');
  finish(ok(lookupFinished({...first,state:'loading',revision:2,match:null,offers:[],message:'Buscando subtítulos de Stremio…'})));await h.settle();
  assert.equal($('setup-addon-match').textContent,'Coincidencia: Newer (2024)');
  assert.doesNotMatch($('setup-addon-status').textContent,/Buscando/);
});
test('entries are labelled by origin and addon entries never replace the local upload label',async()=>{
  const listing=listingOf(),addon=stremioEntry('addon-b'),local={id:'upload-b',kind:'upload',label:'local.srt',language:null,supported:true,reason:null};
  const h=await openSetup(listing,{extra:{b:[addon,local]}}),$=h.element;
  const label=id=>$('setup-subtitle').children.find(n=>n.value===id).textContent;
  assert.match(label('addon-b'),/ · Stremio$/);assert.match(label('upload-b'),/ · Archivo local$/);
  assert.doesNotMatch(label('text-b'),/Stremio|Archivo local/);
});
test('the live editor renders the same block and a downloaded subtitle becomes a draft that Aplicar sends',async()=>{
  const listing=listingOf(),entry=stremioEntry('addon-a'),h=harness({...playing,addons:{a:summaryOf(listing)}});
  respondListing(h,listing);await h.settle();const $=h.element;
  assert.equal(calls(h,'/api/subtitle_offers').length,0,'a closed editor requests nothing');
  $('open-subtitles').click();await h.settle();await h.settle();
  assert.equal($('active-addon').hidden,false);assert.equal($('active-addon-match').textContent,'Coincidencia: MobLand (2025) · T1 E7');
  assert.deepEqual(calls(h,'/api/subtitle_offers'),[{source_id:'a',catalogue_id:'cat-a'}]);
  assert.equal($('active-addon-language').children.length,3);
  const subtitled={...playing,addons:{a:summaryOf(listing)},extra:{a:[entry]}};
  h.respond('/api/subtitle_fetch',async()=>{h.setStatus(subtitled);return ok({entry,catalogue:catalogue('a',summaryOf(listing),[entry])});});
  await chooseOffer(h,'o-spa','active-addon');$('active-addon-use').click();await h.settle();
  assert.deepEqual(calls(h,'/api/subtitle_fetch'),[{source_id:'a',catalogue_id:'cat-a',offer_id:'o-spa'}]);
  assert.equal($('active-subtitle').value,'addon-a');assert.equal($('subtitles').checked,true);assert.equal($('apply').disabled,false);
  assert.match($('active-addon-status').textContent,/Se usará solo al aplicar\./);
  assert.equal(h.requests.filter(playbackPost).length,0);
  h.respond('/api/subtitles',async()=>{h.setStatus({...subtitled,subtitle_choice:{catalogue_id:'cat-a',subtitle_id:'addon-a',enabled:true,delay_ms:0,label:entry.label,language:'spa'}});return ok({accepted:true});});
  $('apply').click();await h.settle();
  assert.deepEqual(h.requests.filter(playbackPost).map(r=>[r.path,JSON.parse(r.options.body)]),[['/api/subtitles',{...captionBody(true),subtitle_id:'addon-a'}]]);
});
test('a download finishing after the playback instance changed cannot become the caption draft',async()=>{
  const listing=listingOf(),entry=stremioEntry('addon-a'),h=harness({...playing,addons:{a:summaryOf(listing)}});
  respondListing(h,listing);await h.settle();const $=h.element;
  $('open-subtitles').click();await h.settle();await h.settle();
  let finish;h.respond('/api/subtitle_fetch',()=>new Promise(resolve=>{finish=resolve;}));
  await chooseOffer(h,'o-spa','active-addon');$('active-addon-use').click();await h.settle();
  await h.poll({...playing,playback_id:'play-new',addons:{a:summaryOf(listing)}});
  finish(ok({entry,catalogue:catalogue('a',summaryOf(listing),[entry])}));await h.settle();
  assert.notEqual($('active-subtitle').value,'addon-a');assert.equal($('apply').disabled,true);
});
test('the live block stays inert while a caption Apply is pending',async()=>{
  const listing=listingOf(),h=harness({...playing,addons:{a:summaryOf(listing)}});
  respondListing(h,listing);await h.settle();const $=h.element;
  $('open-subtitles').click();await h.settle();await h.settle();h.delay(.2);
  h.respond('/api/subtitles',()=>new Promise(()=>{}));
  $('apply').click();await h.settle();
  assert.equal($('active-addon-use').disabled,true);assert.equal($('active-addon-language').disabled,true);
});
test('a late lookup receipt with an older addon revision cannot roll the live editor back',async()=>{
  const first=listingOf(),third=listingOf({revision:3,match:matchOf('Newer (2024)')}),h=harness({...playing,addons:{a:summaryOf(first)}});
  respondListing(h,first);await h.settle();const $=h.element;
  $('open-subtitles').click();await h.settle();await h.settle();
  let finish;h.respond('/api/subtitle_lookup',()=>new Promise(resolve=>{finish=resolve;}));
  $('active-addon-wrong').click();$('active-addon-alternatives').children[0].onclick();await h.settle();
  respondListing(h,third);await h.poll({...playing,addons:{a:summaryOf(third)}});await h.settle();
  assert.equal($('active-addon-match').textContent,'Coincidencia: Newer (2024)');
  finish(ok({catalogue:catalogue('a',summaryOf({...first,state:'loading',revision:2,match:null,offers:[],message:'Buscando subtítulos de Stremio…'}))}));await h.settle();
  assert.equal($('active-addon-match').textContent,'Coincidencia: Newer (2024)');
  assert.doesNotMatch($('active-addon-status').textContent,/Buscando/);
});
