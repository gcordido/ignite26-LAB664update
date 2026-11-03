## Before you're done

This repo has been created for your Microsoft Ignite 2026 session. Here's how to get it ready.

**Easiest path — use the agent (recommended):**

- Open GitHub Copilot Chat and say `help me initialize repo`. The agent will walk you through getting the README populated.
- When you're ready to publish, say `help me finalize repo`. The agent will clean up unused folders, validate everything, and remove this "Before you're done" section and other extra stuff that attendees don't need to see.
- Curious how it works? Read the [agent workflow](.github/AGENT-WORKFLOW.md).

**Doing it manually?**

Fill in the sections below yourself, then:

- Delete any placeholder folders you don't need (`data/`, `infra/`, etc.)
- Delete this "Before you're done" section
- Delete `.github/agents/`, `.github/tests/`, `.github/copilot-instructions.md`, and `.github/AGENT-WORKFLOW.md` — these are template tooling, not part of your published repo

**Folder conventions:**

- Attendee step-by-step guidance goes in `instructions/`. If you use MkDocs or a docs site instead, put it in `docs/` and link to it from this README.
- Reference material and background reading go in `docs/`.
- You can add a `.devcontainer/` folder if needed.

---

<a name="start-building"></a>

<p align="center">
<img src="img/banner-ignite-26.png" alt="Microsoft Ignite 2026" width="100%"/>
</p>

# [Microsoft Ignite 2026](https://ignite.microsoft.com)

## 🔥LAB664: Build agentic document workflows with Content Understanding
### Session description

Enterprise processes start with unstructured content—documents, images, audio, video, emails. Before AI agents can act, they must understand and structure it. In this hands-on lab, use Azure Content Understanding (CLI, SDKs) in an agent loop to build an end-to-end workflow. Process real business content, extract and classify information, and route work through automated decision paths. Learn confidence-based automation and human-in-the-loop review for straight-through processing.

### 🚀 Getting started

Clone or download the repository, then open
[`instructions/lab.html`](instructions/lab.html) locally in your browser.
The five-step guide covers Content Understanding extraction in CU Studio,
then policy checks in the separate Insurance Workbench App.

#### Set up or update the workbench

On Windows, install **Python 3.10 or later** with pip and venv. In PowerShell
at the repository root, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\setup.ps1
powershell -ExecutionPolicy Bypass -File .\infra\launch-workbench.ps1
```

Setup restores the locked npm packages, including **Deep Chat**, and installs
the **Python Microsoft Agent Framework** and Azure Search dependencies into
`.tools\policy-venv`. It installs a supported Node runtime and Azure CLI if
needed, but doesn't sign you in or create cloud resources. Stop the app and
rerun setup after pulling updates; no individual package installs are needed.
For managed package mirrors or a specific Python path, see
[`infra/README.md`](infra/README.md#lab-machines-with-package-mirrors).

Open [http://127.0.0.1:8791/](http://127.0.0.1:8791/). Keep the launch terminal
open. The included extraction and policy results work without Azure setup,
credentials or network access to Azure. Sign in with `az login` and prepare
the index configuration only to run live analysis or policy checks.

#### Try the policy-check comparison

On first launch, the app automatically loads the included **10/10** CU run and
all **30** saved policy checks. Open **Check policies** with **FoundryIQ**
selected. **Load cached results** reloads them; no separate extraction step is needed.
**Parse and extract** > **Load cached results** also loads the included CU run
independently. Without compatible local reviews,
the app reads all ten synthetic reviews directly from the checked-in demo bundle.
No restore command, Azure configuration or credentials are needed. **Bundled demo**
identifies these read-only results and their original Search index; they aren't
presented as results from a newly configured index. Existing local configuration
and caches aren't overwritten. Live-compatible cached results take precedence.
Loading makes no Azure calls. Follow-up chat requires live Azure configuration, but viewing the saved checks doesn't.
FoundryIQ is the lab's umbrella label; this implementation retrieves evidence
directly from Azure AI Search, not a Foundry IQ knowledge base.

The three columns are **Daily rate**, **Rental start**, and **Effective terms**.
Compare the claimed daily rental base rate with the effective cap for the matched
insured vehicle, the stated rental start basis with the documented drivability rule,
and the applicable policy and genuine amendment with the actual loss date.
Match the policy ID and insured VIN, not just a similar vehicle.
Compare the claim and policy
values in the right panel, then follow a value's source link to its PDF.
A check mark means **Satisfied**, an open circle means **Review required**,
and a circular-arrow icon means **Waiting for info**, not an agent still running.
**N/A** can apply to **Daily rate** and **Rental start** for a confirmed non-rental
claim; **Effective terms** still compares the matched terms with the loss date.
Packet **01** illustrates why a numerical rate fit is conditional on rental
eligibility, not payment approval. Packet **02** separates the contractual cap
from the SOP's routine handling authority. Missing unrelated repair completion
or insurer payment authorization doesn't create a wait for these narrow checks.
Linked page text is labeled as first-pass parsed evidence: its interpretation
isn't a typed CU fact, and no source boxes are invented.
These are evidence-based reviews, not coverage or payment approval.

Select **Run live** and confirm only to request policy work. Matching current
reviews are reused; uncached packets use saved Parse fields and selected first-pass
page text, without claim-summary preparation or claim CU reanalysis. The agent
interprets rental applicability before three parallel comparison calls. Azure charges apply.
The previous five-check bundle remains legacy history; the new bundle replaces
the active results without editing extracted facts or inventing outcomes.
See [policy checks](docs/policy-checks.md) for the walkthrough and cache details.

For guided and self-paced sessions, follow
[step 5: compare policy checks](instructions/lab.html#policy-checks).
Optional under-the-hood guidance covers the deployed Search index, policy PDFs,
Blob ingestion and the Agent Framework implementation. This PR uses an ordinary
Search index directly, not a Foundry IQ knowledge base.

**Lab owners:** a fresh clone doesn't include the machine-local policy
configuration. Complete [policy index setup](docs/policy-setup.md) before running
live work in the session; the bundled demo doesn't need it. The existing CU Layout index remains valid while optional managed
Standard ingestion prerequisites are unresolved; don't label it Standard.
Use [`infra/deploy.ps1`](infra/README.md#deploy-infrastructure-and-the-policy-index)
to run Search-managed Standard indexing with semantic chunks and AI figure descriptions.
Pass `-ResourceGroup` to discover existing lab services and configure the index
without a hand-filled settings file. ARM deployment requires the explicit
`-DeployResources` switch and a provisioning identity with role-assignment permissions.
Successful deployment also prepares the claim analyzer and writes the workbench's
verified runtime configuration, so no separate activation command is needed.
The setup notebook also walks through managed ingestion on the existing Search service.

### 🎯 Learning outcomes

By the end of this session, you will be able to:

- Outcome 1
- Outcome 2
- Outcome 3

### 💻 Technologies used

- Technology 1
- Technology 2
- Technology 3

### 📚 Continue your learning

Pick your next step based on your learning style:

| Resource | What you'll get |
|----------|-----------------|
| **[Ignite 2026 Next Steps](https://aka.ms/ignite26-next-steps)** | Additional session repos and materials from Microsoft Ignite 2026 |
| **[Microsoft AI Skills Navigator](https://aka.ms/ignite26-asn)** | Discover AI skills, learning paths, and resources for your next step |
| **[Microsoft Learn](https://aka.ms/ignite26-learn)** | Official documentation and guided learning paths on these topics |
| **[Microsoft Foundry Community](https://aka.ms/MicrosoftFoundryDiscord-Ignite26)** | Connect with other learners and experts in our Discord community |

### 🌟 Microsoft Learn MCP Server

<!-- Remove this section if the Microsoft Learn MCP Server is not relevant to the session. -->

The Microsoft Learn MCP Server gives your AI agent direct access to Microsoft's official documentation — grounded, up-to-date answers about the topics in this session.

**GitHub Copilot CLI** — Install with:

```shell
copilot plugin install microsoftdocs/mcp
```

**VS Code** — One-click install:  
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Microsoft_Learn_MCP-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=microsoft-learn&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Flearn.microsoft.com%2Fapi%2Fmcp%22%7D)

For more information, visit the [Learn MCP Server repo](https://aka.ms/learnmcp).

### 👥 Content owners

<!-- TODO: Add yourself as a content owner
1. Change the src in the image tag to {your github url}.png
2. Change INSERT NAME HERE to your name
3. Change the github url in the final href to your url. -->

<table>
<tr>
    <td align="center"><a href="http://github.com/yourGitHubHandle">
        <img src="https://github.com/yourGitHubHandle.png" width="100px;" alt="INSERT NAME HERE"/><br />
        <sub><b>INSERT NAME HERE</b></sub></a><br />
            <a href="https://github.com/yourGitHubHandle" title="talk">📢</a>
    </td>
</tr></table>

### ⚖️ Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft trademarks or logos is subject to and must follow [Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general). Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.

Any use of third-party trademarks or logos are subject to those third-party's policies.
