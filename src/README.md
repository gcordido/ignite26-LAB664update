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

Policy review sends grouped, populated claim fields as Markdown with YAML
frontmatter. It excludes original document text and extraction metadata
and isn't limited to the current table view.
See the [format reference](../docs/packet-json.md).

The **Policy checks** tab compares **No policy retrieval** with
**Azure Search retrieval** using one Python Agent Framework implementation.
Search-managed CU ingestion prepares the policy index on the existing service.
Explicit runs show five checks per packet, Expected/Actual values, reasons and
verified source links in the Result/Chat sidebar. See [policy setup](../docs/policy-setup.md) and
[the workbench flow](../docs/policy-checks.md).
