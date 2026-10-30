import {createHash} from 'node:crypto';
const CHUNK=192*1024,MAX_IMAGE=10*1024*1024,MAX_TOTAL=40*1024*1024;
const bad=()=>{throw Error('pi_image_transfer_invalid');};
const object=value=>!!value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact=(value,keys)=>object(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const uuid=value=>typeof value==='string'&&value.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
const hash=value=>typeof value==='string'&&value.length===64&&/^[a-f0-9]{64}$/u.test(value);
const mime=value=>['image/png','image/jpeg'].includes(value);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function context(entries){if(entries!==undefined&&(!Array.isArray(entries)||entries.length>10000||Buffer.byteLength(JSON.stringify(entries))>1024*1024))bad();}
function visit(value,transform){
  if(Array.isArray(value))return value.map(item=>visit(item,transform));
  if(object(value)){const changed=transform(value);if(changed!==value)return changed;return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item,transform)]));}
  return value;
}
function validMime(bytes,type){return type==='image/png'?bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;}
/** Private bounded transport. Native already raster-validates bytes; no path, disk or plugin access here. */
export function createImageTransfer({imageRefs,promptImageIds}={}){
  if(imageRefs===undefined&&promptImageIds!==undefined)bad();
  const refs=imageRefs===undefined?[]:imageRefs;if(!Array.isArray(refs)||refs.length>4)bad();
  const records=new Map();let total=0;
  for(const ref of refs){if(!exact(ref,['id','mimeType','sizeBytes','sha256'])||!uuid(ref.id)||!mime(ref.mimeType)||!Number.isSafeInteger(ref.sizeBytes)||ref.sizeBytes<1||ref.sizeBytes>MAX_IMAGE||!hash(ref.sha256)||records.has(ref.id))bad();
    total+=ref.sizeBytes;if(total>MAX_TOTAL)bad();records.set(ref.id,{ref:{...ref},buffer:Buffer.alloc(ref.sizeBytes),received:0,index:0,last:CHUNK,data:null});}
  const fresh=promptImageIds===undefined?[]:promptImageIds;if(!Array.isArray(fresh)||fresh.length>1||fresh.some(id=>!uuid(id)||!records.has(id)))bad();
  const newIds=[...fresh],identity=new WeakMap();let carry='',failed=false,reattached=[];
  const ready=()=>!failed&&[...records.values()].every(row=>row.data!==null);
  const available=()=>{if(failed)throw Error('pi_image_payload_disallowed');if(!ready())bad();};
  const sdk=record=>{const block={type:'image',mimeType:record.ref.mimeType,data:record.data};identity.set(block,record.ref.id);return block;};
  const typed=record=>({type:'hub_image_ref',id:record.ref.id,mimeType:record.ref.mimeType,sha256:record.ref.sha256});
  function check(value){
    if(!records.size)return;
    const encoded=typeof value==='string'?value:JSON.stringify(value);
    if([...records.values()].some(row=>row.data&&encoded.includes(row.data.slice(0,64)))){failed=true;throw Error('pi_image_payload_disallowed');}
  }
  function references(entries){context(entries);const ids=new Set();
    if(entries?.[0]?.hubImageRefs!==undefined){if(entries[0].type!=='session'||!Array.isArray(entries[0].hubImageRefs)||entries[0].hubImageRefs.length>4)bad();const seen=new Set();
      for(const ref of entries[0].hubImageRefs){const row=records.get(ref?.id);if(!exact(ref,['id','mimeType','sizeBytes','sha256'])||!row||seen.has(ref.id)||['mimeType','sizeBytes','sha256'].some(key=>row.ref[key]!==ref[key]))bad();seen.add(ref.id);}}
    visit(entries,value=>{if(value.type==='image')bad();if(value.type==='hub_image_ref'){
      if(!exact(value,['type','id','mimeType','sha256']))bad();const record=records.get(value.id);if(!record||record.ref.mimeType!==value.mimeType||record.ref.sha256!==value.sha256)bad();ids.add(value.id);
    }return value;});return ids;
  }
  return {
    enabled:records.size>0,ready,
    accept(frame){
      if(failed||!object(frame)||!records.has(frame.imageId)){failed=true;bad();}
      const row=records.get(frame.imageId);
      if(row.data!==null){failed=true;bad();}
      if(frame.type==='image_chunk'){
        if(!exact(frame,['type','imageId','index','data'])||!Number.isSafeInteger(frame.index)||frame.index!==row.index||row.last!==CHUNK||typeof frame.data!=='string'
          ||!frame.data.length||frame.data.length>262144||frame.data.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/u.test(frame.data)){failed=true;bad();}
        const bytes=Buffer.from(frame.data,'base64');if(bytes.length<1||bytes.length>CHUNK||bytes.toString('base64')!==frame.data||row.received+bytes.length>row.ref.sizeBytes){failed=true;bad();}
        bytes.copy(row.buffer,row.received);row.received+=bytes.length;row.index++;row.last=bytes.length;
      }else if(frame.type==='image_end'){
        if(!exact(frame,['type','imageId'])||row.received!==row.ref.sizeBytes||digest(row.buffer)!==row.ref.sha256||!validMime(row.buffer,row.ref.mimeType)){failed=true;bad();}
        row.data=row.buffer.toString('base64');row.buffer=null;
      }else{failed=true;bad();}
      return ready();
    },
    eof(){if(!ready()){failed=true;bad();}},
    rehydrate(entries){
      available();references(entries);
      return visit(entries,value=>{
        if(value.type==='message'&&value.message?.role==='user'&&Array.isArray(value.message.content)){
          return {...value,message:{...value.message,content:value.message.content.map(block=>block?.type==='hub_image_ref'?sdk(records.get(block.id)):block)}};
        }
        if(value.type==='hub_image_ref')bad();return value;
      });
    },
    promptImages(entries){available();const used=references(entries);reattached=[...records.keys()].filter(id=>!used.has(id)&&!newIds.includes(id));return[...newIds,...reattached].map(id=>sdk(records.get(id)));},
    inputsEvent(){return{type:'image_inputs',promptImageIds:[...newIds],reattachedImageIds:[...reattached]};},
    checkpoint(entries){
      available();if(!records.size)return entries;
      const result=visit(entries,value=>{
        if(value.type==='message'&&value.message?.role==='user'&&Array.isArray(value.message.content)){
          return {...value,message:{...value.message,content:value.message.content.map(block=>{
            if(block?.type!=='image')return block;
            if(!exact(block,['type','mimeType','data']))bad();const known=identity.get(block),candidates=[...records.values()].filter(row=>row.ref.mimeType===block.mimeType&&row.data===block.data);
            const row=known?records.get(known):candidates.length===1?candidates[0]:undefined;if(!row||row.data!==block.data||row.ref.mimeType!==block.mimeType)bad();return typed(row);
          })}};
        }
        if(value.type==='image')bad();return value;
      });if(!Array.isArray(result)||!result[0]||result[0].type!=='session')bad();
      result[0]={...result[0],hubImageRefs:[...records.values()].map(row=>({...row.ref}))};references(result);check(result);return result;
    },
    check,
    partial(delta){
      if(!records.size)return delta;available();if(typeof delta!=='string')bad();const text=carry+delta;check(text);let cut=Math.max(0,text.length-63);
      if(cut&&/[\uD800-\uDBFF]/u.test(text[cut-1])&&/[\uDC00-\uDFFF]/u.test(text[cut]))cut--;carry=text.slice(cut);return text.slice(0,cut);
    },
    flushPartial(){if(failed)throw Error('pi_image_payload_disallowed');const tail=carry;carry='';return tail;},
    event(value){
      if(!records.size)return value;
      const result=visit(value,entry=>{if(entry.role==='user')return{role:'user',...(typeof entry.timestamp==='number'?{timestamp:entry.timestamp}:{})};if(entry.type==='image')bad();return entry;});check(result);return result;
    },
  };
}
