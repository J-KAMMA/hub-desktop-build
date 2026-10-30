//! Byte-only image validation. No picker, path, provider or persistence capability.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha2::{Digest,Sha256};

pub(crate) const MAX_IMAGE_BYTES:usize=10*1024*1024;
const MAX_SIDE:u32=4096;
const MAX_PIXELS:u64=16_777_216;
#[cfg(test)]
std::thread_local! {static STRICT_PNG_CALLS:std::cell::Cell<usize>=const {std::cell::Cell::new(0)};}

#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct ImageMetadata { pub mime_type:&'static str, pub width:u32, pub height:u32, pub size_bytes:usize, pub sha256:String }
pub(crate) struct ValidatedImage { metadata:ImageMetadata, data_base64:String }
impl ValidatedImage {
    pub(crate) fn metadata(&self)->ImageMetadata {self.metadata.clone()}
    pub(crate) fn data_base64(&self)->&str {&self.data_base64}
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
enum Format { Png,Jpeg }
fn dimensions(width:u32,height:u32)->Result<usize,&'static str> {
    if width==0 || height==0 || width>MAX_SIDE || height>MAX_SIDE || u64::from(width)*u64::from(height)>MAX_PIXELS {return Err("image_dimensions_invalid");}
    (width as usize).checked_mul(height as usize).and_then(|pixels|pixels.checked_mul(4)).ok_or("image_dimensions_invalid")
}
fn crc32(bytes:&[u8])->u32 {
    !bytes.iter().fold(!0u32,|mut crc,&byte| {crc^=u32::from(byte);for _ in 0..8 {crc=(crc>>1)^(0xedb88320u32&0u32.wrapping_sub(crc&1));}crc})
}
fn png_header(bytes:&[u8])->Result<(u32,u32),&'static str> {
    let mut cursor=8usize; let mut size=None; let mut idat=false; let mut idat_closed=false;
    let mut zlib_prefix=Vec::with_capacity(2);
    while cursor<bytes.len() {
        let head=bytes.get(cursor..cursor.checked_add(8).ok_or("image_invalid")?).ok_or("image_invalid")?;
        let length=u32::from_be_bytes(head[..4].try_into().unwrap()) as usize;
        let end=cursor.checked_add(12).and_then(|value|value.checked_add(length)).ok_or("image_invalid")?;
        let chunk=bytes.get(cursor+4..end).ok_or("image_invalid")?; let kind=&chunk[..4]; let data=&chunk[4..chunk.len()-4];
        if !kind.iter().all(u8::is_ascii_alphabetic) || !kind[2].is_ascii_uppercase()
            || crc32(&chunk[..chunk.len()-4])!=u32::from_be_bytes(chunk[chunk.len()-4..].try_into().unwrap()) {return Err("image_invalid");}
        if matches!(kind,b"acTL"|b"fcTL"|b"fdAT") {return Err("image_format_unsupported");}
        if size.is_none() && kind!=b"IHDR" {return Err("image_invalid");}
        match kind {
            b"IHDR"=>{
                if size.is_some() || data.len()!=13 {return Err("image_invalid");}
                let width=u32::from_be_bytes(data[..4].try_into().unwrap()); let height=u32::from_be_bytes(data[4..8].try_into().unwrap());
                dimensions(width,height)?; size=Some((width,height));
            }
            b"IDAT"=>{if idat_closed {return Err("image_invalid");}idat=true;zlib_prefix.extend(data.iter().copied().take(2-zlib_prefix.len()));}
            b"IEND"=>{
                if !data.is_empty() || !idat || end!=bytes.len() || zlib_prefix.len()!=2
                    || zlib_prefix[0]&15!=8 || zlib_prefix[0]>>4>7 || zlib_prefix[1]&32!=0
                    || u16::from_be_bytes([zlib_prefix[0],zlib_prefix[1]])%31!=0 {return Err("image_invalid");}
                return size.ok_or("image_invalid");
            }
            b"PLTE"=>{if idat || data.is_empty() || data.len()%3!=0 || data.len()>768 {return Err("image_invalid");}}
            _ if kind[0].is_ascii_uppercase()=>return Err("image_format_unsupported"),
            _=>{}
        }
        if idat && kind!=b"IDAT" {idat_closed=true;}
        cursor=end;
    }
    Err("image_invalid")
}
fn strict_png(bytes:&[u8],width:u32,height:u32)->Result<(),&'static str> {
    #[cfg(test)]
    STRICT_PNG_CALLS.with(|calls|calls.set(calls.get()+1));
    let limit=dimensions(width,height)?;
    let mut decoder=png::Decoder::new_with_limits(std::io::Cursor::new(bytes),png::Limits {bytes:64*1024*1024});
    decoder.set_ignore_text_chunk(true);decoder.set_ignore_iccp_chunk(true);
    decoder.ignore_checksums(false);
    decoder.set_transformations(png::Transformations::EXPAND|png::Transformations::STRIP_16);
    let mut reader=decoder.read_info().map_err(|_|"image_invalid")?;
    if reader.info().animation_control.is_some() || (reader.info().width,reader.info().height)!=(width,height) {return Err("image_invalid");}
    let count=reader.output_buffer_size();if count>limit {return Err("image_dimensions_invalid");}
    let mut pixels=Vec::new();pixels.try_reserve_exact(count).map_err(|_|"image_decode_unavailable")?;pixels.resize(count,0);
    reader.next_frame(&mut pixels).map_err(|_|"image_invalid")?;
    reader.finish().map_err(|_|"image_invalid")
}
fn jpeg_huffman(data:&[u8])->Result<(),&'static str> {
    let mut position=0;
    while position<data.len() {
        let table=data.get(position..position+17).ok_or("image_invalid")?;
        if table[0]>>4>1 || table[0]&15>3 {return Err("image_invalid");}
        let mut left=1i32;
        for &count in &table[1..] {left=left*2-i32::from(count);if left<0 {return Err("image_invalid");}}
        let symbols=table[1..].iter().map(|&value|usize::from(value)).sum::<usize>();
        if symbols==0 || symbols>256 || left==0 {return Err("image_invalid");}
        position=position.checked_add(17+symbols).filter(|&end|end<=data.len()).ok_or("image_invalid")?;
    }
    if position==0 {Err("image_invalid")} else {Ok(())}
}
fn jpeg_header(bytes:&[u8])->Result<(u32,u32),&'static str> {
    let mut cursor=2usize; let mut size=None; let mut scanned=false;
    while cursor<bytes.len() {
        if bytes[cursor]!=0xff {return Err("image_invalid");}
        while bytes.get(cursor)==Some(&0xff) {cursor+=1;}
        let marker=*bytes.get(cursor).ok_or("image_invalid")?;cursor+=1;
        if marker==0xd9 {return if scanned && cursor==bytes.len() {size.ok_or("image_invalid")} else {Err("image_invalid")};}
        if marker==0 || marker==0xd8 || (0xd0..=0xd7).contains(&marker) {return Err("image_invalid");}
        if marker==1 {continue;}
        let length=u16::from_be_bytes(bytes.get(cursor..cursor+2).ok_or("image_invalid")?.try_into().unwrap()) as usize;
        if length<2 {return Err("image_invalid");}
        let end=cursor.checked_add(length).ok_or("image_invalid")?;
        let data=bytes.get(cursor+2..end).ok_or("image_invalid")?;
        if (0xc0..=0xcf).contains(&marker) && !matches!(marker,0xc4|0xc8|0xcc) {
            if size.is_some() || data.len()<6 || !matches!(data[0],8|12) || !(1..=4).contains(&data[5])
                || length!=8+3*usize::from(data[5]) {return Err("image_invalid");}
            let height=u16::from_be_bytes(data[1..3].try_into().unwrap()) as u32; let width=u16::from_be_bytes(data[3..5].try_into().unwrap()) as u32;
            dimensions(width,height)?;size=Some((width,height));
        }
        if marker==0xc4 {jpeg_huffman(data)?;}
        cursor=end;
        if marker==0xda {
            if size.is_none() || data.is_empty() || data[0]==0 || length!=6+2*usize::from(data[0]) {return Err("image_invalid");}
            scanned=true;
            while cursor<bytes.len() {
                if bytes[cursor]!=0xff {cursor+=1;continue;}
                let next=*bytes.get(cursor+1).ok_or("image_invalid")?;
                if next==0 || (0xd0..=0xd7).contains(&next) {cursor+=2;} else if next==0xff {cursor+=1;} else {break;}
            }
        }
    }
    Err("image_invalid")
}
fn header(bytes:&[u8])->Result<(Format,u32,u32),&'static str> {
    if bytes.len()>MAX_IMAGE_BYTES {return Err("image_too_large");}
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {let (w,h)=png_header(bytes)?;Ok((Format::Png,w,h))}
    else if bytes.starts_with(&[0xff,0xd8,0xff]) {let (w,h)=jpeg_header(bytes)?;Ok((Format::Jpeg,w,h))}
    else {Err("image_format_unsupported")}
}
pub(crate) fn prepare_image(bytes:&[u8])->Result<ValidatedImage,&'static str> {
    let (format,width,height)=header(bytes)?;
    if format==Format::Png {strict_png(bytes,width,height)?;}
    wic_decode(bytes,format,width,height)?;
    Ok(ValidatedImage {metadata:ImageMetadata {mime_type:if format==Format::Png {"image/png"} else {"image/jpeg"},width,height,size_bytes:bytes.len(),
        sha256:Sha256::digest(bytes).iter().map(|byte|format!("{byte:02x}")).collect()},data_base64:STANDARD.encode(bytes)})
}
#[cfg(not(windows))]
fn wic_decode(_: &[u8],_:Format,_:u32,_:u32)->Result<(),&'static str> {Err("image_decode_unavailable")}
#[cfg(windows)]
fn wic_decode(bytes:&[u8],format:Format,width:u32,height:u32)->Result<(),&'static str> {
    use windows::{core::Interface,Win32::{Foundation::RPC_E_CHANGED_MODE,Graphics::Imaging::*,System::Com::*}};
    struct Apartment(bool);
    impl Drop for Apartment {fn drop(&mut self){if self.0 {unsafe {CoUninitialize();}}}}
    // All interfaces and borrowed-memory stream drop before the apartment guard/input slice.
    let initialized=unsafe {CoInitializeEx(None,COINIT_MULTITHREADED)};
    let _apartment=if initialized==RPC_E_CHANGED_MODE {Apartment(false)} else {initialized.ok().map_err(|_|"image_decode_unavailable")?;Apartment(true)};
    let factory:IWICImagingFactory=unsafe {CoCreateInstance(&CLSID_WICImagingFactory,None::<&windows::core::IUnknown>,CLSCTX_INPROC_SERVER)}.map_err(|_|"image_decode_unavailable")?;
    let stream=unsafe {factory.CreateStream()}.map_err(|_|"image_decode_unavailable")?;
    unsafe {stream.InitializeFromMemory(bytes)}.map_err(|_|"image_invalid")?;
    let input:IStream=stream.cast().map_err(|_|"image_decode_unavailable")?;
    let decoder=unsafe {factory.CreateDecoderFromStream(&input,std::ptr::null(),WICDecodeMetadataCacheOnLoad)}.map_err(|_|"image_invalid")?;
    let expected=if format==Format::Png {GUID_ContainerFormatPng} else {GUID_ContainerFormatJpeg};
    if unsafe {decoder.GetContainerFormat()}.map_err(|_|"image_invalid")?!=expected
        || unsafe {decoder.GetFrameCount()}.map_err(|_|"image_invalid")?!=1 {return Err("image_format_unsupported");}
    let frame=unsafe {decoder.GetFrame(0)}.map_err(|_|"image_invalid")?;
    let (mut decoded_width,mut decoded_height)=(0,0);
    unsafe {frame.GetSize(&mut decoded_width,&mut decoded_height)}.map_err(|_|"image_invalid")?;
    let count=dimensions(decoded_width,decoded_height)?;
    if (decoded_width,decoded_height)!=(width,height) {return Err("image_invalid");}
    let source:IWICBitmapSource=frame.cast().map_err(|_|"image_invalid")?;
    let converter=unsafe {factory.CreateFormatConverter()}.map_err(|_|"image_decode_unavailable")?;
    unsafe {converter.Initialize(&source,&GUID_WICPixelFormat32bppRGBA,WICBitmapDitherTypeNone,None::<&IWICPalette>,0.0,WICBitmapPaletteTypeCustom)}.map_err(|_|"image_invalid")?;
    let mut pixels=Vec::new();pixels.try_reserve_exact(count).map_err(|_|"image_decode_unavailable")?;pixels.resize(count,0);
    unsafe {converter.CopyPixels(std::ptr::null(),width.checked_mul(4).ok_or("image_dimensions_invalid")?,&mut pixels)}.map_err(|_|"image_invalid")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const PNG:&str="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const JPEG:&str="/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z";
    fn png()->Vec<u8> {STANDARD.decode(PNG).unwrap()}
    fn jpeg()->Vec<u8> {STANDARD.decode(JPEG).unwrap()}
    fn chunk(kind:&[u8;4],data:&[u8])->Vec<u8> {
        let mut chunk=(data.len() as u32).to_be_bytes().to_vec();chunk.extend(kind);chunk.extend(data);
        chunk.extend(crc32(&chunk[4..]).to_be_bytes());chunk
    }
    #[test]
    fn size_dimensions_and_pixel_arithmetic_are_bounded_before_decode() {
        assert_eq!(dimensions(4096,4096).unwrap(),64*1024*1024);
        for (w,h) in [(0,1),(1,0),(4097,1),(1,4097),(u32::MAX,u32::MAX)] {assert_eq!(dimensions(w,h).unwrap_err(),"image_dimensions_invalid");}
        assert_eq!(header(&vec![0;MAX_IMAGE_BYTES+1]).unwrap_err(),"image_too_large");
        assert_eq!(header(b"<svg>not a raster</svg>").unwrap_err(),"image_format_unsupported");
        assert_eq!(crc32(b"123456789"),0xcbf43926);
    }
    #[test]
    fn png_checks_chunk_crc_animation_truncation_and_trailing_bytes() {
        let original=png();assert_eq!(header(&original).unwrap(),(Format::Png,1,1));
        let mut corrupt=original.clone();corrupt[20]^=1;assert!(header(&corrupt).is_err());
        assert!(header(&original[..original.len()-1]).is_err());
        let mut trailing=original.clone();trailing.push(0);assert!(header(&trailing).is_err());
        let mut animated=original[..33].to_vec();animated.extend(chunk(b"acTL",&[0,0,0,1,0,0,0,0]));animated.extend(&original[33..]);
        assert_eq!(header(&animated).unwrap_err(),"image_format_unsupported");
        let mut huge=original;huge[8..12].copy_from_slice(&u32::MAX.to_be_bytes());assert!(header(&huge).is_err());
    }
    #[test]
    fn strict_png_rejects_bad_cmf_deflate_adler_and_truncated_stream_with_recomputed_chunk_crc() {
        let original=png();let tag=original.windows(4).position(|value|value==b"IDAT").unwrap();
        let length=u32::from_be_bytes(original[tag-4..tag].try_into().unwrap()) as usize;
        for case in 0..4 {
            let mut data=original[tag+4..tag+4+length].to_vec();
            match case {0=>data[0]=0,1=>data[2]=7,2=>{let last=data.len()-1;data[last]^=1;},_=>{data.pop();}}
            let mut corrupt=original[..tag-4].to_vec();corrupt.extend(chunk(b"IDAT",&data));corrupt.extend(&original[tag+8+length..]);
            if case!=0 {assert!(header(&corrupt).is_ok());assert_eq!(strict_png(&corrupt,1,1).err(),Some("image_invalid"));}
            assert_eq!(prepare_image(&corrupt).err(),Some("image_invalid"));
        }
    }
    #[test]
    fn jpeg_checks_segments_single_image_eoi_and_declared_dimensions() {
        let original=jpeg();assert_eq!(header(&original).unwrap(),(Format::Jpeg,1,1));
        assert!(header(&original[..original.len()-1]).is_err());
        let mut trailing=original.clone();trailing.extend(jpeg());assert!(header(&trailing).is_err());
        let mut broken=original.clone();broken[4..6].copy_from_slice(&u16::MAX.to_be_bytes());assert!(header(&broken).is_err());
        let start=original.windows(2).position(|part|part==[0xff,0xc0]).unwrap();
        let mut large=original;large[start+7..start+9].copy_from_slice(&4097u16.to_be_bytes());
        assert_eq!(header(&large).unwrap_err(),"image_dimensions_invalid");
        let mut bad_precision=jpeg();bad_precision[start+4]=0;assert_eq!(header(&bad_precision).unwrap_err(),"image_invalid");
        let mut bad_table=jpeg();let dht=bad_table.windows(2).position(|part|part==[0xff,0xc4]).unwrap();
        bad_table[dht+5]=3;bad_table[dht+6]=0;bad_table[dht+7]=3;
        assert_eq!(header(&bad_table).unwrap_err(),"image_invalid");
    }
    #[cfg(windows)]
    #[test]
    fn wic_fully_decodes_both_tiny_formats_and_keeps_data_out_of_metadata() {
        for (bytes,mime) in [(png(),"image/png"),(jpeg(),"image/jpeg")] {
            let before=STRICT_PNG_CALLS.with(|calls|calls.get());
            let prepared=prepare_image(&bytes).ok().expect("synthetic image should decode");let meta=prepared.metadata();
            assert_eq!(STRICT_PNG_CALLS.with(|calls|calls.get())-before,usize::from(mime=="image/png"));
            assert_eq!((meta.width,meta.height),(1,1));assert_eq!(meta.mime_type,mime);assert_eq!(meta.size_bytes,bytes.len());
            assert_eq!(meta.sha256.len(),64);assert_eq!(STANDARD.decode(prepared.data_base64()).unwrap(),bytes);
            let json=serde_json::to_value(meta).unwrap();assert_eq!(json.as_object().unwrap().len(),5);assert!(json.get("dataBase64").is_none());
        }
    }
    #[cfg(windows)]
    #[test]
    fn full_prepare_rejects_corrupt_deflate_and_huffman_without_relying_on_wic_rejection() {
        let mut bad_png=png();let tag=bad_png.windows(4).position(|value|value==b"IDAT").unwrap();
        let length=u32::from_be_bytes(bad_png[tag-4..tag].try_into().unwrap()) as usize;
        // Valid CMF/FLG and chunk CRC, but reserved DEFLATE block type in the compressed body.
        bad_png[tag+6]=7;let checksum=crc32(&bad_png[tag..tag+4+length]);bad_png[tag+4+length..tag+8+length].copy_from_slice(&checksum.to_be_bytes());
        assert!(header(&bad_png).is_ok());
        let before=STRICT_PNG_CALLS.with(|calls|calls.get());
        assert_eq!(prepare_image(&bad_png).err(),Some("image_invalid"));
        assert_eq!(STRICT_PNG_CALLS.with(|calls|calls.get())-before,1);
        // Segment byte lengths and image dimensions stay unchanged; the Huffman tree is over-subscribed.
        let mut bad_jpeg=jpeg();let dht=bad_jpeg.windows(2).position(|value|value==[0xff,0xc4]).unwrap();
        bad_jpeg[dht+5]=3;bad_jpeg[dht+6]=0;bad_jpeg[dht+7]=3;
        assert_eq!(jpeg_header(&bad_jpeg).err(),Some("image_invalid"));
        assert_eq!(prepare_image(&bad_jpeg).err(),Some("image_invalid"));
    }
    #[cfg(not(windows))]
    #[test]
    fn unavailable_decoder_never_claims_header_only_success() {assert_eq!(prepare_image(&png()).err().unwrap(),"image_decode_unavailable");}
}
