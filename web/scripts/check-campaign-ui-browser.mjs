// Actual page HTML from the disposable integration check, plus interactive
// existing React editors with mocked server actions. No database/session access.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";

const stage = path.resolve(".campaign-ui-validation");
const profile = path.resolve(stage, `browser-profile-${randomUUID()}`);
const names = ["dashboard", "dashboard-list", "overview", "drafts", "compare", "settings", "empty"];
const fixtures = new Map();
for (const name of names) fixtures.set(`/${name}.html`, await readFile(path.join(stage, `${name}.html`)));
const css = (await readdir(".next/static/chunks")).filter(file => file.endsWith(".css"));
assert(css.length, "Build the application before checking browser layouts.");
fixtures.set("/style.css", Buffer.from((await Promise.all(css.map(file => readFile(`.next/static/chunks/${file}`, "utf8")))).join("\n")));
const browserBundle = await build({ absWorkingDir: process.cwd(), bundle: true, write: false, platform: "browser", jsx: "automatic", logLevel: "silent",
  stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {CampaignShell} from './src/components/CampaignUI';
    import AiDraftEditor from './src/components/AiDraftEditor';
    import AiSettingsEditor from './src/components/AiSettingsEditor';
    import {PublishingSettingsEditor} from './src/components/DirectPublishingControls';
    import RefreshButton from './src/components/RefreshButton';
    import {CampaignSourceForm} from './src/components/CampaignForms';
    import CampaignToolbar from './src/components/CampaignToolbar';
    window.__actions=[]; window.__refreshes=0; window.__navigations=[];
    function App(){
      const [draft,setDraft]=useState({id:'browser-draft',finalText:'نص عربي محفوظ للمراجعة.',editRevision:1,reviewStatus:'PENDING_REVIEW'});
      window.__updateDraft = setDraft;
      return <CampaignShell campaign={{id:'browser-campaign',name:'أخبار المدينة — الحملة التجريبية',isDefault:false}} user={{id:'fixture',email:'browser@example.invalid',emailVerified:true,approvalStatus:'APPROVED',platformRole:'OWNER',workspace:{id:'fixture',name:'Fixture',automationEnabled:true,rssEnabled:true}}} active="ai-drafts">
        <CampaignToolbar path="/workspace/campaigns/browser-campaign/drafts" search="" sort="newest" view="cards" label="Search drafts" displays={[{value:"cards",label:"Cards display",icon:"grid"},{value:"compare",label:"Compare display",icon:"compare"}]} /><RefreshButton>Refresh status</RefreshButton><section className="card p-6"><AiDraftEditor draft={draft} campaignId="browser-campaign" /></section>
        <section className="card p-6"><AiSettingsEditor settings={{enabled:false,systemPrompt:'اكتب أخباراً واضحة باللغة العربية.',editorialPerspective:'',model:'gpt-oss:latest',revision:1}} models={['gpt-oss:latest']} connected campaignId="browser-campaign" /></section>
        <CampaignSourceForm campaignId="browser-campaign" sourceId="browser-source" membership={{revision:3,telegramAutomationEnabled:true}} excluded={false} />
        <PublishingSettingsEditor settings={{enabled:false,destinationUsername:'browser_output',revision:1}} campaignId="browser-campaign" />
      </CampaignShell>;
    }
    createRoot(document.getElementById('root')).render(<App/>); window.__ready=true;
  ` }, plugins: [{ name: "mock-browser-boundaries", setup(builder) {
    builder.onResolve({ filter: /^(@\/app\/actions\/|next\/(link|navigation)$|@\/lib\/auth-client$)/ }, args => ({ path: args.path, namespace: "mock" }));
    builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ resolveDir: process.cwd(), contents:
      args.path === "next/link" ? "import {createElement} from 'react'; export default function Link({children,...props}){return createElement('a',props,children)}" :
      args.path === "next/navigation" ? "export function useRouter(){return {refresh(){window.__refreshes++},replace(url){window.__navigations.push(url)}}}" :
      args.path === "@/lib/auth-client" ? "export const authClient={signOut:async()=>({})};" : `
        async function action(previous,form){
          const fields=Object.fromEntries(form.entries()); window.__actions.push(fields);
          await new Promise(resolve=>setTimeout(resolve,15));
          if((fields.draftId ?? fields.id)==='browser-draft' && fields.intent){
            const revision=Number(fields.revision)+1;
            const reviewStatus=fields.intent==='approve'?'APPROVED':fields.intent==='reject'?'REJECTED':'PENDING_REVIEW';
            window.__updateDraft(old=>({...old,finalText:fields.intent==='save'?fields.finalText.trim():old.finalText,reviewStatus,editRevision:revision}));
            return {success:true,message:fields.intent==='save'?'Final text saved; pending review.':fields.intent==='approve'?'Approved. Nothing was sent.':'Draft rejected.',revision};
          }
          return {success:true,message:fields.destination?'Destination settings saved. No test message was sent.':fields.systemPrompt?'AI settings saved.':'Queued the saved approved text.',revision:Number(fields.revision)+(fields.systemPrompt || fields.verify==='yes'?1:0)};
        }
        export const saveAiDraft=action,saveCampaignAiDraft=action,saveAiSettings=action,saveCampaignAiSettings=action,
          savePublishingSettings=action,saveCampaignPublishingSettings=action,publishAiDraft=action,publishCampaignAiDraft=action,
          recoverTelegramPublication=action,recoverCampaignTelegramPublication=action,createCampaignAction=action,renameCampaign=action,changeCampaignSource=action,deleteEmptyCampaign=action;
      ` }));
  } }] });
fixtures.set("/interactive.js", browserBundle.outputFiles[0].contents);
fixtures.set("/interactive.html", Buffer.from('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/interactive.js"></script></body></html>'));
let unexpectedRequests = 0;
const server = createServer((request, response) => {
  if (request.method !== "GET") { unexpectedRequests++; response.writeHead(405).end(); return; }
  const key = new URL(request.url, "http://localhost").pathname;
  const body = fixtures.get(key);
  if (!body) { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", key.endsWith(".css") ? "text/css" : key.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8"); response.end(body);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const executable = process.env.CAMPAIGN_UI_CHROME || path.join(process.env.LOCALAPPDATA || "", "ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe");
const chrome = spawn(executable, ["--headless", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--disable-component-update", "--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Headless browser startup timed out.")), 20000);
    chrome.once("error", () => { clearTimeout(timer); reject(new Error("Set CAMPAIGN_UI_CHROME to an installed Chromium executable.")); });
    let output = "";
    chrome.stderr.on("data", chunk => { output = (output + chunk.toString()).slice(-4000); const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const debugOrigin = new URL(endpoint); debugOrigin.protocol = "http:";
  const target = await (await fetch(`${debugOrigin.origin}/json/new?about:blank`, { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 1; const pending = new Map(); let dialogs = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = sequence++; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener("message", async event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const item = pending.get(message.id); pending.delete(message.id);
      if (item) { if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result); }
    }
    if (message.method === "Fetch.requestPaused") {
      await call(message.params.request.url.startsWith(origin) ? "Fetch.continueRequest" : "Fetch.failRequest", { requestId: message.params.requestId, ...(message.params.request.url.startsWith(origin) ? {} : { errorReason: "BlockedByClient" }) });
    }
    if (message.method === "Page.javascriptDialogOpening") { dialogs++; await call("Page.handleJavaScriptDialog", { accept: false }); }
  });
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error("Browser fixture evaluation failed."); return result.result.value;
  };
  const waitFor = async expression => { for (let i = 0; i < 50; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Browser fixture condition did not become true: ${expression}`); };
  await call("Page.enable"); await call("Runtime.enable"); await call("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await mkdir(stage, { recursive: true });
  for (const width of [1440, 390]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1, mobile: width === 390 });
    for (const name of names) {
      await call("Page.navigate", { url: `${origin}/${name}.html` }); await waitFor("document.readyState === 'complete' && !!document.querySelector('.workspace-ui')");
      assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), `${name} overflows at ${width}px`);
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.workspace-ui')).backgroundColor"), "rgb(255, 255, 255)");
      if (!name.startsWith("dashboard")) assert.equal(await evaluate("document.querySelectorAll('.campaign-tabs a[aria-current=page]').length"), 1);
      if (name === "drafts") assert.equal(await evaluate("getComputedStyle(document.querySelector('textarea')).direction"), "rtl");
      assert(await evaluate(`(()=>{
        const lum=c=>{const rgb=c.match(/\\d+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2]};
        return [...document.querySelectorAll('h1,h2,h3,.muted')].filter(e=>e.getClientRects().length).every(e=>(1.05/(lum(getComputedStyle(e).color)+.05))>=4.5);
      })()`), `${name} has low-contrast heading or secondary text`);
      assert(await evaluate("[...document.querySelectorAll('button,a,summary')].filter(e=>e.getClientRects().length && !e.textContent.trim()).every(e=>e.getAttribute('aria-label') && e.title)"), `${name} has an unnamed icon control`);
      const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile(path.join(stage, `${name}-${width}.png`), Buffer.from(shot.data, "base64"));
    }
  }
  console.log("PASS: seven actual campaign pages at desktop/mobile widths, no horizontal overflow, light styling, active tabs and Arabic direction.");
  await call("Page.navigate", { url: `${origin}/interactive.html` }); await waitFor("window.__ready && !!document.querySelector('textarea')");
  assert(await evaluate("!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Apply') && !document.querySelector('select[name=sort]') && !document.querySelector('select[name=view]')"));
  await evaluate("document.querySelector('.sort-control').click()");
  await waitFor("window.__navigations.length===1");
  assert((await evaluate("window.__navigations.at(-1)")).includes("sort=oldest"));
  await evaluate("document.querySelector('button[aria-label=\"Compare display\"]').click()");
  await waitFor("window.__navigations.length===2");
  assert((await evaluate("window.__navigations.at(-1)")).includes("view=compare"));
  await evaluate(`(()=>{const field=document.querySelector('.toolbar-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'خبر عربي');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor("window.__navigations.length===3");
  assert.equal(new URL((await evaluate("window.__navigations.at(-1)")),origin).searchParams.get('q'),'خبر عربي');
  await evaluate("document.querySelector('.draft-actions').scrollIntoView({block:'center'})");
  const actionShot = await call("Page.captureScreenshot", {format:"png",captureBeyondViewport:false});
  await writeFile(path.join(stage,"draft-actions-390.png"),Buffer.from(actionShot.data,"base64"));
  await evaluate("window.scrollTo(0,0)");
  await evaluate(`(()=>{const field=document.querySelector('textarea'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(field,'نص جديد غير محفوظ.'); field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor("document.querySelector('button[value=approve]').disabled");
  assert(await evaluate("!!document.querySelector('[data-unsaved=true]')"));
  await evaluate("document.querySelector('.campaign-tabs a').click()"); assert.equal(dialogs, 1);
  assert((await evaluate("location.pathname")).includes("interactive"));
  await evaluate("document.querySelector('.sort-control').click()"); assert.equal(dialogs,2);
  assert.equal(await evaluate("window.__navigations.length"),3,"Dirty draft must block sort navigation");
  await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Refresh status').click()");
  assert.equal(dialogs, 3); assert.equal(await evaluate("window.__refreshes"), 0);
  await evaluate("document.querySelector('button[value=save]').click()");
  await waitFor("!document.querySelector('button[value=approve]').disabled && document.body.textContent.includes('Final text saved')");
  assert.equal(await evaluate("document.querySelector('input[name=revision]').value"), "2");
  await evaluate("document.querySelector('button[value=approve]').click()"); await waitFor("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Publish' && !b.disabled)");
  await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Publish').click()");
  await waitFor("document.body.textContent.includes('Queued the saved approved text')");
  const calls = await evaluate("window.__actions"); assert.equal(calls.length, 3); assert(calls.every(c => c.campaignId === "browser-campaign")); assert.equal(calls[2].revision, "3");
  await evaluate(`(()=>{const field=document.getElementById('ai-system'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'تعليمات جديدة غير محفوظة.'); field.dispatchEvent(new Event('input',{bubbles:true})); const destination=document.getElementById('destination'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(destination,'browser_output_changed'); destination.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor("document.querySelectorAll('[data-unsaved=true]').length===2");
  await evaluate("document.querySelector('.campaign-tabs a').click()"); assert.equal(dialogs, 4, "Several dirty forms should cause only one navigation prompt");
  await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Save AI settings').click()");
  await waitFor("document.body.textContent.includes('AI settings saved.') && document.querySelectorAll('[data-unsaved=true]').length===1");
  assert.equal(await evaluate("document.getElementById('ai-system').form.querySelector('input[name=revision]').value"), "2");
  await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Change destination').click()");
  assert(await evaluate("!!document.querySelector('dialog[open]')"));
  await evaluate("document.querySelector('button[name=verify]').click()");
  await waitFor("document.body.textContent.includes('No test message was sent.') && !document.querySelector('[data-unsaved=true]')");
  assert.equal(await evaluate("document.getElementById('destination').form.querySelector('input[name=revision]').value"), "2");
  await evaluate("document.querySelector('button[name=verify]').click()");
  await waitFor("document.getElementById('destination').form.querySelector('input[name=revision]').value==='3'");
  assert.equal(await evaluate("window.__actions.at(-1).verify"), "yes");
  await evaluate("document.querySelector('dialog[open] button').focus()");
  await call("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await call("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await waitFor("!document.querySelector('dialog[open]')");
  assert(await evaluate("document.activeElement.textContent==='Change destination'"), "Dialog must restore keyboard focus");
  await evaluate(`(()=>{const f=document.createElement('form');f.method='get';f.innerHTML='<button>Apply search</button>';document.querySelector('.app-content').appendChild(f);const field=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'unsaved search guard');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor("!!document.querySelector('[data-unsaved=true]')");
  const beforeSearch=dialogs;
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Apply search').click()");
  assert.equal(dialogs,beforeSearch+1); assert((await evaluate("location.pathname")).includes("interactive"));
  assert(await evaluate("!document.querySelector('button[name=intent][value=pause]').getClientRects().length"), "Checkbox should be the sole participation control");
  await evaluate("document.querySelector('input[aria-label=\"Participate in this campaign\"]').click()");
  await waitFor("window.__actions.at(-1).sourceId==='browser-source'");
  assert.equal(await evaluate("window.__actions.at(-1).intent"),"pause");
  assert.equal(await evaluate("window.__actions.at(-1).revision"),"3");
  assert.equal(unexpectedRequests, 0);
  console.log("PASS: actual interactive editors guard unsaved edits/navigation/refresh, save before approval, carry revisions/campaign identity, and give form feedback using mocked actions.");
} finally {
  socket?.close(); chrome.kill(); server.close();
  await new Promise(resolve => { if (chrome.exitCode !== null) resolve(); else { chrome.once("exit", resolve); setTimeout(resolve, 3000); } });
  if (!profile.startsWith(stage + path.sep)) throw new Error("Unsafe browser cleanup path.");
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
