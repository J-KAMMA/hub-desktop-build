//! Pending image handles are memory-only; claimed images use a separate AI encrypted store.
use crate::{checkpoint::CheckpointStore,image_validation::{prepare_image,ValidatedImage,MAX_IMAGE_BYTES}};
use base64::{engine::general_purpose::STANDARD,Engine};
use serde::{Deserialize,Serialize};
use std::{collections::HashMap,path::{Path,PathBuf},sync::Mutex,time::{Duration,Instant,SystemTime,UNIX_EPOCH}};

pub(crate) const FOLDER:&str="pi-image-attachments";
const MAX_PENDING:usize=4;
const MAX_PENDING_BYTES:usize=40*1024*1024;
const TTL:Duration=Duration::from_secs(600);
const MAX_RECORD_BYTES:usize=16*1024*1024;

#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct ImageReference {pub id:String,pub mime_type:String,pub size_bytes:usize,pub sha256:String}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
pub(crate) enum ImageAttachmentKind {#[serde(rename="image")] Image}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct ImageAttachment {pub r#type:ImageAttachmentKind,pub id:String,pub name:String,pub mime_type:String,pub size_bytes:usize}
impl std::fmt::Debug for ImageAttachment {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {
        f.debug_struct("ImageAttachment").field("id",&self.id).field("mime_type",&self.mime_type).field("size_bytes",&self.size_bytes).finish()
    }
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct PreparedImage {pub attachment:ImageAttachment,pub workspace:String,pub width:u32,pub height:u32,pub sha256:String,pub expires_at_ms:u64}
struct PendingImage {model:String,context_id:String,name:String,workspace:PathBuf,image:ValidatedImage,expires:Instant}
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct EncryptedImage {version:u8,reference:ImageReference,model:String,context_id:String,name:String,workspace:PathBuf,width:u32,height:u32,data_base64:String}
pub(crate) struct StoredImage {record:EncryptedImage}
impl StoredImage {
    pub(crate) fn reference(&self)->ImageReference {self.record.reference.clone()}
    pub(crate) fn attachment(&self)->ImageAttachment {ImageAttachment {r#type:ImageAttachmentKind::Image,id:self.record.reference.id.clone(),name:self.record.name.clone(),
        mime_type:self.record.reference.mime_type.clone(),size_bytes:self.record.reference.size_bytes}}
    pub(crate) fn width(&self)->u32 {self.record.width}
    pub(crate) fn height(&self)->u32 {self.record.height}
    pub(crate) fn data_base64(&self)->&str {&self.record.data_base64}
    pub(crate) fn into_transfer(self)->crate::pi_sidecar::ImageTransfer {
        let record=self.record;
        crate::pi_sidecar::ImageTransfer {id:record.reference.id,mime_type:record.reference.mime_type,size_bytes:record.reference.size_bytes,
            sha256:record.reference.sha256,data_base64:record.data_base64}
    }
}
#[derive(Default)]
pub(crate) struct PiImageStore {
    pending:Mutex<HashMap<String,PendingImage>>,
    #[cfg(test)] test_store:Option<CheckpointStore>,
}
fn uuid4(value:&str)->bool {uuid::Uuid::parse_str(value).is_ok_and(|id|id.get_version_num()==4 && id.get_variant()==uuid::Variant::RFC4122 && id.to_string()==value)}
fn model_valid(value:&str)->bool { !value.is_empty() && value.len()<=64 && value.starts_with(|c:char|c.is_ascii_alphanumeric()) && !value.contains("..")
    && value.chars().all(|c|c.is_ascii_alphanumeric() || matches!(c,'/'|'-'|'_'|'.'|':')) }
fn name_valid(value:&str)->bool { !value.trim().is_empty() && value.encode_utf16().count()<=255 && !value.chars().any(|c|c.is_control() || matches!(c,'/'|'\\')) }
fn workspace_valid(value:&Path)->bool {value.is_absolute() && value.to_str().is_some_and(|text|text.encode_utf16().count()<=32767 && !text.contains('\0'))}
fn reference_valid(value:&ImageReference)->bool {
    uuid4(&value.id) && matches!(value.mime_type.as_str(),"image/png"|"image/jpeg") && (1..=MAX_IMAGE_BYTES).contains(&value.size_bytes)
        && value.sha256.len()==64 && value.sha256.bytes().all(|b|b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn can_prepare(count:usize,total:usize,size:usize)->bool {
    count<MAX_PENDING && (1..=MAX_IMAGE_BYTES).contains(&size) && total.checked_add(size).is_some_and(|sum|sum<=MAX_PENDING_BYTES)
}
impl PiImageStore {
    fn storage(&self,existing:bool)->Result<CheckpointStore,&'static str> {
        #[cfg(test)] {let _=existing;self.test_store.clone().ok_or("pi_image_storage_unavailable")}
        #[cfg(not(test))] {
            if existing {CheckpointStore::with_existing_key(FOLDER,"checkpoint-key-v1")} else {CheckpointStore::named(FOLDER)}
                .map_err(|_|"pi_image_storage_unavailable")
        }
    }
    #[cfg(test)]
    pub(crate) fn with_test_store(store:CheckpointStore)->Self {Self {pending:Mutex::default(),test_store:Some(store)}}
    pub(crate) fn prepare(&self,model:&str,context_id:&str,name:&str,workspace:PathBuf,image:ValidatedImage)->Result<PreparedImage,&'static str> {
        if !model_valid(model) || !uuid4(context_id) || !name_valid(name) || !workspace_valid(&workspace) {return Err("pi_image_invalid_request");}
        let now=Instant::now();let metadata=image.metadata();
        let millis=u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_|"pi_image_unavailable")?.as_millis()).map_err(|_|"pi_image_unavailable")?;
        let expires_at_ms=millis.checked_add(600_000).filter(|value|*value<=9_007_199_254_740_991).ok_or("pi_image_unavailable")?;
        let mut pending=self.pending.lock().map_err(|_|"pi_image_unavailable")?;
        pending.retain(|_,entry|now<entry.expires);
        let total=pending.values().try_fold(0usize,|total,entry|total.checked_add(entry.image.metadata().size_bytes)).ok_or("pi_image_limit")?;
        if !can_prepare(pending.len(),total,metadata.size_bytes) {return Err("pi_image_limit");}
        let id=uuid::Uuid::new_v4().to_string();
        let prepared=PreparedImage {attachment:ImageAttachment {r#type:ImageAttachmentKind::Image,id:id.clone(),name:name.into(),mime_type:metadata.mime_type.into(),size_bytes:metadata.size_bytes},
            workspace:crate::pi_work::non_verbatim(workspace.clone()).to_string_lossy().into_owned(),width:metadata.width,height:metadata.height,sha256:metadata.sha256,
            expires_at_ms};
        pending.insert(id,PendingImage {model:model.into(),context_id:context_id.into(),name:name.into(),workspace,image,expires:now.checked_add(TTL).ok_or("pi_image_unavailable")?});
        Ok(prepared)
    }
    pub(crate) fn release(&self,id:&str,context_id:&str)->Result<bool,&'static str> {
        if !uuid4(id) || !uuid4(context_id) {return Err("pi_image_invalid_request");}
        let mut pending=self.pending.lock().map_err(|_|"pi_image_unavailable")?;
        let Some(entry)=pending.get(id) else {return Ok(false);};
        if entry.context_id!=context_id {return Err("pi_image_context_changed");}
        pending.remove(id);Ok(true)
    }
    pub(crate) fn claim_and_save(&self,id:&str,context_id:&str,model:&str,current_workspace:&Path)->Result<StoredImage,&'static str> {
        if !uuid4(id) || !uuid4(context_id) || !model_valid(model) || !workspace_valid(current_workspace) {return Err("pi_image_invalid_request");}
        let mut pending=self.pending.lock().map_err(|_|"pi_image_unavailable")?;
        if pending.get(id).is_some_and(|entry|Instant::now()>=entry.expires) {pending.remove(id);return Err("pi_image_expired");}
        let entry=pending.get(id).ok_or("pi_image_unavailable")?;
        if entry.context_id!=context_id || entry.model!=model || entry.workspace!=current_workspace {return Err("pi_image_context_changed");}
        let metadata=entry.image.metadata();
        let record=EncryptedImage {version:1,reference:ImageReference {id:id.into(),mime_type:metadata.mime_type.into(),size_bytes:metadata.size_bytes,sha256:metadata.sha256},
            model:entry.model.clone(),context_id:entry.context_id.clone(),name:entry.name.clone(),workspace:entry.workspace.clone(),width:metadata.width,height:metadata.height,
            data_base64:entry.image.data_base64().into()};
        if serde_json::to_vec(&record).map_err(|_|"pi_image_storage_unavailable")?.len()>MAX_RECORD_BYTES {return Err("pi_image_limit");}
        self.storage(false)?.save(id,&record).map_err(|_|"pi_image_storage_unavailable")?;
        pending.remove(id);
        Ok(StoredImage {record})
    }
    pub(crate) fn load(&self,reference:&ImageReference,current_workspace:&Path)->Result<StoredImage,&'static str> {
        if !reference_valid(reference) || !workspace_valid(current_workspace) {return Err("pi_image_invalid_request");}
        let record=self.storage(true)?.load_optional_bounded::<EncryptedImage>(&reference.id,MAX_RECORD_BYTES)
            .map_err(|_|"pi_image_unavailable")?.ok_or("pi_image_unavailable")?;
        if record.version!=1 || &record.reference!=reference || record.workspace!=current_workspace || !model_valid(&record.model)
            || !uuid4(&record.context_id) || !name_valid(&record.name) || record.data_base64.len()>4*((MAX_IMAGE_BYTES+2)/3) {return Err("pi_image_corrupt");}
        let bytes=STANDARD.decode(&record.data_base64).map_err(|_|"pi_image_corrupt")?;
        if bytes.len()!=reference.size_bytes {return Err("pi_image_corrupt");}
        let validated=prepare_image(&bytes).map_err(|_|"pi_image_corrupt")?;let metadata=validated.metadata();
        if metadata.mime_type!=reference.mime_type || metadata.sha256!=reference.sha256 || metadata.width!=record.width || metadata.height!=record.height {return Err("pi_image_corrupt");}
        Ok(StoredImage {record})
    }
}

#[cfg(test)]
mod limits_tests {
    use super::*;
    #[test]
    fn identity_name_and_memory_widths_are_closed() {
        assert!(uuid4("00000000-0000-4000-8000-000000000001"));
        assert!(!uuid4("00000000-0000-1000-8000-000000000001"));
        assert!(!uuid4("ABCDEF00-0000-4000-8000-000000000001"));
        assert!(name_valid(&"🌿".repeat(127)));assert!(!name_valid(&"🌿".repeat(128)));
        for name in ["", "  ", "a/b.png", "a\\b.jpg", "a\0b", "a\nb"] {assert!(!name_valid(name));}
        assert!(can_prepare(3,30*1024*1024,MAX_IMAGE_BYTES));assert!(!can_prepare(4,0,1));
        assert!(!can_prepare(3,MAX_PENDING_BYTES,1));assert!(!can_prepare(0,usize::MAX,1));assert!(!can_prepare(0,0,MAX_IMAGE_BYTES+1));
    }
}
#[cfg(all(test,windows))]
mod store_tests {
    use super::*;
    struct Fixture {root:PathBuf,cwd:PathBuf,context:String,key_store:CheckpointStore,store:PiImageStore}
    impl Fixture {
        fn new()->Self {
            let root=std::env::temp_dir().join(format!("hub-pi-image-test-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&root).unwrap();
            let cwd=root.canonicalize().unwrap();let key_store=CheckpointStore::test(root.join("encrypted"),[41;32]);
            Self {root,cwd,context:uuid::Uuid::new_v4().to_string(),store:PiImageStore::with_test_store(key_store.clone()),key_store}
        }
        fn prepare(&self)->PreparedImage {self.store.prepare("ollama/vision:7b",&self.context,"PRIVATE-IMAGE-NAME.png",self.cwd.clone(),image()).ok().unwrap()}
        fn claim(&self,id:&str)->Result<StoredImage,&'static str> {self.store.claim_and_save(id,&self.context,"ollama/vision:7b",&self.cwd)}
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if self.root.parent()==Some(std::env::temp_dir().as_path()) && self.root.file_name().unwrap().to_string_lossy().starts_with("hub-pi-image-test-") {let _=std::fs::remove_dir_all(&self.root);}
        }
    }
    const PNG:&str="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    fn image()->ValidatedImage {prepare_image(&STANDARD.decode(PNG).unwrap()).ok().unwrap()}
    #[test]
    fn default_preparation_is_memory_only_and_limits_release_and_expiry_are_enforced() {
        let f=Fixture::new();let store=PiImageStore::default();let mut ids=Vec::new();
        for _ in 0..4 {ids.push(store.prepare("ollama/vision:7b",&f.context,"image.png",f.cwd.clone(),image()).ok().unwrap().attachment.id);}
        assert_eq!(store.prepare("ollama/vision:7b",&f.context,"image.png",f.cwd.clone(),image()).err(),Some("pi_image_limit"));
        assert_eq!(store.claim_and_save(&ids[0],&f.context,"ollama/vision:7b",&f.cwd).err(),Some("pi_image_storage_unavailable"));
        assert_eq!(store.pending.lock().unwrap().len(),4);
        assert_eq!(store.release(&ids[0],&uuid::Uuid::new_v4().to_string()).err(),Some("pi_image_context_changed"));
        assert!(store.release(&ids[0],&f.context).unwrap());assert!(!store.release(&ids[0],&f.context).unwrap());
        store.pending.lock().unwrap().get_mut(&ids[1]).unwrap().expires=Instant::now();
        assert_eq!(store.claim_and_save(&ids[1],&f.context,"ollama/vision:7b",&f.cwd).err(),Some("pi_image_expired"));
        assert!(std::fs::read_dir(f.root.join("encrypted")).unwrap().next().is_none());
    }
    #[test]
    fn wrong_scope_and_failed_save_preserve_pending_then_success_is_one_shot() {
        let f=Fixture::new();let prepared=f.prepare();let id=&prepared.attachment.id;
        assert_eq!(f.store.claim_and_save(id,&uuid::Uuid::new_v4().to_string(),"ollama/vision:7b",&f.cwd).err(),Some("pi_image_context_changed"));
        assert_eq!(f.store.claim_and_save(id,&f.context,"ollama/other:7b",&f.cwd).err(),Some("pi_image_context_changed"));
        assert_eq!(f.store.claim_and_save(id,&f.context,"ollama/vision:7b",&f.cwd.join("different")).err(),Some("pi_image_context_changed"));
        let blocker=f.root.join("encrypted").join(format!("{id}.jkcp"));std::fs::create_dir(&blocker).unwrap();
        assert_eq!(f.claim(id).err(),Some("pi_image_storage_unavailable"));assert!(f.store.pending.lock().unwrap().contains_key(id));
        std::fs::remove_dir(blocker).unwrap();let saved=f.claim(id).ok().unwrap();
        assert_eq!(f.claim(id).err(),Some("pi_image_unavailable"));assert!(!f.store.release(id,&f.context).unwrap());
        assert!(f.key_store.load::<EncryptedImage>(id).is_some());assert_eq!(saved.reference().id,*id);
    }
    #[test]
    fn encrypted_load_checks_key_workspace_reference_and_original_decoded_bytes() {
        let f=Fixture::new();let prepared=f.prepare();let saved=f.claim(&prepared.attachment.id).ok().unwrap();let reference=saved.reference();
        let cipher=std::fs::read(f.root.join("encrypted").join(format!("{}.jkcp",reference.id))).unwrap();
        assert!(!String::from_utf8_lossy(&cipher).contains(PNG));assert!(!String::from_utf8_lossy(&cipher).contains("PRIVATE-IMAGE-NAME"));
        let loaded=f.store.load(&reference,&f.cwd).ok().unwrap();assert_eq!(loaded.reference().sha256,reference.sha256);
        let transfer=loaded.into_transfer();assert_eq!(STANDARD.decode(transfer.data_base64).unwrap(),STANDARD.decode(PNG).unwrap());
        let wrong=PiImageStore::with_test_store(CheckpointStore::test(f.root.join("encrypted"),[42;32]));assert!(wrong.load(&reference,&f.cwd).is_err());
        assert_eq!(f.store.load(&reference,&f.cwd.join("other")).err(),Some("pi_image_corrupt"));
        let mut changed=reference.clone();changed.sha256="0".repeat(64);assert_eq!(f.store.load(&changed,&f.cwd).err(),Some("pi_image_corrupt"));
        changed=reference.clone();changed.id=uuid::Uuid::new_v4().to_string();assert_eq!(f.store.load(&changed,&f.cwd).err(),Some("pi_image_unavailable"));
    }
    #[test]
    fn authenticated_but_corrupt_base64_size_mime_and_record_id_fail_closed() {
        let f=Fixture::new();let prepared=f.prepare();let reference=f.claim(&prepared.attachment.id).ok().unwrap().reference();
        let original=f.key_store.load::<EncryptedImage>(&reference.id).unwrap();
        for case in 0..4 {
            let mut record:EncryptedImage=serde_json::from_value(serde_json::to_value(&original).unwrap()).unwrap();
            match case {0=>record.data_base64="invalid!".into(),1=>record.reference.size_bytes+=1,2=>record.reference.mime_type="image/jpeg".into(),_=>record.reference.id=uuid::Uuid::new_v4().to_string()}
            f.key_store.save(&reference.id,&record).unwrap();assert!(f.store.load(&reference,&f.cwd).is_err());
            if matches!(case,1|2) {assert!(f.store.load(&record.reference,&f.cwd).is_err());}
        }
    }
}
