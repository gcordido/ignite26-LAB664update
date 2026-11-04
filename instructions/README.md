# Attendee instructions

<!-- IGNITE TEMPLATE PLACEHOLDER: remove this folder when the session has no attendee step-by-step guidance. -->

Use this folder for attendee step-by-step guidance, including self-paced
instructions, for any session type.

## Lab entry point

Use the [five-step lab guide](lab.html) for both guided and self-paced sessions.
Clone or download the repository, then open `instructions\lab.html` locally
in your browser; GitHub's file view does not run the HTML guide.

The guide identifies every input under `data\step1` through `data\step4`
and explains when to run the setup and launch scripts in `infra`.
The Insurance Workbench App is launched separately in step 5. That step also
includes the [policy-check comparison](lab.html#policy-checks): inspect all **30**
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
