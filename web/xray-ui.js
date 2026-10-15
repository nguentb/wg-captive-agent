"use strict";

function xrayPanel() {
  return `<section id="xrayTab" class="settings hidden">
<style>.xray-form{display:grid;gap:12px;margin:18px 0}.xray-form textarea{min-height:150px;resize:vertical;width:100%;box-sizing:border-box;font:13px monospace;line-height:1.5}.xray-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.xray-status{white-space:pre-wrap;overflow-wrap:anywhere;font:13px monospace;line-height:1.6;max-height:360px;overflow:auto;margin:12px 0}.xray-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:18px 0}.xray-fields span{display:block;color:var(--muted);font-size:13px;margin-bottom:6px}.xray-fields strong{overflow-wrap:anywhere;font-size:15px}#xrayInputFile{max-width:100%;min-width:0}#xrayResult{overflow-wrap:anywhere;color:var(--muted);margin:14px 0}@media(max-width:600px){.xray-fields{grid-template-columns:1fr}}</style>
<div class="section-head"><div><h1>Xray</h1><p id="xraySummary">Stopped</p></div><button type="button" class="ghost" id="xraySelect">Use Xray</button></div>
<div class="xray-fields"><div><span>Protocol / Transport</span><strong id="xrayTransport">-</strong></div><div><span>Endpoint</span><strong id="xrayEndpoint">-</strong></div><div><span>Core</span><strong id="xrayVersion">-</strong></div></div>
<form id="xrayImportForm" class="xray-form" style="grid-template-columns:minmax(0,1fr)"><label style="min-width:0">VLESS / Trojan / JSON<textarea id="xrayInput" spellcheck="false" autocomplete="off" placeholder="vless://..."></textarea></label><div class="xray-actions" style="min-width:0"><input type="file" id="xrayInputFile" style="box-sizing:border-box;width:100%" accept=".json,.txt,application/json,text/plain" aria-label="Xray config file"><button type="submit" class="ghost" id="xrayImport">Import</button><button type="button" class="ghost danger" id="xrayDelete">Delete config</button></div></form>
<div class="relay-ops"><div class="relay-op-row"><div><strong>Xray service</strong><span id="xrayServiceState">Stopped</span></div><div class="relay-op-actions"><button type="button" class="ghost" id="xrayRestart">Restart</button><label class="switch relay-switch" title="Toggle Xray service"><input type="checkbox" id="XRAY_SERVICE"><span class="slider"></span></label></div></div><div class="relay-op-row"><strong>Route</strong><label class="switch relay-switch" title="Toggle Xray route"><input type="checkbox" id="XRAY_ROUTE"><span class="slider"></span></label></div></div>
<div class="xray-actions" style="margin-top:18px"><button type="button" class="ghost" id="xrayCheck">Check connection</button><button type="button" class="ghost" id="xrayRefresh">Refresh</button><button type="button" class="ghost" id="xrayLogs">Logs</button></div><p id="xrayResult" role="status"></p><pre id="xrayStatus" class="xray-status"></pre></section>`;
}

function xrayClientJs() {
  return `
let xrayBusy=false;let xrayPollTimer=0;
function renderXray(){
  const r=state.relay||{};const p=r.profiles?.xray||{};const selected=r.protocol==='xray';const running=!!(r.tunnel_running||r.tunnel_up);
  let outbound={};try{outbound=JSON.parse(p.exit_config||'{}')}catch{}
  const server=outbound.settings?.vnext?.[0]||outbound.settings?.servers?.[0]||outbound.settings||{};
  $('xrayTransport').textContent=outbound.protocol?(outbound.protocol.toUpperCase()+' / '+(outbound.streamSettings?.network||'tcp')+' / '+(outbound.streamSettings?.security||'none')):'-';
  $('xrayEndpoint').textContent=server.address?(server.address+':'+server.port):'-';
  $('xraySummary').textContent=xrayBusy?'Updating...':selected?(r.route_enabled?'Routing enabled':r.tunnel_up?'TUN ready':'Selected'):'Standby';
  $('xrayServiceState').textContent=selected?(r.tunnel_up?'TUN ready':running?'Starting / retrying':'Stopped'):'Stopped';
  $('XRAY_SERVICE').checked=selected&&running;$('XRAY_ROUTE').checked=selected&&!!r.route_enabled;
  $('xraySelect').disabled=xrayBusy||relayBusy||selected||running||r.route_enabled||!p.imported;
  $('xraySelect').textContent=selected?'Selected':'Use Xray';
  for(const id of ['XRAY_SERVICE','XRAY_ROUTE','xrayRestart','xrayDelete'])$(id).disabled=xrayBusy||relayBusy||!selected||!p.imported;
  $('xrayDelete').disabled||=running||r.route_enabled;
  $('xrayImport').disabled=xrayBusy||relayBusy||(selected&&(running||r.route_enabled));
  $('xrayCheck').disabled=xrayBusy||!selected||!r.tunnel_up;
  $('xrayLogs').disabled=xrayBusy;
}
async function refreshXray(){
  clearTimeout(xrayPollTimer);
  const d=await api(API_BASE+'/xray');state.relay=d.relay;
  $('xrayVersion').textContent=d.version||'Not installed';
  $('xrayStatus').textContent=d.relay.protocol==='xray'?d.relay.status:'Active transport: '+d.relay.protocol;
  xrayBusy=d.operation?.state==='running';if(d.operation&&!xrayBusy)$('xrayResult').textContent=d.operation.error||d.operation.result||'Complete';
  renderRelay();
  if(xrayBusy)xrayPollTimer=setTimeout(()=>refreshXray().catch((error)=>{xrayBusy=false;renderRelay();toast(error.message)}),1000);
}
async function xrayAction(action){
  if(xrayBusy||relayBusy)return;xrayBusy=true;$('xrayResult').textContent='';renderRelay();
  try{await api(API_BASE+'/xray/action',{method:'POST',body:JSON.stringify({action})});await refreshXray()}
  catch(error){xrayBusy=false;renderRelay();toast(error.message)}
}
$('xrayImportForm').addEventListener('submit',async(event)=>{event.preventDefault();if(xrayBusy||relayBusy)return;const file=$('xrayInputFile').files[0];if(file&&$('xrayInput').value.trim()){toast('Choose either a link or a file');return}if(file&&file.size>1024*1024){toast('Config exceeds 1 MB');return}xrayBusy=true;renderRelay();try{const content=file?await file.text():$('xrayInput').value;const d=await api(API_BASE+'/xray/import',{method:'POST',body:JSON.stringify({content})});state.relay=d.relay;$('xrayInput').value='';$('xrayInputFile').value='';toast('Xray config imported')}catch(error){toast(error.message)}finally{xrayBusy=false;renderRelay()}});
$('xraySelect').addEventListener('click',()=>xrayAction('relay-select'));
$('xrayRestart').addEventListener('click',()=>xrayAction('relay-restart'));
$('xrayDelete').addEventListener('click',()=>{if(confirm('Delete Xray config?'))xrayAction('relay-delete-config')});
$('XRAY_SERVICE').addEventListener('change',()=>xrayAction($('XRAY_SERVICE').checked?'relay-tunnel-up':'relay-tunnel-down'));
$('XRAY_ROUTE').addEventListener('change',()=>xrayAction($('XRAY_ROUTE').checked?'relay-on':'relay-off'));
$('xrayCheck').addEventListener('click',()=>xrayAction('check'));
$('xrayRefresh').addEventListener('click',()=>refreshXray().catch((error)=>toast(error.message)));
$('xrayLogs').addEventListener('click',async()=>{try{const d=await api(API_BASE+'/xray/logs');$('xrayStatus').textContent=d.logs||'No logs'}catch(error){toast(error.message)}});
`;
}

module.exports = { xrayPanel, xrayClientJs };
