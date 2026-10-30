//! Favicon bytes handed over by WebView2 (never fetched by us) as bounded PNG data URLs.
use base64::{engine::general_purpose::STANDARD, Engine};

pub const MAX_ICON_BYTES: usize = 32 * 1024;
pub const DATA_URL_PREFIX: &str = "data:image/png;base64,";
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// Longest valid data URL: the prefix plus base64 of MAX_ICON_BYTES.
const MAX_URL_BYTES: usize = DATA_URL_PREFIX.len() + MAX_ICON_BYTES.div_ceil(3) * 4;

/// PNG bytes (signature checked, at most MAX_ICON_BYTES) as a data URL; anything else is None.
pub fn png_data_url(bytes: &[u8]) -> Option<String> {
    (bytes.len() > PNG_SIGNATURE.len() && bytes.len() <= MAX_ICON_BYTES && bytes.starts_with(&PNG_SIGNATURE))
        .then(|| format!("{DATA_URL_PREFIX}{}", STANDARD.encode(bytes)))
}

/// A stored or UI-supplied icon string is acceptable only if it round-trips to a bounded PNG.
pub fn is_valid_data_url(value: &str) -> bool {
    value.len() <= MAX_URL_BYTES
        && value.strip_prefix(DATA_URL_PREFIX).and_then(|body| STANDARD.decode(body).ok())
            .is_some_and(|bytes| png_data_url(&bytes).is_some_and(|canonical| canonical == value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(len: usize) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.resize(len, 7);
        bytes
    }

    #[test]
    fn builds_data_url_only_for_bounded_png() {
        let url = png_data_url(&png(64)).unwrap();
        assert!(url.starts_with(DATA_URL_PREFIX) && is_valid_data_url(&url));
        assert!(png_data_url(&png(MAX_ICON_BYTES)).is_some());
        assert!(png_data_url(&png(MAX_ICON_BYTES + 1)).is_none());
        assert!(png_data_url(&PNG_SIGNATURE).is_none());
        assert!(png_data_url(b"").is_none());
        assert!(png_data_url(b"GIF89a-not-a-png-at-all").is_none());
        assert!(png_data_url(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_none());
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe0];
        jpeg.resize(100, 0);
        assert!(png_data_url(&jpeg).is_none());
    }

    #[test]
    fn rejects_foreign_oversize_or_malformed_strings() {
        let good = png_data_url(&png(32)).unwrap();
        assert!(is_valid_data_url(&good));
        assert!(!is_valid_data_url(""));
        assert!(!is_valid_data_url(&good.replace("image/png", "image/svg+xml")));
        assert!(!is_valid_data_url("https://example.org/favicon.png"));
        assert!(!is_valid_data_url(&format!("{DATA_URL_PREFIX}!!!")));
        assert!(!is_valid_data_url(&format!("{DATA_URL_PREFIX}{}", STANDARD.encode(b"not a png at all"))));
        assert!(!is_valid_data_url(&format!("{DATA_URL_PREFIX}{}", STANDARD.encode(png(MAX_ICON_BYTES + 1)))));
        assert!(!is_valid_data_url(&format!("{good}\"><script>")));
        assert!(is_valid_data_url(&png_data_url(&png(MAX_ICON_BYTES)).unwrap()));
    }
}
