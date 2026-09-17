/**
 * Cloudflare Worker – Kurzbefehle Store
 *
 * ENV/Secrets:
 * GITHUB_TOKEN = GitHub fine-grained PAT with Contents: Read and write
 * GITHUB_OWNER = your GitHub username/org
 * GITHUB_REPO  = repository name
 * ADMIN_PASSWORD = a strong random admin password
 * ALLOWED_ORIGIN = https://YOUR-USER.github.io (optional; default *)
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null,{headers:CORS});
    const url = new URL(request.url);
    try {
      if (url.pathname === "/submit" && request.method === "POST") return submit(request,env);
      if (url.pathname === "/submissions" && request.method === "GET") { auth(request,env); return list(env); }
      if (url.pathname.startsWith("/download/") && request.method === "GET") { auth(request,env); return download(url.pathname.split("/").pop(),env); }
      if (url.pathname.startsWith("/approve/") && request.method === "POST") { auth(request,env); return approve(url.pathname.split("/").pop(),env); }
      if (url.pathname.startsWith("/reject/") && request.method === "POST") { auth(request,env); return reject(url.pathname.split("/").pop(),env); }
      return json({error:"Not found"},404);
    } catch(e) { return json({error:e.message||"Serverfehler"},400); }
  }
};

function headers(){return {...CORS,"Content-Type":"application/json","Cache-Control":"no-store"}}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:headers()})}
function auth(request,env){
  const got=request.headers.get("Authorization")||"";
  if(got !== `Bearer ${env.ADMIN_PASSWORD}`) throw new Error("Nicht autorisiert.");
}
function gh(env,path,init={}){
  return fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${path}`,{
    ...init,
    headers:{
      "Accept":"application/vnd.github+json",
      "Authorization":`Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version":"2022-11-28",
      "User-Agent":"kurzbefehle-store-worker",
      ...(init.headers||{})
    }
  });
}
async function submit(request,env){
  const form=await request.formData();
  const file=form.get("file"), name=clean(form.get("name")), description=clean(form.get("description")), creator=clean(form.get("creator"));
  if(!(file instanceof File)) throw new Error("Keine Datei.");
  if(!file.name.toLowerCase().endsWith(".shortcut")) throw new Error("Nur .shortcut-Dateien sind erlaubt.");
  if(file.size>10*1024*1024) throw new Error("Datei zu groß.");
  if(!name||!description||!creator) throw new Error("Name, Beschreibung und Ersteller sind erforderlich.");
  const id=`${Date.now()}-${slug(name)}-${crypto.randomUUID().slice(0,8)}`;
  const buf=await file.arrayBuffer(), b64=arrayBufferToBase64(buf);
  const safeFile=`${slug(name)}.shortcut`;
  const info={id,name,description,creator,originalFile:safeFile,submittedAt:new Date().toISOString(),status:"pending"};
  await put(env,`/contents/submissions/${id}/${safeFile}`,b64,`submission: ${name}`);
  await put(env,`/contents/submissions/${id}/info.json`,toBase64(JSON.stringify(info,null,2)),`submission metadata: ${name}`);
  return json({ok:true,id});
}
async function list(env){
  const r=await gh(env,"/contents/submissions");
  if(r.status===404)return json({submissions:[]});
  if(!r.ok)throw new Error("GitHub konnte die Einsendungen nicht lesen.");
  const dirs=await r.json(), out=[];
  for(const d of dirs.filter(x=>x.type==="dir")){
    const ir=await gh(env,`/contents/submissions/${encodeURIComponent(d.name)}/info.json`);
    if(!ir.ok)continue; const raw=await ir.json(); const info=JSON.parse(fromBase64(raw.content)); out.push(info);
  }
  out.sort((a,b)=>b.submittedAt.localeCompare(a.submittedAt));
  return json({submissions:out});
}
async function download(id,env){
  const r=await gh(env,`/contents/submissions/${encodeURIComponent(id)}`);
  if(!r.ok)throw new Error("Einsendung nicht gefunden.");
  const arr=await r.json(), f=arr.find(x=>x.name.endsWith(".shortcut"));
  if(!f)throw new Error("Datei nicht gefunden.");
  const fr=await gh(env,`/contents/${f.path}`); const d=await fr.json();
  const bytes=base64ToUint8(d.content.replace(/\n/g,""));
  return new Response(bytes,{headers:{...CORS,"Content-Type":"application/octet-stream","Content-Disposition:`attachment; filename="${f.name}"`}});
}
async function approve(id,env){
  const info=await getInfo(id,env); const src=await getSubmissionFile(id,env);
  const filename=`${info.name} - ${info.description} - ${info.emoji||"⚙️"} - ${info.creator}.shortcut`;
  await put(env,`/contents/shortcuts/${encodeURIComponent(filename)}`,src.content.replace(/\n/g,""),`approve: ${info.name} by ${info.creator}`);
  const manifest=await getFile(env,"shortcuts.json"); let files=[];
  if(manifest) files=JSON.parse(fromBase64(manifest.content));
  if(!files.includes(filename)) files.push(filename);
  await put(env,"/contents/shortcuts.json",toBase64(JSON.stringify(files,null,2)),`store: add ${info.name}`);
  await put(env,`/contents/submissions/${id}/info.json`,toBase64(JSON.stringify({...info,status:"approved",approvedAt:new Date().toISOString()},null,2)),`approve submission: ${info.name}`);
  return json({ok:true});
}
async function reject(id,env){
  const info=await getInfo(id,env);
  await put(env,`/contents/submissions/${id}/info.json`,toBase64(JSON.stringify({...info,status:"rejected",rejectedAt:new Date().toISOString()},null,2)),`reject submission: ${info.name}`);
  return json({ok:true});
}
async function getInfo(id,env){
  const f=await getFile(env,`submissions/${id}/info.json`); if(!f)throw new Error("Einsendung nicht gefunden.");
  return JSON.parse(fromBase64(f.content));
}
async function getSubmissionFile(id,env){
  const r=await gh(env,`/contents/submissions/${encodeURIComponent(id)}`);if(!r.ok)throw new Error("Einsendung nicht gefunden.");
  const arr=await r.json(),f=arr.find(x=>x.name.endsWith(".shortcut"));if(!f)throw new Error("Datei nicht gefunden.");
  return getFile(env,f.path);
}
async function getFile(env,path){const r=await gh(env,`/contents/${path}`);if(r.status===404)return null;if(!r.ok)throw new Error("GitHub-Fehler.");return r.json()}
async function put(env,path,content,message){
  const old=await getFile(env,path);
  const body={message,content,...(old?.sha?{sha:old.sha}:{})};
  const r=await gh(env,path,{method:"PUT",body:JSON.stringify(body)});if(!r.ok){const t=await r.text();throw new Error("GitHub konnte Datei nicht speichern: "+t.slice(0,180))}
}
function clean(x){return String(x||"").trim().replace(/[<>]/g,"")}
function slug(x){return String(x).normalize("NFKD").replace(/[^\w\s-]/g,"").trim().replace(/\s+/g,"-").slice(0,60)||"kurzbefehl"}
function toBase64(s){return btoa(unescape(encodeURIComponent(s)))}
function fromBase64(s){return decodeURIComponent(escape(atob(s)))}
function arrayBufferToBase64(buf){let bytes=new Uint8Array(buf),chunk="";for(let i=0;i<bytes.length;i+=0x8000)chunk+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(chunk)}
function base64ToUint8(s){let bin=atob(s),out=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out}
