//! Fixed HKCU Run value; registry contents and executable paths never become UI data.
use serde::Serialize;
use std::{path::Path, sync::{Mutex, OnceLock}};

const VALUE_NAME:&str="JKamma.HubDesktop.PersonalNode";
const RUN_KEY:&str="Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const MAX_COMMAND_UTF16:usize=260;
const MAX_VALUE_BYTES:usize=4096;
const REG_SZ_VALUE:u32=1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all="snake_case")]
pub enum StartupStatusKind { Enabled, Disabled, DifferentPath, Unsupported, Unavailable }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct StartupStatus { pub supported:bool, pub status:StartupStatusKind }

#[derive(Clone, PartialEq, Eq)]
struct RegistryValue { kind:u32, bytes:Vec<u8> }
impl std::fmt::Debug for RegistryValue {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result { f.write_str("RegistryValue(redacted)") }
}
trait RegistryBackend {
    fn read(&mut self)->Result<Option<RegistryValue>, &'static str>;
    fn replace(&mut self,expected:&Option<RegistryValue>,desired:&Option<RegistryValue>)->Result<(), &'static str>;
}

fn command_for_exe(path:&Path)->Result<RegistryValue, &'static str> {
    let text=path.to_str().ok_or("startup_unavailable")?;
    let bytes=text.as_bytes();
    if bytes.len()<4 || !bytes[0].is_ascii_alphabetic() || bytes[1]!=b':' || bytes[2]!=b'\\'
        || text.chars().any(|c|c.is_control() || matches!(c,'"'|'/'|'%')) || text[3..].contains(':')
        || text[3..].split('\\').any(|part|part.is_empty() || matches!(part,"."|"..") || part.ends_with([' ','.']))
        || !text.to_ascii_lowercase().ends_with(".exe") {
        return Err("startup_unavailable");
    }
    let command=format!("\"{text}\"");
    let mut encoded=command.encode_utf16().collect::<Vec<_>>();
    if encoded.len()>MAX_COMMAND_UTF16 { return Err("startup_unavailable"); }
    encoded.push(0);
    Ok(RegistryValue {kind:REG_SZ_VALUE,bytes:encoded.into_iter().flat_map(u16::to_le_bytes).collect()})
}
fn current_command()->Result<RegistryValue, &'static str> {
    let path=std::env::current_exe().map_err(|_|"startup_unavailable")?;
    command_for_exe(&path)
}
fn status_with(backend:&mut impl RegistryBackend,command:&RegistryValue)->StartupStatusKind {
    match backend.read() {
        Ok(None)=>StartupStatusKind::Disabled,
        Ok(Some(value)) if value==*command=>StartupStatusKind::Enabled,
        Ok(Some(_))|Err("startup_ownership_conflict")=>StartupStatusKind::DifferentPath,
        Err(_)=>StartupStatusKind::Unavailable,
    }
}
pub fn status()->StartupStatus {
    if !cfg!(windows) { return StartupStatus {supported:false,status:StartupStatusKind::Unsupported}; }
    let result=current_command().map(|command|status_with(&mut SystemRegistry,&command)).unwrap_or(StartupStatusKind::Unavailable);
    StartupStatus {supported:true,status:result}
}

fn rollback(backend:&mut impl RegistryBackend,before:&Option<RegistryValue>,desired:&Option<RegistryValue>)->Result<(), &'static str> {
    let current=backend.read().map_err(|_|"startup_result_unknown")?;
    if current==*before { return Ok(()); }
    if current!=*desired { return Err("startup_ownership_conflict"); }
    backend.replace(desired,before).map_err(|_|"startup_result_unknown")?;
    if backend.read().map_err(|_|"startup_result_unknown")?!=*before { return Err("startup_result_unknown"); }
    Ok(())
}
fn set_with_backend(backend:&mut impl RegistryBackend,command:RegistryValue,enabled:bool,
    persist:impl FnOnce()->Result<(), &'static str>)->Result<(), &'static str> {
    let before=backend.read()?;
    if before.as_ref().is_some_and(|value|value!=&command) { return Err("startup_ownership_conflict"); }
    let desired=enabled.then_some(command);
    if before==desired { return persist(); }
    if let Err(error)=backend.replace(&before,&desired) {
        rollback(backend,&before,&desired)?;
        return Err(error);
    }
    if !backend.read().is_ok_and(|current|current==desired) {
        rollback(backend,&before,&desired)?;
        return Err("startup_result_unknown");
    }
    if let Err(error)=persist() { rollback(backend,&before,&desired)?; return Err(error); }
    Ok(())
}
pub fn set_with(enabled:bool,persist:impl FnOnce()->Result<(), &'static str>)->Result<(), &'static str> {
    if !cfg!(windows) { return if enabled {Err("startup_unsupported")} else {persist()}; }
    static LOCK:OnceLock<Mutex<()>>=OnceLock::new();
    let _guard=LOCK.get_or_init(||Mutex::new(())).lock().map_err(|_|"startup_unavailable")?;
    set_with_backend(&mut SystemRegistry,current_command()?,enabled,persist)
}

struct SystemRegistry;
impl RegistryBackend for SystemRegistry {
    fn read(&mut self)->Result<Option<RegistryValue>, &'static str> {
        // Unit tests use the injected fake backend; they cannot mutate the actual login entry.
        #[cfg(any(test,not(windows)))] { Err("startup_unavailable") }
        #[cfg(all(windows,not(test)))] { windows::read() }
    }
    fn replace(&mut self,expected:&Option<RegistryValue>,desired:&Option<RegistryValue>)->Result<(), &'static str> {
        #[cfg(any(test,not(windows)))] { let _=(expected,desired); Err("startup_unavailable") }
        #[cfg(all(windows,not(test)))] {
            if windows::read()?!=*expected { return Err("startup_ownership_conflict"); }
            windows::write(desired)
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use windows_sys::Win32::{Foundation::{ERROR_FILE_NOT_FOUND,ERROR_SUCCESS},System::Registry::{
        RegQueryValueExW,RegCreateKeyW,RegOpenKeyExW,RegCloseKey,RegSetValueExW,RegDeleteValueW,
        HKEY,HKEY_CURRENT_USER,KEY_QUERY_VALUE,KEY_SET_VALUE}};
    fn wide(value:&str)->Vec<u16> { value.encode_utf16().chain(std::iter::once(0)).collect() }
    struct Key(HKEY);
    impl Drop for Key { fn drop(&mut self) {unsafe {RegCloseKey(self.0);}} }
    pub(super) fn read()->Result<Option<RegistryValue>, &'static str> {
        let path=wide(RUN_KEY); let name=wide(VALUE_NAME); let mut raw=std::ptr::null_mut();
        let result=unsafe {RegOpenKeyExW(HKEY_CURRENT_USER,path.as_ptr(),0,KEY_QUERY_VALUE,&mut raw)};
        if result==ERROR_FILE_NOT_FOUND {return Ok(None);}
        if result!=ERROR_SUCCESS {return Err("startup_unavailable");}
        let handle=Key(raw); let mut kind=0; let mut length=0;
        // QueryValueEx preserves raw type/bytes, including malformed/non-terminated strings.
        let result=unsafe {RegQueryValueExW(handle.0,name.as_ptr(),std::ptr::null_mut(),&mut kind,std::ptr::null_mut(),&mut length)};
        if result==ERROR_FILE_NOT_FOUND {return Ok(None);}
        if result!=ERROR_SUCCESS {return Err("startup_unavailable");}
        if length as usize>MAX_VALUE_BYTES {return Err("startup_ownership_conflict");}
        let mut bytes=vec![0u8;length as usize];
        let result=unsafe {RegQueryValueExW(handle.0,name.as_ptr(),std::ptr::null_mut(),&mut kind,bytes.as_mut_ptr(),&mut length)};
        if result==ERROR_FILE_NOT_FOUND {return Ok(None);}
        if result!=ERROR_SUCCESS || length as usize>bytes.len() {return Err("startup_unavailable");}
        bytes.truncate(length as usize);
        Ok(Some(RegistryValue {kind,bytes}))
    }
    pub(super) fn write(desired:&Option<RegistryValue>)->Result<(), &'static str> {
        let path=wide(RUN_KEY); let name=wide(VALUE_NAME); let mut raw=std::ptr::null_mut();
        let opened=unsafe {
            if desired.is_some() {RegCreateKeyW(HKEY_CURRENT_USER,path.as_ptr(),&mut raw)}
            else {RegOpenKeyExW(HKEY_CURRENT_USER,path.as_ptr(),0,KEY_SET_VALUE,&mut raw)}
        };
        if opened==ERROR_FILE_NOT_FOUND && desired.is_none() {return Ok(());}
        if opened!=ERROR_SUCCESS {return Err("startup_unavailable");}
        let handle=Key(raw);
        let result=unsafe {
            match desired {
                Some(value)=>RegSetValueExW(handle.0,name.as_ptr(),0,value.kind,value.bytes.as_ptr(),value.bytes.len() as u32),
                None=>RegDeleteValueW(handle.0,name.as_ptr()),
            }
        };
        if result==ERROR_SUCCESS || result==ERROR_FILE_NOT_FOUND && desired.is_none() {Ok(())}
        else {Err("startup_unavailable")}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::{Cell,RefCell},rc::Rc};
    #[derive(Default)]
    struct Fake {value:Rc<RefCell<Option<RegistryValue>>>,writes:usize,read_fail:bool,write_fail:bool,fail_read_after_write:bool,after_write:Option<RegistryValue>}
    impl RegistryBackend for Fake {
        fn read(&mut self)->Result<Option<RegistryValue>, &'static str> {if self.read_fail {Err("startup_unavailable")} else {Ok(self.value.borrow().clone())}}
        fn replace(&mut self,expected:&Option<RegistryValue>,desired:&Option<RegistryValue>)->Result<(), &'static str> {
            if *self.value.borrow()!=*expected {return Err("startup_ownership_conflict");}
            if self.write_fail {return Err("startup_unavailable");}
            self.writes+=1; *self.value.borrow_mut()=self.after_write.clone().or_else(||desired.clone());
            if self.fail_read_after_write {self.read_fail=true;}
            Ok(())
        }
    }
    fn command()->RegistryValue {command_for_exe(Path::new(r"C:\Program Files\JKamma\Hub.exe")).unwrap()}
    #[test]
    fn executable_command_is_exact_quoted_utf16_with_no_flags() {
        let value=command(); let units=value.bytes.chunks_exact(2).map(|c|u16::from_le_bytes([c[0],c[1]])).collect::<Vec<_>>();
        assert_eq!(String::from_utf16(&units[..units.len()-1]).unwrap(),r#""C:\Program Files\JKamma\Hub.exe""#);
        assert_eq!(units.last(),Some(&0));
        for path in [r"Hub.exe",r"C:Hub.exe",r"\server\Hub.exe",r"\\server\share\Hub.exe",r"\\?\C:\Hub.exe",r"C:\a\..\Hub.exe",r"C:\a\\Hub.exe",r"C:/Hub.exe",r"C:\file:ads.exe",r"C:\Hub.exe --control-stdio",r"C:\a%\Hub.exe","C:\\a\n\\Hub.exe","C:\\a\0\\Hub.exe","C:\\a\"\\Hub.exe"] {
            assert!(command_for_exe(Path::new(path)).is_err());
        }
        assert!(command_for_exe(Path::new(&format!("C:\\{}\\Hub.exe","🌿".repeat(126)))).is_err());
        assert!(command_for_exe(Path::new(&format!("C:\\{}\\Hub.exe","a".repeat(247)))).is_ok());
        assert!(command_for_exe(Path::new(&format!("C:\\{}\\Hub.exe","a".repeat(248)))).is_err());
    }
    #[test]
    fn exact_current_absent_foreign_and_unavailable_statuses_are_distinct() {
        let mut backend=Fake::default(); let command=command(); assert_eq!(status_with(&mut backend,&command),StartupStatusKind::Disabled);
        *backend.value.borrow_mut()=Some(command.clone()); assert_eq!(status_with(&mut backend,&command),StartupStatusKind::Enabled);
        backend.value.borrow_mut().as_mut().unwrap().bytes.push(0); assert_eq!(status_with(&mut backend,&command),StartupStatusKind::DifferentPath);
        backend.read_fail=true; assert_eq!(status_with(&mut backend,&command),StartupStatusKind::Unavailable);
        let dto=serde_json::to_string(&StartupStatus {supported:true,status:StartupStatusKind::DifferentPath}).unwrap();
        assert_eq!(dto,r#"{"supported":true,"status":"different_path"}"#);
    }
    #[test]
    fn enable_disable_and_same_state_save_persist_only_after_exact_readback() {
        let mut backend=Fake::default(); let saved=Cell::new(0);
        set_with_backend(&mut backend,command(),false,||{saved.set(saved.get()+1);Ok(())}).unwrap(); assert_eq!(backend.writes,0);
        set_with_backend(&mut backend,command(),true,||{saved.set(saved.get()+1);Ok(())}).unwrap(); assert_eq!(backend.writes,1);
        set_with_backend(&mut backend,command(),true,||{saved.set(saved.get()+1);Ok(())}).unwrap(); assert_eq!(backend.writes,1);
        set_with_backend(&mut backend,command(),false,||{saved.set(saved.get()+1);Ok(())}).unwrap(); assert_eq!(backend.writes,2); assert_eq!(saved.get(),4);
    }
    #[test]
    fn foreign_owner_is_never_overwritten_or_deleted() {
        for enabled in [false,true] {
            let mut backend=Fake::default(); let foreign=command_for_exe(Path::new(r"C:\Other\Hub.exe")).unwrap(); *backend.value.borrow_mut()=Some(foreign.clone());
            assert_eq!(set_with_backend(&mut backend,command(),enabled,||panic!("must not persist")).unwrap_err(),"startup_ownership_conflict");
            assert_eq!(*backend.value.borrow(),Some(foreign)); assert_eq!(backend.writes,0);
        }
    }
    #[test]
    fn persistence_failure_rolls_back_exact_snapshot_for_both_directions() {
        for enabled in [false,true] {
            let mut backend=Fake::default(); let before=(!enabled).then(command); *backend.value.borrow_mut()=before.clone();
            assert_eq!(set_with_backend(&mut backend,command(),enabled,||Err("node_state_unavailable")).unwrap_err(),"node_state_unavailable");
            assert_eq!(*backend.value.borrow(),before); assert_eq!(backend.writes,2);
        }
    }
    #[test]
    fn write_failures_and_intervening_ownership_changes_never_become_success() {
        let mut backend=Fake {write_fail:true,..Default::default()};
        assert_eq!(set_with_backend(&mut backend,command(),true,||panic!("must not persist")).unwrap_err(),"startup_unavailable");
        assert!(backend.value.borrow().is_none());
        let mut backend=Fake::default(); let foreign=command_for_exe(Path::new(r"C:\Other\Hub.exe")).unwrap(); backend.after_write=Some(foreign.clone());
        assert_eq!(set_with_backend(&mut backend,command(),true,||panic!("must not persist")).unwrap_err(),"startup_ownership_conflict");
        assert_eq!(*backend.value.borrow(),Some(foreign.clone())); assert_eq!(backend.writes,1);
        let mut backend=Fake::default(); let value=backend.value.clone();
        assert_eq!(set_with_backend(&mut backend,command(),true,||{*value.borrow_mut()=Some(foreign.clone());Err("node_state_unavailable")}).unwrap_err(),"startup_ownership_conflict");
        assert_eq!(*backend.value.borrow(),Some(foreign)); assert_eq!(backend.writes,1);
    }
    #[test]
    fn unreadable_readback_does_not_persist_or_blindly_delete() {
        let mut backend=Fake {fail_read_after_write:true,..Default::default()};
        assert_eq!(set_with_backend(&mut backend,command(),true,||panic!("must not persist")).unwrap_err(),"startup_result_unknown");
        assert_eq!(backend.writes,1); assert_eq!(*backend.value.borrow(),Some(command()));
    }
    #[test]
    fn system_backend_is_not_a_test_permission_toggle() {
        let mut backend=SystemRegistry;
        assert_eq!(backend.read().unwrap_err(),"startup_unavailable");
        assert_eq!(backend.replace(&None,&Some(command())).unwrap_err(),"startup_unavailable");
    }
}
