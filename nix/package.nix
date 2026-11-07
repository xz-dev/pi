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
  version = "1.5.0-xz.412.1.g34869f65";
  tag = "xz-v1.5.0-xz.412.1.g34869f65";

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
    "darwin-arm64" = "sha256-Y4PTyiYOPkOFWAVXAEiJzEsrDTN6Zq+yXv0Yzcs51Ww=";
    "darwin-x64-baseline" = "sha256-tPD8uSS4shBl/xCamWphrb8YZESc+XlkzXq2aNjPUMk=";
    "linux-arm64-gnu" = "sha256-Z7uUtpT4x5O1mpTg3kHclN3Lm3pclnzqPcHke8lIjV0=";
    "linux-x64-gnu-baseline" = "sha256-JSBQQlROZS80gQeIzw8zh68CrwfDBrvNUqcthKBkKt0=";
    "linux-arm64-musl" = "sha256-c2wWGrt6q4znS3mG1Ot7sZnqVkEdntLwnOlHaE05rO0=";
    "linux-x64-musl-baseline" = "sha256-mJmQ6Zd/2/h2Nwm6U9Z5akZwI++F/7tlOX1khD90RzA=";
    "freebsd-arm64" = "sha256-W5vjTl7jggvF32C+lEtz4Nz3/5f23lfjWYS1LGZ+U3c=";
    "freebsd-x64" = "sha256-Gd8Gxtpy1XW3hNPznLO/FjZgaWBtYpQPYLQTOrT1ojk=";
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
