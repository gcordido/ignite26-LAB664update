# Attendee instructions

Use this folder for attendee step-by-step guidance, including self-paced
instructions, for any session type.

## Lab entry point

Use the [nine-step lab guide](lab.md) for both guided and self-paced sessions
in the provisioned lab environment. Lab-platform variables and VM screenshot
paths are resolved by that environment, not by GitHub's Markdown preview.

The guide identifies every input under `data\samples`
and explains when to run the setup and launch scripts in `infra`.
The Insurance Workbench App is launched separately in step 7. Step 9
includes the [policy-check comparison](lab.md#step-9-review-claims-with-azure-search-foundry-iq): inspect all **30**
saved results without Azure setup under **Claim policy checks**, in the order
**Daily rate**, **Effective terms**, and **Repair estimate**.
Start with packet 01, compare the rental rates for packets 01 and 02,
and open the cited policy documents and synthetic repair-authority diagram.
Repair review authority isn't a contractual rental limit or payment approval.
Azure Search, Blob Storage and the Python
agent are optional under-the-hood explorations after the app comparison.

The lab owner should restore dependencies with `infra\setup.ps1` after pulling
updates, using approved package sources. It restores the locked npm UI
dependencies and installs the pinned Python policy agent requirements; it does
not ordinarily provision Search or connect the agent. Saved results need neither
Azure sign-in nor a cache-restore command. Live policy checks and chat require
Azure sign-in, a verified Search/model/analyzer configuration, and the appropriate
permissions; see
[lab-owner setup and troubleshooting](../docs/policy-setup.md#prepare-live-policy-checks-on-a-lab-machine).
