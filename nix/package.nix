{
  buildFHSEnv,
  fd,
  fetchurl,
  lib,
  makeWrapper,
  ripgrep,
  source ? null,
  stdenv,
  unzip,
  wl-clipboard,
  xclip,
}:

let
  version = "1.5.0-xz.408.1.ga6f23f6f";
  tag = "xz-v1.5.0-xz.408.1.ga6f23f6f";

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
    "darwin-arm64" = "sha256-qbt3NkODsg3xSqF/BPxjGFCbTO0H3/Z2KO8+3q4ze98=";
    "darwin-x64-baseline" = "sha256-KLjgkZV0/ycGTrCpfo9Sx8yd8IF/TJAhKiYch4mpGYU=";
    "linux-arm64-gnu" = "sha256-WpQ65aLiSmlR3CuLkZEaVl6Bx7rU1yf1nRcITe6IHJ4=";
    "linux-x64-gnu-baseline" = "sha256-dmQCvXCv/0hq7Qk5oulRw/1ybrlbefxoOufOnD2fR5U=";
    "linux-arm64-musl" = "sha256-TCpbcTf0OF4ExGlgfswMpvuQh9n6cgEnmVqiIGCH2AQ=";
    "linux-x64-musl-baseline" = "sha256-Wj8TS3SpkYkktiHiQnKLIXyw83C7sPuMJvnnNCpVl0U=";
    "freebsd-arm64" = "sha256-AI+/xQDhF/QA9PvSB4hqKyWHSAOwAxy90QyYEIXRPJ8=";
    "freebsd-x64" = "sha256-P0nn5z2HwCpdeXI+RO8Zv9LypMoOohCD0Kr/vON71w4=";
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
