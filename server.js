import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import crypto from "crypto";

dotenv.config();
const __filename=fileURLToPath(import.meta.url), __dirname=path.dirname(__filename);
const app=express(), PORT=process.env.PORT||3000;
const DATA=path.join(__dirname,"data"), UPLOADS=path.join(DATA,"uploads");
fs.mkdirSync(UPLOADS,{recursive:true});
app.use(cors()); app.use(express.json({limit:"10mb"})); app.use(express.static(path.join(__dirname,"public")));

const SYSTEM=`Te Pista AI V3 vagy, személyes magyar AI ügynök.
Használhatsz webes keresést, számológépet, egyszerű tartós memóriát és a feltöltött dokumentumok szövegét.
A memóriába csak a felhasználó által kifejezetten megjelölt tartós információ kerüljön.
Mindig magyarul válaszolj, ha más nyelvet nem kérnek.
Ne állíts végrehajtott műveletet, ha nincs hozzá eszköz.`;

function memoryFile(id){return path.join(DATA,`${id}.json`)}
function loadMemory(id){try{return JSON.parse(fs.readFileSync(memoryFile(id),"utf8"))}catch{return []}}
function saveMemory(id,m){fs.writeFileSync(memoryFile(id),JSON.stringify(m.slice(-100),null,2))}
function safeId(id){return String(id||"default").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,60)||"default"}

async function searchWeb(q){
 if(!process.env.TAVILY_API_KEY)return "Webkeresés nincs bekapcsolva: TAVILY_API_KEY hiányzik.";
 const r=await fetch("https://api.tavily.com/search",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({api_key:process.env.TAVILY_API_KEY,query:q,max_results:5})});
 const d=await r.json(); if(!r.ok)throw Error(d?.message||"Tavily hiba");
 return (d.results||[]).map(x=>`${x.title}\n${x.url}\n${x.content}`).join("\n\n");
}
function calc(x){if(!/^[0-9+\-*/().,%\s]+$/.test(x))throw Error("Tiltott karakter.");return String(Function(`"use strict";return (${x.replace(/%/g,"/100")})`)())}

async function gemini(messages, memory, docs){
 const context=`\nMEMÓRIA:\n${memory.join("\n")||"(üres)"}\nDOKUMENTUMOK:\n${docs.join("\n\n")||"(nincs)"}`;
 const contents=[{role:"user",parts:[{text:SYSTEM+context}]}];
 for(const m of messages) contents.push({role:m.role==="assistant"?"model":"user",parts:[{text:m.content}]});
 const tools=[{functionDeclarations:[
  {name:"web_search",description:"Aktuális webes keresés",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]}},
  {name:"calculator",description:"Matematikai számítás",parameters:{type:"object",properties:{expression:{type:"string"}},required:["expression"]}},
  {name:"remember",description:"Tartós memória mentése, csak explicit felhasználói kérésre",parameters:{type:"object",properties:{text:{type:"string"}},required:["text"]}}
 ]}];
 let r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents,tools,generationConfig:{temperature:.5,maxOutputTokens:2500}})});
 let d=await r.json(); if(!r.ok)throw Error(d?.error?.message||"Gemini hiba");
 for(let i=0;i<5;i++){
  const parts=d.candidates?.[0]?.content?.parts||[], calls=parts.filter(p=>p.functionCall);
  if(!calls.length)return parts.map(p=>p.text||"").join("")||"Nincs válasz.";
  const results=[];
  for(const c of calls){
   let out;
   if(c.functionCall.name==="web_search")out=await searchWeb(c.functionCall.args.query);
   else if(c.functionCall.name==="calculator")out=calc(c.functionCall.args.expression);
   else if(c.functionCall.name==="remember"){memory.push(c.functionCall.args.text);saveMemory("default",memory);out="Elmentve a memóriába."}
   results.push({functionResponse:{name:c.functionCall.name,response:{result:out}}});
  }
  contents.push({role:"model",parts:calls.map(c=>({functionCall:c.functionCall}))});
  contents.push({role:"user",parts:results});
  r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents,tools})});
  d=await r.json();
 }
 return "Túl sok ügynöki lépés.";
}

app.get("/api/status",(q,s)=>s.json({ok:true,gemini:!!process.env.GEMINI_API_KEY,web:!!process.env.TAVILY_API_KEY,storage:true}));
app.get("/api/memory",(q,s)=>s.json({memory:loadMemory("default")}));
app.delete("/api/memory",(q,s)=>{saveMemory("default",[]);s.json({ok:true})});

app.post("/api/upload",(req,res)=>{
 const {name,content}=req.body;
 if(typeof content!=="string"||!content.trim())return res.status(400).json({error:"Nincs szöveges tartalom."});
 const id=crypto.randomUUID(), clean=(name||"dokumentum").replace(/[^a-zA-Z0-9._-]/g,"_");
 fs.writeFileSync(path.join(UPLOADS,`${id}-${clean}.txt`),content.slice(0,200000),"utf8");
 res.json({ok:true,id,name:clean});
});

app.post("/api/chat",async(req,res)=>{
 try{
  const {messages,documentIds=[]}=req.body;
  const memory=loadMemory("default");
  const docs=[];
  for(const f of fs.readdirSync(UPLOADS))if(documentIds.some(id=>f.startsWith(id)))docs.push(fs.readFileSync(path.join(UPLOADS,f),"utf8"));
  const answer=await gemini(messages,memory,docs);
  res.json({answer});
 }catch(e){console.error(e);res.status(500).json({error:e.message})}
});
app.get("*",(q,s)=>s.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`Pista AI V3: http://localhost:${PORT}`));