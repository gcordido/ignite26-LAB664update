# Lab environment requirements

This demo must run in a provisioned lab environment. Do not assume attendees
can install additional npm packages or access the npm registry.

- Prefer existing dependencies and platform APIs.
- Flag any proposed new npm library dependency before adding or installing it.
  Explain why it is needed, which packages it adds, and what must change in lab
  provisioning so the demo runs on attendee machines.
- Obtain approval before introducing the dependency. If approved, update the
  package manifest, lockfile, and relevant lab setup instructions together.
- Distinguish restoring existing locked dependencies with `npm ci` from adding
  a new dependency. Continue to honor repository restrictions on package
  installation.
