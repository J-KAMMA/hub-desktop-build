fn main() {
    for source in ["../scripts/build-content-share.mjs", "../../hub/lib/content-share.ts", "../../hub/lib/social-post-limits.ts", "../../hub/lib/research-workspace.ts"] { println!("cargo:rerun-if-changed={source}"); }
    assert!(std::process::Command::new("node").arg("../scripts/build-content-share.mjs").status().expect("bundle public share reference").success(), "public share reference bundle failed");
    for source in ["../scripts/build-thread-reader.mjs", "../ui/thread-reader.src.mjs", "../../hub/lib/thread-search.ts", "../../hub/lib/thread-tree.ts", "../../hub/lib/spotlight-posts.ts", "../../hub/lib/thread-knowledge.ts"] {
        println!("cargo:rerun-if-changed={source}");
    }
    let bundle = std::process::Command::new("node")
        .arg("../scripts/build-thread-reader.mjs")
        .status().expect("bundle the shared Web thread reader");
    assert!(bundle.success(), "shared Web thread reader bundle failed");
    let peer_source="../../hub/lib/hub-peer-catalog.mjs";
    println!("cargo:rerun-if-changed={peer_source}");
    let bytes=std::fs::read(peer_source).expect("shared public post transport");
    let target="../ui/hub-peer-catalog.mjs";
    if std::fs::read(target).ok().as_deref()!=Some(bytes.as_slice()) {
        std::fs::write(target,bytes).expect("bundle public post transport");
    }
    for source in ["../scripts/build-research-git-import.mjs", "../../hub/lib/research-git-import.ts", "../../hub/lib/research-git-application.ts", "../../hub/lib/research-git-browse.ts", "../../hub/lib/research-git-proposals.ts"] {
        println!("cargo:rerun-if-changed={source}");
    }
    let import_contract = std::process::Command::new("node")
        .arg("../scripts/build-research-git-import.mjs")
        .status().expect("bundle the shared Git import contract");
    assert!(import_contract.success(), "shared Git import contract bundle failed");
    for source in ["../scripts/build-external-media-contract.mjs", "../../hub/lib/video-source.ts", "../../hub/lib/video-context.ts", "../../hub/lib/music-source.ts"] {
        println!("cargo:rerun-if-changed={source}");
    }
    let media_contract = std::process::Command::new("node")
        .arg("../scripts/build-external-media-contract.mjs")
        .status().expect("bundle the shared external media contract");
    assert!(media_contract.success(), "shared external media contract bundle failed");
    for source in ["../vendor/browser-reader/build-reader-extract.mjs", "../vendor/browser-reader/reader-extract.src.mjs"] {
        println!("cargo:rerun-if-changed={source}");
    }
    let reader = std::process::Command::new("node")
        .arg("../vendor/browser-reader/build-reader-extract.mjs")
        .status().expect("bundle the fixed Reader extractor");
    assert!(reader.success(), "fixed Reader extractor bundle failed");
    for source in ["../scripts/build-research-public-package.mjs", "../../hub/lib/research-fork-package.ts", "../../hub/lib/hub-network-client.ts"] {
        println!("cargo:rerun-if-changed={source}");
    }
    let public_package = std::process::Command::new("node")
        .arg("../scripts/build-research-public-package.mjs")
        .status().expect("bundle the shared public research package contract");
    assert!(public_package.success(), "shared public research package contract bundle failed");
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Tests link native handlers too; TaskDialogIndirect needs v6 controls.
        // rustc-link-arg-tests does not cover the --lib unittest target, so the
        // universal form is required. Without /MANIFEST:EMBED the generated
        // manifest lands as <exe>.manifest beside the binary: test binaries
        // (which have no embedded manifest) pick it up, while bins keep the
        // manifest tauri-build embeds via resource.lib and ignore the file.
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
}
