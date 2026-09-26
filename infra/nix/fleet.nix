# Fleet assembly: everything a machine in the cluster consumes, expressed as
# Nix derivations over the vendored numtide/llm-agents.nix flake.
#
# The outputs here are the ones infra-requirements.dsh.md §2.2 measures:
# `runtime` is the deployable tree, `devShell` is the only supported build
# environment, and `configGeneration` is the version fingerprint (§11 item 12)
# recorded with every execution.
{
  pkgs,
  lib,
  llm-agents,
  system,
  inputs,
  repoRoot,
  fleetFlake,
}:

let
  vendor = lib.importJSON (repoRoot + "/infra/nix/vendor.json");
  upstream = llm-agents.packages.${system};

  # Harnesses the topology in §3 places in panes. `dsh` is the control plane
  # and worker runtime; the rest are the heterogeneous L1/L3 harnesses.
  harnessNames = [
    "dsh"
    "codex"
    "claude-code"
    "kimi-code"
    "gemini-cli"
  ];

  harnesses = lib.filterAttrs (name: _: upstream ? ${name}) (
    lib.genAttrs harnessNames (name: upstream.${name})
  );

  version = "0.1.7-rc.2";

  # One shell script per fleet entry point. writeShellApplication pins every
  # tool the script may call to a store path, so a script cannot depend on a
  # tool that happens to exist on the machine (R-8).
  mkScript =
    name:
    {
      text,
      runtimeInputs ? [ ],
    }:
    pkgs.writeShellApplication {
      inherit name runtimeInputs text;
    };

  machineId = mkScript "dsh-fleet-machine-id" {
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.gnused
      pkgs.hostname
    ];
    text = builtins.readFile (repoRoot + "/infra/scripts/machine-id.sh");
  };

  worker = mkScript "dsh-fleet-worker" {
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.gnused
      pkgs.tmux
    ];
    text = builtins.readFile (repoRoot + "/infra/scripts/worker.sh");
  };

  pushQueue = mkScript "dsh-fleet-push" {
    runtimeInputs = [
      pkgs.coreutils
      pkgs.git
      pkgs.gnugrep
    ];
    text = builtins.readFile (repoRoot + "/infra/scripts/push-queue.sh");
  };

  # ConfigGeneration (§11 item 12): the exact inputs a run executed under, so a
  # result can be explained after the fact and a rebuild can be attempted.
  configGeneration = {
    inherit version;
    system = pkgs.stdenv.hostPlatform.system;
    nixSystem = pkgs.stdenv.hostPlatform.system;
    flakeUri = "path:${builtins.toString fleetFlake.outPath}";
    flakeLockHash = builtins.hashFile "sha256" (repoRoot + "/flake.lock");
    llmAgentsFlakeUri = vendor.url;
    llmAgentsRev = vendor.rev;
    llmAgentsNarHash = vendor.narHash;
    llmAgentsVendorPath = vendor.vendorPath;
    nixpkgsRev = vendor.nixpkgsRev;
  };

  configGenerationFile = (pkgs.formats.json { }).generate "config-generation.json" configGeneration;

  # The vendored copy must be exactly the revision vendor.json claims, or the
  # fingerprint above is a lie and every recorded run is unexplainable.
  vendoredLock = lib.importJSON (repoRoot + "/infra/nix/llm-agents.nix/flake.lock");
  vendoredLocked = vendoredLock.nodes.root.inputs;
  _vendoringAssertion =
    if vendoredLock.nodes ? nixpkgs && vendoredLock.nodes.nixpkgs.locked.rev == vendor.nixpkgsRev then
      true
    else
      throw "infra/nix/vendor.json nixpkgsRev does not match infra/nix/llm-agents.nix/flake.lock";

  vendoringCheck = pkgs.runCommand "dsh-fleet-vendoring-check" { } ''
    mkdir -p $out
    cp ${(pkgs.formats.json { }).generate "vendor.json" vendor} $out/vendor.json
    cp ${configGenerationFile} $out/config-generation.json
    echo "${vendoredLocked.nixpkgs}" > $out/nixpkgs-node
  '';

  # Inventory of the requirement's own change list (§11) and removal list
  # (§12). The check below refuses a manifest that names a package that does
  # not exist, so the inventory cannot drift away from the tree.
  manifest = lib.importJSON (repoRoot + "/infra/fleet.manifest.json");

  manifestCheck =
    let
      entries = manifest.changes;
      names = map (entry: entry.package) entries;
      missing = builtins.filter (name: !(builtins.pathExists (repoRoot + "/packages/${name}"))) names;
      ids = map (entry: entry.id) manifest.changes;
      expectedIds = map (n: "change-${toString n}") (lib.range 1 17);
      unknownIds = builtins.filter (id: !(builtins.elem id expectedIds)) ids;
      missingIds = builtins.filter (id: !(builtins.elem id ids)) expectedIds;
    in
    if missing != [ ] then
      throw "infra/fleet.manifest.json names packages that do not exist: ${lib.concatStringsSep ", " missing}"
    else if missingIds != [ ] then
      throw "infra/fleet.manifest.json is missing change entries: ${lib.concatStringsSep ", " missingIds}"
    else if unknownIds != [ ] then
      throw "infra/fleet.manifest.json has unknown change ids: ${lib.concatStringsSep ", " unknownIds}"
    else
      pkgs.runCommand "dsh-fleet-manifest-check" { } ''
        mkdir -p $out
        cp ${(pkgs.formats.json { }).generate "fleet.manifest.json" manifest} $out/fleet.manifest.json
      '';

  # Profile patch layers owned by the fleet. They live in the fleet bundle so
  # the loader resolves every row's package against that bundle's own
  # dependencies, and so a fleet launch composes `base + fleet` instead of
  # editing any upstream bundle.
  fleetBundleDir = "packages/bundle/fleet";
  profilePatches = builtins.filter (lib.hasSuffix ".yml") (
    builtins.attrNames (builtins.readDir (repoRoot + "/${fleetBundleDir}"))
  );

  runtime = pkgs.runCommand "dsh-fleet-${version}" { } ''
    mkdir -p $out/bin $out/share/dsh-fleet/profiles $out/share/dsh-fleet/nix

    install -m 0555 ${machineId}/bin/dsh-fleet-machine-id $out/bin/dsh-fleet-machine-id
    install -m 0555 ${worker}/bin/dsh-fleet-worker $out/bin/dsh-fleet-worker
    install -m 0555 ${pushQueue}/bin/dsh-fleet-push $out/bin/dsh-fleet-push

    ${lib.concatMapStrings (patch: ''
      install -m 0444 ${repoRoot + "/${fleetBundleDir}/${patch}"} $out/share/dsh-fleet/profiles/${patch}
    '') profilePatches}

    cp -r ${repoRoot + "/infra/nix/llm-agents.nix"} $out/share/dsh-fleet/nix/llm-agents.nix
    chmod -R u+w $out/share/dsh-fleet/nix/llm-agents.nix

    install -m 0444 ${configGenerationFile} $out/share/dsh-fleet/config-generation.json
    install -m 0444 ${(pkgs.formats.json { }).generate "fleet.manifest.json" manifest} $out/share/dsh-fleet/fleet.manifest.json
    install -m 0444 ${repoRoot + "/flake.lock"} $out/share/dsh-fleet/flake.lock
  '';

  devShell = pkgs.mkShellNoCC {
    packages = [
      pkgs.nodejs_24
      pkgs.pnpm_11
      pkgs.tmux
      pkgs.git
      pkgs.jq
      pkgs.curl
      pkgs.cacert
      pkgs.python3
      pkgs.nix
      pkgs.shellcheck
    ];

    shellHook = ''
      # R-8: no writable state outside the workspace. The pnpm store, the
      # harness home and the XDG state all land under the checkout.
      export PNPM_HOME="$PWD/.pnpm"
      export npm_config_store_dir="$PWD/.pnpm-store"
      export DSH_HOME="''${DSH_HOME:-$PWD/.dsh}"
      export XDG_STATE_HOME="$PWD/.state"
      export XDG_DATA_HOME="$PWD/.local/share"
      export XDG_CACHE_HOME="$PWD/.cache"
      mkdir -p "$PNPM_HOME" "$npm_config_store_dir" "$DSH_HOME" "$XDG_STATE_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

      echo "dsh-fleet dev shell"
      echo "  node    $(node --version)"
      echo "  pnpm    $(pnpm --version)"
      echo "  tmux    $(tmux -V)"
      echo "  harness ${vendor.url} @ ${builtins.substring 0 12 vendor.rev}"
    '';
  };

  # Worker machines run harness binaries from `runtime` (or from their own
  # profile), so this shell only carries what the tmux channel itself needs.
  workerShell = pkgs.mkShellNoCC {
    packages = [
      pkgs.tmux
      pkgs.git
      pkgs.jq
    ];
  };
in
{
  inherit
    harnesses
    upstream
    configGeneration
    vendoringCheck
    manifestCheck
    runtime
    devShell
    workerShell
    version
    vendor
    ;
  upstreamDsh = upstream.dsh;
  inherit (harnesses) codex;
  claude-code = harnesses.claude-code;
}
