export function hubMusicQuery(path){
  if(typeof path!=='string'||path.length>4096||!/^\/(?:v2\/)?music\?/u.test(path)||/[\u0000-\u001f\u007f-\u009f\\#]/u.test(path))return null;
  try{decodeURIComponent(path);}catch{return null;}
  const url=new URL(path,'https://hub.invalid');
  if(!['/music','/v2/music'].includes(url.pathname)||url.searchParams.size!==1||!url.searchParams.has('q'))return null;
  const value=url.searchParams.get('q');
  if(!value?.trim()||value.length>100||value.trim().split(/\s+/u).length>8||/[\u0000-\u001f\u007f-\u009f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))return null;
  return value;
}
