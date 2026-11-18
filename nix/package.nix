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
  version = "1.5.2-xz.430.1.gb130f19d";
  tag = "xz-v1.5.2-xz.430.1.gb130f19d";

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
    "darwin-arm64" = "sha256-yKbj9XB1MCRHgdjBUgNtF5PmwJ5USPQLhRTBeYbQukw=";
    "darwin-x64-baseline" = "sha256-Y0NX5OrFd8dm0WihnH3cY4DEHTLq6vBzhq4zXal6CXo=";
    "linux-arm64-gnu" = "sha256-L4TFp99bAZk1L76B2e+BTah6NKJLLigOrmGdxD+EYV0=";
    "linux-x64-gnu-baseline" = "sha256-XICGwZ/DSFely2vHAwNN/DCe6AJNVpjz9QKpMqVlcK4=";
    "linux-arm64-musl" = "sha256-aFVsrLHblKAqFSaB6NubmgN1R5o0pVJINNucvHaZnpg=";
    "linux-x64-musl-baseline" = "sha256-gFMwkH7XB8TZvJ0eCOzUxztk590kbyC6C1tsyq0ojSY=";
    "freebsd-arm64" = "sha256-gad1ZVmqIM5uJHWiVZIXAO/bV+PW5ffcsJCFlrK6jyo=";
    "freebsd-x64" = "sha256-UsDHVNlgJPTsJI49kBCklvMpHLOENxE6FLN8F41QKcs=";
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
