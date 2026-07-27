const navToggle = document.querySelector("[data-nav-toggle]");
const nav = document.querySelector("[data-nav]");
const header = document.querySelector("[data-header]");

if (navToggle && nav) {
  navToggle.addEventListener("click", () => {
    const isOpen = navToggle.getAttribute("aria-expanded") === "true";
    navToggle.setAttribute("aria-expanded", String(!isOpen));
    nav.classList.toggle("is-open", !isOpen);
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      navToggle.setAttribute("aria-expanded", "false");
      nav.classList.remove("is-open");
    });
  });
}

const updateHeader = () => {
  if (!header) return;
  header.classList.toggle("is-scrolled", window.scrollY > 18);
};

updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

const tabs = Array.from(document.querySelectorAll("[data-demo-target]"));
const panels = Array.from(document.querySelectorAll("[data-demo-panel]"));

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const targetId = tab.getAttribute("data-demo-target");

    tabs.forEach((item) => {
      const isTarget = item === tab;
      item.classList.toggle("is-active", isTarget);
      item.setAttribute("aria-selected", String(isTarget));
    });

    panels.forEach((panel) => {
      const isTarget = panel.id === targetId;
      panel.classList.toggle("is-active", isTarget);
      panel.hidden = !isTarget;
    });
  });
});

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const revealItems = document.querySelectorAll("[data-reveal]");

if (reducedMotion || !("IntersectionObserver" in window)) {
  revealItems.forEach((item) => item.classList.add("is-visible"));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.12 }
  );

  revealItems.forEach((item) => observer.observe(item));
}
