const menuButton = document.querySelector("[data-menu-button]");
const nav = document.querySelector("[data-site-nav]");
const languageSwitcher = document.querySelector("[data-language-switcher]");
const languagePreferenceKey = "justwork-site-language";

const normalizeLanguage = (value) => String(value || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
const getLocalizedPath = (language) => {
  const path = window.location.pathname;
  const hash = window.location.hash;
  const query = window.location.search;
  const withoutEnglishPrefix = path.replace(/^\/en(?=\/|$)/, "") || "/";
  const localizedPath = language === "en"
    ? `/en${withoutEnglishPrefix === "/" ? "/" : withoutEnglishPrefix}`
    : withoutEnglishPrefix;
  return `${localizedPath}${query}${hash}`;
};

const pageLanguage = document.documentElement.lang === "en" ? "en" : "zh-CN";
let savedLanguage;
try { savedLanguage = localStorage.getItem(languagePreferenceKey); } catch {}
const preferredLanguage = savedLanguage ? normalizeLanguage(savedLanguage) : normalizeLanguage(navigator.language);

if (window.location.pathname === "/" && preferredLanguage !== pageLanguage) {
  window.location.replace(getLocalizedPath(preferredLanguage));
}

if (languageSwitcher) {
  languageSwitcher.value = pageLanguage;
  languageSwitcher.addEventListener("change", () => {
    const language = normalizeLanguage(languageSwitcher.value);
    try { localStorage.setItem(languagePreferenceKey, language); } catch {}
    window.location.assign(getLocalizedPath(language));
  });
}

menuButton?.addEventListener("click", () => {
  const open = menuButton.getAttribute("aria-expanded") === "true";
  menuButton.setAttribute("aria-expanded", String(!open));
  nav?.toggleAttribute("data-open", !open);
});

document.querySelectorAll("[data-site-nav] a").forEach((link) => {
  link.addEventListener("click", () => {
    menuButton?.setAttribute("aria-expanded", "false");
    nav?.removeAttribute("data-open");
  });
});

const currentYear = String(new Date().getFullYear());
document.querySelectorAll("[data-current-year]").forEach((node) => {
  node.textContent = currentYear;
});

const formatBytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

fetch("/downloads/latest.json")
  .then((response) => {
    if (!response.ok) throw new Error("release metadata unavailable");
    return response.json();
  })
  .then((release) => {
    document.querySelectorAll("[data-release-version]").forEach((node) => {
      node.textContent = `v${release.version}`;
    });
    document.querySelectorAll("[data-release-size]").forEach((node) => {
      node.textContent = formatBytes(release.bytes);
    });
    document.querySelectorAll("[data-release-sha]").forEach((node) => {
      node.textContent = release.sha256;
      node.setAttribute("title", release.sha256);
    });
    document.querySelectorAll("[data-direct-download]").forEach((node) => {
      node.setAttribute("href", `/downloads/${release.filename}`);
      node.setAttribute("download", release.filename);
    });
  })
  .catch(() => {
    document.querySelectorAll("[data-release-meta]").forEach((node) => node.remove());
  });

document.querySelectorAll("[data-copy-sha]").forEach((button) => {
  button.addEventListener("click", async () => {
    const value = document.querySelector("[data-release-sha]")?.textContent?.trim();
    if (!value || value === "—") return;
    await navigator.clipboard.writeText(value);
    const original = button.textContent;
    button.textContent = pageLanguage === "en" ? "Copied" : "已复制";
    window.setTimeout(() => { button.textContent = original; }, 1500);
  });
});

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.setAttribute("data-visible", "");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08 });
  document.querySelectorAll("[data-reveal]").forEach((node) => observer.observe(node));
} else {
  document.querySelectorAll("[data-reveal]").forEach((node) => node.setAttribute("data-visible", ""));
}
