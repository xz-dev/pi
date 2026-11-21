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
  version = "1.6.0-xz.436.1.g7bf46d8d";
  tag = "xz-v1.6.0-xz.436.1.g7bf46d8d";

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
    "darwin-arm64" = "sha256-KSfyGfClGsolX1PC/X8rFXiD35bx6Q01jRIoxZUSHzY=";
    "darwin-x64-baseline" = "sha256-lB4Xese8AcqDyDwy2vzWv0VA5daXBi4wRp/t+0OYS90=";
    "linux-arm64-gnu" = "sha256-WzsH29q5pt0YuXAiCYFoPBCIrEv/4/Y3/5rIOzwYy9s=";
    "linux-x64-gnu-baseline" = "sha256-vmjiNy+dshVXQORjbuUI9iR1xFtgzpQs8yMPYJw35V4=";
    "linux-arm64-musl" = "sha256-FyfmXJBZvLZMNPoSqWY9wFs0tDrk2ncQhyLsHxCWAj0=";
    "linux-x64-musl-baseline" = "sha256-WjoOxSDoeOTw15gOpEwszFVSU//uF15KRfiVFeeunY0=";
    "freebsd-arm64" = "sha256-iyvT7pbrlmqQjYA+M9w1M6LSbtl3FCbBKFc7MfY70ts=";
    "freebsd-x64" = "sha256-h6Ai2gCUfWfcdyf6UtywQwTfCxeUNh7Gnq0g5az9vIs=";
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
