const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

const checkLabels = {
  "Daily rate": "Daily rate",
  "Effective terms": "Effective terms",
  "Repair estimate": "Repair estimate",
};

export function chatMessageHtml(text, citations = []) {
  const sources = citations.map((citation) => {
    const label = `${citation.DocumentId} · ${citation.RuleId} · ${citation.Section}`;
    return /^\/data\/policies\/rental\/(?:ocr-comparison-v2\/)?[a-z0-9-]+\.pdf#page=[1-9]\d*$/.test(citation.href ?? "")
      ? `<p><a href="${escapeHtml(citation.href)}" data-rule="${escapeHtml(citation.RuleId)}">${escapeHtml(label)}</a></p>`
      : `<p>${escapeHtml(label)} — source not verified</p>`;
  }).join("");
  return `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(text)}</div>${sources}`;
}

export function resultChatText(result) {
  return result.Checks.map((check) =>
    `${checkLabels[check.Check] ?? check.Check}\n${check.Outcome === "NotApplicable" ? "Not applicable" : check.Outcome === "InProgress" ? "Waiting for info - missing claim evidence for this comparison" : check.ReviewRequired ? "Review required" : "Satisfied"}\n` +
    `Expected: ${check.ExpectedValue}\nActual: ${check.ActualValue}\nReason: ${check.Reason}`).join("\n\n");
}

export function createPolicyChat({ container, api, onSource, onError }) {
  const widgets = new Map();
  let selectionKey = "";
  let generation = 0;
  function reset() {
    generation++;
    selectionKey = "";
    widgets.clear();
    container.textContent = "Select a policy check to ask follow-up questions.";
  }
  async function show(selection) {
    const key = JSON.stringify(selection);
    selectionKey = key;
    const revision = generation;
    for (const [otherKey, widget] of widgets) widget.hidden = otherKey !== key;
    if (widgets.has(key)) return;
    if (!widgets.size) container.replaceChildren();
    const holder = document.createElement("div");
    holder.className = "policy-chat-case";
    holder.textContent = "Loading the original prompt and saved policy result…";
    container.append(holder);
    widgets.set(key, holder);
    try {
      const context = await api(`policy/chat?mode=${encodeURIComponent(selection.mode)}&packetId=${encodeURIComponent(selection.packetId)}&runId=${encodeURIComponent(selection.runId)}&check=${encodeURIComponent(selection.check)}`);
      await loadComponent();
      if (revision !== generation) return;
      const heading = document.createElement("h2");
      const label = checkLabels[selection.check];
      heading.textContent = `${label} · ${selection.packetId}`;
      const reload = document.createElement("button");
      reload.className = "secondary";
      reload.textContent = "Reload chat";
      reload.onclick = () => {
        widgets.delete(key);
        holder.remove();
        show(selection).catch(onError);
      };
      const notice = document.createElement("p");
      notice.className = "muted";
      notice.textContent = `${context.agent.modelDeployment} · ${context.agent.indexName ?? "No policy retrieval"}. ` +
        "Ask about any policy or claim detail in this packet, including hypothetical scenarios. " +
        "Uses saved CU fields and parsed page text; no new claim extraction. Follow-ups use Azure and may be billed. Chat does not change saved results.";
      const original = document.createElement("details");
      const summary = document.createElement("summary");
      const promptLabel = context.promptSource === "saved"
        ? `${label}: original question and saved Parse evidence`
        : `${label}: current question and saved Parse evidence`;
      summary.textContent = promptLabel;
      const prompt = document.createElement("pre");
      prompt.textContent = context.prompt;
      original.append(summary, prompt);
      const chat = document.createElement("deep-chat");
      chat.setAttribute("aria-label", `${label} follow-up conversation`);
      const revealComposer = () => requestAnimationFrame(() => {
        if (revision === generation && selectionKey === key && chat.getClientRects().length)
          chat.scrollIntoView({ block: "end", inline: "nearest" });
      });
      const citations = [...context.citations.flat(), ...context.replies.flatMap((reply) => reply.citations)];
      const originalSources = context.citations.flat();
      chat.history = [
        { role: "user", html: `<details><summary>${escapeHtml(promptLabel)}</summary>${chatMessageHtml(context.prompt)}</details>` },
        { role: "ai", html: chatMessageHtml(resultChatText(context.result), originalSources) },
        ...context.messages.slice(2).map((message, index) => ({
          role: message.role === "assistant" ? "ai" : "user",
          html: chatMessageHtml(message.content, message.role === "assistant"
            ? context.replies[Math.floor(index / 2)]?.citations ?? [] : []),
        })),
      ];
      chat.chatStyle = { width: "100%", height: "auto", overflow: "visible", border: "none", backgroundColor: "#fff", fontFamily: "Segoe UI, sans-serif" };
      chat.messageStyles = { default: { shared: { bubble: { maxWidth: "96%", fontSize: "13px" } } } };
      chat.textInput = { placeholder: { text: "Ask about this claim, its policy, or a hypothetical scenario…" } };
      chat.requestBodyLimits = { maxMessages: 1 };
      chat.remarkable = { html: false };
      chat.errorMessages = { displayServiceErrorMessages: true };
      chat.connect = { handler: async (body, signals) => {
        reload.disabled = true;
        revealComposer();
        try {
          const message = body.messages?.at(-1)?.text;
          if (typeof message !== "string" || !message.trim()) throw new Error("Enter a follow-up question.");
          const reply = await api("policy/chat", { mode: selection.mode, packetId: selection.packetId,
            runId: selection.runId, check: selection.check, contextId: context.contextId, message, live: true });
          citations.push(...reply.citations);
          await signals.onResponse({ html: chatMessageHtml(reply.text, reply.citations) });
        } catch (error) {
          await signals.onResponse({ error: error instanceof Error ? error.message : String(error) });
        } finally { reload.disabled = false; signals.onClose(); revealComposer(); }
      } };
      let listening = false;
      chat.onComponentRender = () => {
        if (listening || !chat.shadowRoot) return;
        listening = true;
        chat.shadowRoot?.addEventListener("click", (event) => {
          const link = event.target instanceof Element ? event.target.closest("a") : null;
          if (!link) return;
          event.preventDefault();
          const citation = citations.find((value) => value.href === link.getAttribute("href") &&
            value.RuleId === link.getAttribute("data-rule"));
          if (citation?.href) onSource(citation, link).catch(onError);
        });
      };
      const toolbar = document.createElement("div");
      toolbar.className = "actions";
      toolbar.append(heading, reload);
      holder.replaceChildren(toolbar, notice, original, chat);
      holder.hidden = selectionKey !== key;
    } catch (error) {
      if (revision !== generation) return;
      holder.replaceChildren();
      const message = document.createElement("p");
      message.className = "error";
      message.textContent = error instanceof Error ? error.message : String(error);
      const retry = document.createElement("button");
      retry.textContent = "Reload chat";
      retry.onclick = () => {
        widgets.delete(key);
        holder.remove();
        show(selection).catch(onError);
      };
      holder.append(message, retry);
    }
  }
  return { show, reset };
}

let component;
function loadComponent() {
  if (!component) component = import("/vendor/deep-chat/deepChat.bundle.js").catch((error) => {
    component = undefined;
    throw error;
  });
  return component;
}
