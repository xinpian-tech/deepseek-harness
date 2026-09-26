{
  description = "DeepSeek Harness fleet: Nix as the only dependency source for the multi-machine agent cluster";

  # R-8: every dependency of this project arrives through this flake, and every
  # artifact under `packages` is rebuilt from it. The agent-harness toolchain
  # (dsh, codex, claude-code, kimi, tmux, node, pnpm) comes from the vendored
  # numtide/llm-agents.nix copy in infra/nix/llm-agents.nix, so a machine needs
  # no network beyond the flake inputs and no package manager on PATH.
  #
  # R-0: this file and everything under infra/ are additions. No upstream
  # deepseek-harness file changes, so an upstream sync stays a fast-forward.

  inputs = {
    # Vendored copy of github:numtide/llm-agents.nix. The revision is pinned by
    # infra/nix/llm-agents.nix/flake.lock and recorded in infra/nix/vendor.json;
    # infra/scripts/vendor-llm-agents.sh re-vendors a different revision.
    llm-agents.url = "path:./infra/nix/llm-agents.nix";

    # One nixpkgs for the whole fleet, taken from the vendored flake so the
    # harness packages and our own shells cannot drift apart.
    nixpkgs.follows = "llm-agents/nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      llm-agents,
      ...
    }@inputs:
    let
      lib = nixpkgs.lib;

      # The fleet runs on Linux; the macOS entries keep `nix flake check`
      # evaluable for developers working on a Darwin host.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      eachSystem = lib.genAttrs systems;

      pkgsFor = eachSystem (
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        }
      );

      # Package set the fleet is assembled from: the vendored harness packages
      # plus everything this repository adds on top.
      fleetFor =
        system:
        import ./infra/nix/fleet.nix {
          pkgs = pkgsFor.${system};
          inherit lib llm-agents system inputs;
          repoRoot = ./.;
          fleetFlake = self;
        };

      # ConfigGeneration fingerprint (infra requirement §11 item 12): the exact
      # flake URI, revision, lock hash and store path every execution records.
      configGeneration = eachSystem (
        system: (fleetFor system).configGeneration
      );
    in
    {
      inherit configGeneration;

      packages = eachSystem (
        system:
        let
          fleet = fleetFor system;
        in
        {
          # `nix build .#default` — the deployable fleet runtime. Discard
          # `result` and it rebuilds identically from this flake.
          default = fleet.runtime;

          # The fleet runtime under an explicit name, so a deployment can pin
          # `.#fleet-runtime` without relying on the `default` alias.
          fleet-runtime = fleet.runtime;

        }
        # Harness binaries are deliberately NOT re-exported here. They come
        # from the vendored flake, and `nix flake check` builds every package
        # this flake exposes: re-exporting codex, claude-code, kimi-code and
        # the npm-packaged dsh would turn a check into a multi-gigabyte build
        # of upstream artifacts this repository does not own. Machines get them
        # with `nix build ./infra/nix/llm-agents.nix#<name>` or from the
        # `nix develop` shell, and `fleet.harnesses` names the supported set.
      );

      devShells = eachSystem (
        system: {
          # `nix develop` — the only supported way to build or test this
          # repository (R-8 layer two: commands run inside the flake, not on
          # the host).
          default = (fleetFor system).devShell;

          # Minimal shell for worker panes: the harness plus tmux, no node/pnpm.
          worker = (fleetFor system).workerShell;
        }
      );

      checks = eachSystem (
        system:
        let
          fleet = fleetFor system;
        in
        {
          # `nix flake check` — builds the fleet runtime and validates the
          # vendoring record and the plugin manifest.
          inherit (fleet) runtime;
          vendoring = fleet.vendoringCheck;
          manifest = fleet.manifestCheck;
        }
      );

      formatter = eachSystem (system: pkgsFor.${system}.nixfmt-rfc-style);
    };
}
