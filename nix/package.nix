{
  buildFHSEnv,
  fd,
  fetchurl,
  lib,
  makeWrapper,
  ripgrep,
  source ? null,
  stdenv,
  tag ? "xz-v${version}",
  unzip,
  version ? "1.4.0-xz.398.1.g53b911ac",
  wl-clipboard,
  xclip,
}:

let
  packageJson =
    if source != null && builtins.pathExists (source + "/packages/coding-agent/package.json") then
      lib.importJSON (source + "/packages/coding-agent/package.json")
    else
      {
        description = "Pi coding agent";
      };

  targetMap = {
    "aarch64-darwin" = "darwin-arm64";
    "x86_64-darwin" = "darwin-x64-baseline";
    "aarch64-linux" = if stdenv.hostPlatform.isMusl then "linux-arm64-musl" else "linux-arm64-gnu";
    "x86_64-linux" = if stdenv.hostPlatform.isMusl then "linux-x64-musl-baseline" else "linux-x64-gnu-baseline";
    "aarch64-freebsd" = "freebsd-arm64";
    "x86_64-freebsd" = "freebsd-x64";
  };

  system = stdenv.hostPlatform.system;
  target = targetMap.${system} or (throw "Unsupported platform for pi: ${system}");

  # Pre-built release archive checksums for each platform from xz-dev/pi
  hashes = {
    "darwin-arm64" = "sha256-DKFpTwS0S3Bt+jwF0AWBKGOgP469uzXBttKsGcf6ZC8=";
    "darwin-x64-baseline" = "sha256-zBKvg+loyuwNvQVlOJlKxoiILz3XkZsO4As+DgA90hs=";
    "linux-arm64-gnu" = "sha256-/HS2cm3Sv6PuGTM0HO79sC0eL7PtpA8vwZgzpg9pp9Y=";
    "linux-x64-gnu-baseline" = "sha256-tp+A5VcRRusBMdfRrB0TcMp/v2D4Q89/cpTXxSnVk0M=";
    "linux-arm64-musl" = "sha256-5cyTQZCsr8vn0OEUY9vsx+4EjJmVe3Ge9Acm5eGwcQg=";
    "linux-x64-musl-baseline" = "sha256-bAhBn4nELl0pgkr2eInjW1cnTpv/u+JEzW22KFHzPo8=";
    "freebsd-arm64" = "sha256-OwOUWdLYxJsUeafIqm6YWrPgq4P2hsKvYkr9+ijOZKw=";
    "freebsd-x64" = "sha256-rcHkiq+LadZ3oPVLC1o3I3EqrRJxTkkoDGrxZrNK3b8=";
  };

  tools = [ fd ripgrep ] ++ lib.optionals stdenv.hostPlatform.isLinux [ wl-clipboard xclip ];
  meta = {
    description = packageJson.description;
    homepage = "https://github.com/xz-dev/pi";
    license = lib.licenses.mit;
    mainProgram = "pi";
    platforms = builtins.attrNames targetMap;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };

  # pi writes startup state under HOME; builders set HOME=/homeless-shelter, read-only on Darwin.
  installCheckPhase = ''
    HOME="$(mktemp -d)"
    export HOME
    runHook preInstallCheck
    test "$("$out/bin/pi" --version)" = "${version}"
    PI_OFFLINE=1 "$out/bin/pi" --help > /dev/null
    runHook postInstallCheck
  '';

  raw = stdenv.mkDerivation {
    pname = "pi-unwrapped";
    inherit version meta;
    src = fetchurl {
      url = "https://github.com/xz-dev/pi/releases/download/${tag}/pi-${target}.zip";
      hash = hashes.${target} or (throw "Missing pre-built binary hash for target: ${target}");
    };
    nativeBuildInputs = [ unzip makeWrapper ];
    sourceRoot = ".";
    dontBuild = true;
    dontStrip = true;
    dontPatchELF = true;
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/libexec" "$out/bin"
      install -m755 pi "$out/libexec/pi"
      touch "$out/libexec/.nix.managed.lock"
      makeWrapper "$out/libexec/pi" "$out/bin/pi" \
        --prefix PATH : ${lib.makeBinPath tools}
      runHook postInstall
    '';
    doInstallCheck = !stdenv.hostPlatform.isLinux;
    inherit installCheckPhase;
  };
in
if stdenv.hostPlatform.isLinux then
  # The embedded owner helper needs an FHS loader too; patching only pi is insufficient.
  buildFHSEnv {
    pname = "pi";
    inherit version meta;
    targetPkgs = pkgs: [ pkgs.glibc pkgs.stdenv.cc.cc.lib pkgs.libxcb ] ++ tools;
    runScript = "${raw}/bin/pi";
    extraInstallCommands = installCheckPhase;
    passthru.unwrapped = raw;
  }
else
  raw
