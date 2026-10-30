{
  autoPatchelfHook,
  fd,
  fetchurl,
  lib,
  libxcb,
  makeWrapper,
  ripgrep,
  source ? null,
  stdenv,
  tag ? "xz-v${version}",
  unzip,
  version ? "1.4.0-xz.390.1.g29730c7e",
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
    "darwin-arm64" = "sha256-BtzfZtIiyuX+V3NuZxW3gw2xg+k7c5krj0Pj02vDNE0=";
    "darwin-x64-baseline" = "sha256-BdqsF/Zja0zB4BGln/K7m/9yxVelttwvQ2B09ryEf5w=";
    "linux-arm64-gnu" = "sha256-d4OFeA4bXKYhJOcqalz7OPHa00ymp+oKmtsZtonL5Xg=";
    "linux-x64-gnu-baseline" = "sha256-lb+AcsJL1MHhucNolgqaWM4orfU+h6+U6eBFWBZcm9Q=";
    "linux-arm64-musl" = "sha256-px3xeP1a4amtA3sVRFrSbbAg/hLtJiChOfyTSgnOKBc=";
    "linux-x64-musl-baseline" = "sha256-tKzo4oQ0iv9//SFCSrWIK4pqpbW/JndFwyRjc3Rq2s4=";
    "freebsd-arm64" = "sha256-WZxsaCu5zyPacj9MvMs+9z4rPTNG0/eSo1bpgl8yKho=";
    "freebsd-x64" = "sha256-N17EjHTWr1HWLVmX+i/560FS2z22POLsPRmzcXyCtjY=";
  };

  url =
    if tag == "latest" then
      "https://github.com/xz-dev/pi/releases/latest/download/pi-${target}.zip"
    else
      "https://github.com/xz-dev/pi/releases/download/${tag}/pi-${target}.zip";
in
stdenv.mkDerivation {
  pname = "pi";
  inherit version;

  src = fetchurl {
    inherit url;
    hash = hashes.${target} or (throw "Missing pre-built binary hash for target: ${target}");
  };

  nativeBuildInputs = [
    unzip
    makeWrapper
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    stdenv.cc.cc.lib
    libxcb
  ];

  dontUnpack = false;
  sourceRoot = ".";
  dontBuild = true;
  dontStrip = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/libexec" "$out/bin"
    install -Dm755 pi "$out/libexec/pi"

    makeWrapper "$out/libexec/pi" "$out/bin/pi" \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            fd
            ripgrep
          ]
          ++ lib.optionals stdenv.hostPlatform.isLinux [
            wl-clipboard
            xclip
          ]
        )
      }

    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    ${if tag != "latest" then ''test "$("$out/bin/pi" --version)" = "${version}"'' else ''"$out/bin/pi" --version''}
    "$out/bin/pi" --help > /dev/null
    runHook postInstallCheck
  '';

  meta = {
    description = packageJson.description;
    homepage = "https://github.com/xz-dev/pi";
    license = lib.licenses.mit;
    mainProgram = "pi";
    platforms = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-darwin"
      "x86_64-linux"
      "aarch64-freebsd"
      "x86_64-freebsd"
    ];
    sourceProvenance = with lib.sourceTypes; [
      binaryNativeCode
    ];
  };
}
