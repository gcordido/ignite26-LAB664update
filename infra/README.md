# Infrastructure

<!-- IGNITE TEMPLATE PLACEHOLDER: remove this folder when the session needs no infrastructure. -->

Use this folder for deployment or runtime infrastructure, including Skillable-specific files when needed.

## Workbench setup and launch

- [`setup.ps1`](setup.ps1) installs the existing workbench runtime requirements
  and restores its locked dependencies. Downloads stay in the ignored `.tools/`
  folder at the repository root.
- [`launch-workbench.ps1`](launch-workbench.ps1) starts the separate Insurance
  Workbench App. It does not create cloud resources or submit document analysis
  on launch.

Run these scripts from the repository root as described in
[step 5 of the attendee guide](../instructions/lab.html#step5).
