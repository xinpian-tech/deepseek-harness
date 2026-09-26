#!/usr/bin/env bash
# MachineId for this host (infra requirement §10: "MachineId = hostid").
#
# The id is what shards durable state: session archive refs, placement records
# and the performance ledger are all keyed by it, so it must be stable across
# reboots and identical for every process on the machine.
#
# Resolution order:
#   1. DSH_FLEET_MACHINE_ID  — explicit override, used by tests and by hosts
#                              whose hostid is not unique in the fleet.
#   2. /etc/machine-id       — systemd hostid, the documented default.
#   3. hostname              — last resort on hosts without systemd.
set -euo pipefail

if [[ -n "${DSH_FLEET_MACHINE_ID:-}" ]]; then
  printf '%s\n' "$DSH_FLEET_MACHINE_ID"
  exit 0
fi

for candidate in /etc/machine-id /var/lib/dbus/machine-id; do
  if [[ -r "$candidate" ]]; then
    id="$(tr -d '[:space:]' <"$candidate")"
    if [[ -n "$id" ]]; then
      printf '%s\n' "$id"
      exit 0
    fi
  fi
done

printf '%s\n' "$(hostname)"
