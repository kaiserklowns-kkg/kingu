#!/bin/sh
# A tauri `--runner` is exec'd directly (`cargo-auditable build`), which cargo-auditable ≥0.7
# refuses ("invoke through Cargo"): this wrapper reaches it through cargo, as its only entry.
exec cargo auditable "$@"
