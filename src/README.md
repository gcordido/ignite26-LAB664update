# Source

<!-- IGNITE TEMPLATE PLACEHOLDER: remove this folder when the session needs no source files. -->

Use this folder for sample code, demos, or runnable source material.

## Insurance workbench

[`workbench/`](workbench/) contains the separate Insurance Workbench App.
It reads the shared inputs in `data/` at the repository root.
Dependencies are restored from its package lock file by
[`infra/setup.ps1`](../infra/setup.ps1); no runtime binaries or installed packages
are included.

Follow the [five-step attendee guide](../instructions/lab.html) to author
analyzers in CU Studio and then launch the app.
