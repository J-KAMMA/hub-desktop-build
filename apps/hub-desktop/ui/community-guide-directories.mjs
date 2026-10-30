export function guideDirectoryLabel(directories,id) {
  const byId=new Map(directories.map(item=>[item.id,item])),seen=new Set(),names=[];
  for(let item=byId.get(id);item&&!seen.has(item.id);item=byId.get(item.parentId)) {
    seen.add(item.id);names.unshift(item.name);
  }
  return names.join(' / ');
}
export function guideDirectorySelect(document,directories,value,emptyLabel) {
  const select=document.createElement('select');select.setAttribute('aria-label','分類');select.style.minWidth='0';select.style.maxWidth='100%';
  for(const [id,label] of [['',emptyLabel],...directories.map(item=>[item.id,guideDirectoryLabel(directories,item.id)])]) {
    const option=document.createElement('option');option.value=id;option.textContent=label;select.append(option);
  }
  select.value=value??'';return select;
}
