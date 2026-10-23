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
includes the [policy-check comparison](lab.html#policy-checks): run with and
without Search retrieval, compare the daily-rate checks for packets 01 and 02,
and open the cited policy documents. Azure Search, Blob Storage and the Python
agent are optional under-the-hood explorations after the app comparison.

Run `infra\setup.ps1` again after pulling updates. It installs both the npm UI
dependencies and the Python policy agent. A prepared Search configuration and
Azure sign-in are required for policy checks; see
[lab-owner setup](../docs/policy-setup.md).
