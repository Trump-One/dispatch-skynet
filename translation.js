"use strict";

window.createTaskTranslator = function createTaskTranslator(onTranslations) {
  const engine = window.Translator;
  const controls = document.getElementById("translation-controls");
  if (!controls || !engine?.availability || !engine.create) return () => {};

  const options = { sourceLanguage: "en", targetLanguage: "zh" };
  const attempted = new Set();
  const enable = document.createElement("button");
  const progress = document.createElement("span");
  enable.type = "button";
  enable.className = "button";
  enable.textContent = "启用本机翻译";
  progress.setAttribute("role", "status");
  controls.append(enable, progress);

  let titles = [];
  let phase = "idle";
  let session;
  let translating = false;

  function updateControls() {
    controls.hidden = !titles.some((title) => !attempted.has(title)) ||
      (phase !== "awaiting" && phase !== "starting");
    enable.disabled = phase === "starting";
  }

  async function translatePending() {
    if (!session || translating) return;
    translating = true;
    const translations = Object.create(null);
    let title;
    while ((title = titles.find((value) => !attempted.has(value)))) {
      attempted.add(title);
      try {
        const translation = (await session.translate(title)).trim();
        if (translation && translation !== title) translations[title] = translation;
      } catch {
        // The original title remains visible if an individual translation fails.
      }
    }
    translating = false;
    if (Object.keys(translations).length > 0) onTranslations(translations);
  }

  async function startTranslation() {
    phase = "starting";
    progress.textContent = "正在准备本机翻译…";
    updateControls();
    try {
      session = await engine.create({
        ...options,
        monitor(target) {
          target.addEventListener("downloadprogress", (event) => {
            if (!Number.isFinite(event.loaded)) return;
            const percent = Math.round(Math.min(1, Math.max(0, event.loaded)) * 100);
            progress.textContent = `正在下载语言包 ${percent}%`;
          });
        }
      });
      phase = "ready";
      progress.textContent = "";
    } catch {
      phase = "awaiting";
      progress.textContent = "本机翻译暂时无法启动，可点击重试。";
    }
    updateControls();
    if (session) void translatePending();
  }

  async function checkAvailability() {
    phase = "checking";
    try {
      const availability = await engine.availability(options);
      if (availability === "available" && titles.length) {
        void startTranslation();
        return;
      }
      if (availability === "available") phase = "idle";
      else if (availability === "downloadable" || availability === "downloading") phase = "awaiting";
      else phase = "unavailable";
    } catch {
      phase = "unavailable";
    }
    updateControls();
  }

  enable.addEventListener("click", () => {
    if (phase === "awaiting") void startTranslation();
  });

  return (nextTitles) => {
    titles = Array.from(new Set(nextTitles.filter((title) =>
      typeof title === "string" && /[A-Za-z]/.test(title) && !attempted.has(title)
    )));
    updateControls();
    if (!titles.length) return;
    if (phase === "idle") void checkAvailability();
    else if (phase === "ready") void translatePending();
  };
};
