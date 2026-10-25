//! Exposes the npm release version and builds the Darwin SDK metadata normalization.

use std::env;
use std::path::PathBuf;
use std::process::Command;

fn run(command: &mut Command) {
    assert!(
        command.status().expect("run Darwin SDK tool").success(),
        "Darwin SDK tool failed"
    );
}

fn main() {
    println!("cargo:rerun-if-changed=../package.json");
    let package = std::fs::read_to_string("../package.json").expect("read ../package.json");
    let version = package
        .split("\"version\"")
        .nth(1)
        .and_then(|rest| rest.split('"').nth(1))
        .expect("version in ../package.json");
    println!("cargo:rustc-env=PI_ENV_VERSION={version}");
    println!("cargo:rerun-if-changed=src/darwin_record.c");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    println!("cargo:rerun-if-env-changed=SDKROOT");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let target = env::var("TARGET").expect("Cargo target");
    let architecture = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => "x86_64",
        Ok("aarch64") => "arm64",
        _ => panic!("unsupported Darwin architecture"),
    };
    // Ask the actual pinned compiler, including the caller's deployment override.
    let deployment = Command::new(env::var_os("RUSTC").expect("Cargo rustc"))
        .args(["--print", "deployment-target", "--target", &target])
        .output()
        .expect("read Rust deployment target");
    assert!(deployment.status.success(), "Rust deployment query failed");
    let deployment = String::from_utf8(deployment.stdout).expect("Rust deployment UTF-8");
    let minimum = deployment
        .trim()
        .strip_prefix("MACOSX_DEPLOYMENT_TARGET=")
        .expect("Rust macOS deployment target");
    assert!(
        !minimum.is_empty()
            && minimum
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'.')
    );
    let directory = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    let object = directory.join("darwin_record.o");
    let archive = directory.join("libpi_env_darwin_record.a");
    run(Command::new("cc")
        .args([
            "-std=c11",
            "-D_DARWIN_C_SOURCE",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-arch",
            architecture,
            &format!("-mmacosx-version-min={minimum}"),
            "-c",
            "src/darwin_record.c",
            "-o",
        ])
        .arg(&object));
    run(Command::new("ar").arg("crs").arg(&archive).arg(&object));
    println!("cargo:rustc-link-search=native={}", directory.display());
    println!("cargo:rustc-link-lib=static=pi_env_darwin_record");
}
