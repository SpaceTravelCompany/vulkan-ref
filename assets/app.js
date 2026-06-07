(function () {
  const dataEl = document.getElementById("site-data");
  if (!dataEl) return;

  const { site, topics } = JSON.parse(dataEl.textContent);

  const mainPanel = document.getElementById("main-panel");
  const eyebrowEl = document.getElementById("topic-eyebrow");
  const sectionTitleEl = document.getElementById("section-title");
  const tabsWrapEl = document.getElementById("section-tabs-wrap");
  const tabsEl = document.getElementById("section-tabs");
  const tabsToggleBtn = document.getElementById("tabs-toggle");
  const viewportEl = document.getElementById("content-viewport");
  const counterEl = document.getElementById("sec-counter");
  const prevBtn = document.getElementById("sec-prev");
  const nextBtn = document.getElementById("sec-next");
  const navPanel = document.querySelector(".nav-panel");
  const navToggle = document.getElementById("nav-toggle");
  const navBackdrop = document.getElementById("nav-backdrop");

  const TABS_KEY = "vulkan-ref-tabs-visible";
  const THEME_KEY = "vulkan-ref-theme";
  const themeToggleBtn = document.getElementById("theme-toggle");

  const defaultTopic = site.sections[0]?.topics[0]?.slug ?? "draw-not-showing";

  let currentTopic = defaultTopic;
  let currentSection = 0;
  let tabsVisible = localStorage.getItem(TABS_KEY) !== "false";

  function getTheme() {
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    themeToggleBtn?.setAttribute(
      "aria-label",
      theme === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환",
    );
  }

  function highlightCode() {
    if (typeof Prism === "undefined") return;
    viewportEl.querySelectorAll("pre code").forEach((block) => {
      Prism.highlightElement(block);
    });
  }

  function updateHash() {
    const topic = topics[currentTopic];
    const section = topic?.sections[currentSection];
    const hash = section ? `#${currentTopic}/${section.id}` : `#${currentTopic}`;
    if (location.hash !== hash) {
      history.replaceState(null, "", hash);
    }
  }

  function parseHash() {
    const raw = location.hash.replace(/^#/, "");
    if (!raw || raw === "_home") return { topic: defaultTopic, sectionId: null };

    const slash = raw.indexOf("/");
    if (slash === -1) return { topic: raw, sectionId: null };

    return {
      topic: raw.slice(0, slash),
      sectionId: raw.slice(slash + 1),
    };
  }

  function setTabsVisible(visible) {
    tabsVisible = visible;
    localStorage.setItem(TABS_KEY, visible ? "true" : "false");
    mainPanel.classList.toggle("tabs-hidden", !visible);
    tabsToggleBtn.setAttribute("aria-expanded", String(visible));
    tabsToggleBtn.textContent = visible ? "섹션 숨기기" : "섹션 보기";
  }

  function closeMobileNav() {
    navPanel?.classList.remove("open");
    navBackdrop?.setAttribute("hidden", "");
  }

  function openMobileNav() {
    navPanel?.classList.add("open");
    navBackdrop?.removeAttribute("hidden");
  }

  function setActiveNav() {
    document.querySelectorAll(".topic-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.topic === currentTopic);
    });
  }

  function renderSectionTabs() {
    const topic = topics[currentTopic];
    if (!topic) return;

    tabsEl.innerHTML = topic.sections
      .map((sec, i) => {
        const active = i === currentSection ? " active" : "";
        return `<button type="button" class="section-tab${active}" role="tab" aria-selected="${i === currentSection}" data-index="${i}">${escapeHtml(sec.title)}</button>`;
      })
      .join("");

    tabsEl.querySelectorAll(".section-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        showSection(Number(btn.dataset.index));
      });
    });
  }

  function renderContent() {
    const topic = topics[currentTopic];
    if (!topic) return;

    const section = topic.sections[currentSection];

    viewportEl.innerHTML = section?.html ?? "";
    viewportEl.scrollTop = 0;
    highlightCode();

    const total = topic.sections.length;
    counterEl.textContent = total ? `${currentSection + 1} / ${total}` : "";
    prevBtn.disabled = currentSection <= 0;
    nextBtn.disabled = currentSection >= total - 1;

    eyebrowEl.textContent = topic.title;
    sectionTitleEl.textContent = section?.title ?? topic.title;
    document.title = `${section?.title ?? topic.title} — ${site.title}`;

    renderSectionTabs();
    setActiveNav();
    updateHash();
  }

  function showTopic(slug, sectionId) {
    if (!topics[slug]) slug = defaultTopic;
    currentTopic = slug;

    let idx = 0;
    if (sectionId) {
      const found = topics[slug].sections.findIndex((s) => s.id === sectionId);
      if (found >= 0) idx = found;
    }
    currentSection = idx;
    closeMobileNav();
    renderContent();
  }

  function showSection(index) {
    const topic = topics[currentTopic];
    if (!topic || index < 0 || index >= topic.sections.length) return;
    currentSection = index;
    renderContent();
  }

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  document.querySelectorAll(".topic-btn").forEach((btn) => {
    btn.addEventListener("click", () => showTopic(btn.dataset.topic));
  });

  tabsToggleBtn.addEventListener("click", () => setTabsVisible(!tabsVisible));

  themeToggleBtn?.addEventListener("click", () => {
    setTheme(getTheme() === "dark" ? "light" : "dark");
    highlightCode();
  });

  setTheme(getTheme());

  navToggle?.addEventListener("click", () => {
    if (navPanel?.classList.contains("open")) closeMobileNav();
    else openMobileNav();
  });

  navBackdrop?.addEventListener("click", closeMobileNav);

  prevBtn.addEventListener("click", () => showSection(currentSection - 1));
  nextBtn.addEventListener("click", () => showSection(currentSection + 1));

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      showSection(currentSection - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      showSection(currentSection + 1);
    } else if (e.key === "Escape") {
      closeMobileNav();
    }
  });

  window.addEventListener("hashchange", () => {
    const { topic, sectionId } = parseHash();
    showTopic(topic, sectionId);
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 800) closeMobileNav();
  });

  setTabsVisible(tabsVisible);

  const initial = parseHash();
  showTopic(initial.topic, initial.sectionId);
})();
