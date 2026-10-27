# Infrastructure

<!-- IGNITE TEMPLATE PLACEHOLDER: remove this folder when the session needs no infrastructure. -->

Use this folder for deployment or runtime infrastructure, including Skillable-specific files when needed.

## Workbench setup and launch

- [`setup.ps1`](setup.ps1) installs the existing workbench runtime requirements
  and restores its locked npm dependencies, including Deep Chat. It also creates
  `.tools\policy-venv` and installs the Python Agent Framework, OpenAI and Azure
  Search packages. Downloads and the Python environment stay in the ignored
  `.tools/` folder at the repository root.
- [`launch-workbench.ps1`](launch-workbench.ps1) starts the separate Insurance
  Workbench App. It does not create cloud resources or submit document analysis
  on launch.

Run these scripts from the repository root as described in
[step 5 of the attendee guide](../instructions/lab.html#step5).

Install Python 3.10 or later with pip and venv before running setup. Setup uses
the existing Python installation; it doesn't install Agent Framework with npm.
Core and provider packages have independent version numbers: this lab pins
`agent-framework-core==1.21.0` and `agent-framework-openai==1.16.0`.

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\setup.ps1
az login
powershell -ExecutionPolicy Bypass -File .\infra\launch-workbench.ps1
```

The launcher selects the local Python environment automatically. For a
separately managed environment, set `POLICY_PYTHON` to its `python.exe`.
Rerun setup after pulling updates to restore both npm and Python dependencies.
Stop the app first, and restart it afterward. No manual `npm install deep-chat`
or global Python package installation is required.

## Lab machines with package mirrors

Setup honors the machine's npm and pip settings. If a package version isn't
available, ask the lab administrator to sync the lockfile and requirements
versions to the approved mirrors. The npm lockfile preserves package versions
and integrity hashes without hardcoding a particular registry's download URLs.
Inspect `npm config get registry` and
`python -m pip config debug` locally; don't share output containing credentials.
If the administrator permits another source, pass it explicitly:

```powershell
.\infra\setup.ps1 `
  -PythonExecutable "C:\Path\To\Python\python.exe" `
  -NpmRegistry "https://YOUR-APPROVED-NPM-REGISTRY" `
  -PythonIndexUrl "https://YOUR-APPROVED-PYTHON-INDEX/simple"
```

These options don't change global registry settings, bypass TLS, or silently
fall back to public sources. Don't include credentials in command arguments.
An existing Node installation without npm triggers the portable Node setup.

## Prepare policy retrieval

Installing dependencies doesn't deploy or connect a policy index. A prepared
lab machine also needs `.tools\policy-agent-framework.json` for its verified
index, a reachable model deployment and Azure permissions. Follow
[policy index setup](../docs/policy-setup.md) before the session. Setup reports
missing permissions rather than granting roles. The
[policy walkthrough](../docs/policy-checks.md#compare-packets-01-and-02)
then starts with the app, not Azure provisioning.

Provision `.tools\policy-deployment.json` with the machine's Search, Storage
and Foundry resource IDs plus its model/analyzer names. Both policy deployment
scripts use these settings instead of environment-specific source constants.
The deployment file does not enable policy checks by itself; only verified
activation writes the runtime configuration.
The launcher uses that verified configuration's CU endpoint when neither
`-Endpoint` nor `CU_ENDPOINT` is supplied.
It also writes CU request diagnostics to `.tools\logs\cu-requests.jsonl`;
`CU_DIAGNOSTICS_LOG` can select an existing writable directory's log file.
Logs contain request metadata and correlation IDs, not tokens or document
payloads. See [retry and diagnostic guidance](../docs/policy-checks.md).

## Regenerate the policy corpus

The optional [`generate-rental-sop-corpus.py`](generate-rental-sop-corpus.py)
script uses separate
[`requirements-rental-sop-corpus.txt`](requirements-rental-sop-corpus.txt)
dependencies and Windows Segoe UI fonts. Attendees don't need these packages
to use the existing PDFs. Follow the
[corpus regeneration guidance](../docs/rental-ocr-comparison.md#activation-boundaries)
when changing policy rules or expected outcomes.
