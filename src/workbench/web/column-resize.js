export function resizeColumns(table, widths, remember) {
  const cols = [...table.querySelectorAll("col")];
  const update = (index, width) => {
    widths[index] = Math.max(index === 0 ? 48 : 70, Math.round(width));
    cols[index].style.width = `${widths[index]}px`;
    table.style.width = `${widths.reduce((sum, value) => sum + value, 0)}px`;
    remember(index, widths[index]);
  };
  table.querySelectorAll("thead th").forEach((header, index) => {
    const grip = document.createElement("span");
    grip.className = "column-resizer";
    grip.title = "Drag to resize";
    grip.tabIndex = 0;
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-orientation", "vertical");
    grip.setAttribute("aria-label", `Resize ${header.textContent}`);
    let start;
    grip.onpointerdown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      start = { x: event.clientX, width: widths[index] };
      grip.setPointerCapture(event.pointerId);
      document.body.classList.add("resizing-column");
    };
    grip.onpointermove = (event) => {
      if (start) update(index, start.width + event.clientX - start.x);
    };
    const stop = () => {
      start = undefined;
      document.body.classList.remove("resizing-column");
    };
    grip.onpointerup = (event) => {
      if (grip.hasPointerCapture(event.pointerId))
        grip.releasePointerCapture(event.pointerId);
      stop();
    };
    grip.onpointercancel = stop;
    grip.onlostpointercapture = stop;
    grip.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      update(index, widths[index] + (event.key === "ArrowRight" ? 10 : -10));
    };
    header.append(grip);
  });
}

export function splitPreview(main, handle) {
  let ratio = 0.57;
  let drag;
  const contentWidth = () => {
    const style = getComputedStyle(main);
    return (
      main.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight)
    );
  };
  const apply = (width) => {
    const available = contentWidth();
    const left = Math.max(360, Math.min(available - 324, width));
    main.style.setProperty("--left-pane", `${left}px`);
    handle.setAttribute(
      "aria-valuenow",
      String(Math.round((left / available) * 100)),
    );
    handle.setAttribute(
      "aria-valuetext",
      `${Math.round(((available - left - 24) / available) * 100)}% preview width`,
    );
    return left;
  };
  const layout = () => {
    if (window.innerWidth <= 1000) return;
    main.style.height = `${Math.max(360, window.innerHeight - main.offsetTop)}px`;
    apply(contentWidth() * ratio);
    main.dispatchEvent(new Event("pane-resize"));
  };
  handle.onpointerdown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = {
      x: event.clientX,
      width: main.querySelector(".toolbar").getBoundingClientRect().width,
    };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-column");
  };
  handle.onpointermove = (event) => {
    if (!drag) return;
    const width = apply(drag.width + event.clientX - drag.x);
    ratio = width / contentWidth();
  };
  const stop = () => {
    if (!drag) return;
    drag = undefined;
    document.body.classList.remove("resizing-column");
    main.dispatchEvent(new Event("pane-resize"));
  };
  handle.onpointerup = (event) => {
    if (handle.hasPointerCapture(event.pointerId))
      handle.releasePointerCapture(event.pointerId);
    stop();
  };
  handle.onpointercancel = stop;
  handle.onlostpointercapture = stop;
  handle.onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    ratio =
      apply(contentWidth() * ratio + (event.key === "ArrowRight" ? 24 : -24)) /
      contentWidth();
    main.dispatchEvent(new Event("pane-resize"));
  };
  window.addEventListener("resize", layout);
  layout();
}
