const form = document.querySelector("#application-form");
const statusOutput = document.querySelector("#form-status");
const menuToggle = document.querySelector(".menu-toggle");
const navPanel = document.querySelector("#primary-menu");

function setMenuOpen(isOpen) {
  document.body.classList.toggle("nav-open", isOpen);
  menuToggle?.setAttribute("aria-expanded", String(isOpen));
  menuToggle?.setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");
}

menuToggle?.addEventListener("click", () => {
  setMenuOpen(!document.body.classList.contains("nav-open"));
});

navPanel?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => setMenuOpen(false));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setMenuOpen(false);
  }
});

document.addEventListener("click", (event) => {
  if (!document.body.classList.contains("nav-open")) return;
  const target = event.target;
  if (target instanceof Node && !navPanel?.contains(target) && !menuToggle?.contains(target)) {
    setMenuOpen(false);
  }
});

window.matchMedia("(min-width: 981px)").addEventListener("change", (event) => {
  if (event.matches) {
    setMenuOpen(false);
  }
});

form?.addEventListener("reset", () => {
  window.setTimeout(() => {
    const selectedPlan = form.querySelector('input[name="plan"]');
    if (selectedPlan) selectedPlan.value = "verification";
  });
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusOutput.textContent = "Saving application...";
  statusOutput.dataset.state = "pending";

  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  payload.agree = formData.has("agree");
  payload.brand = payload.brand || payload.name;
  payload.category = payload.category || "Human-made work";
  payload.billingCycle = payload.billingCycle || "monthly";
  payload.paymentPreference = payload.paymentPreference || "after-approval";

  try {
    const response = await fetch("/api/apply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.message || "Application could not be saved.");
    }

    form.reset();
    const selectedPlan = form.querySelector('input[name="plan"]');
    if (selectedPlan) selectedPlan.value = "verification";
    statusOutput.textContent = `Application ${result.id} received. We will contact you for the process walkthrough.`;
    statusOutput.dataset.state = "success";
  } catch (error) {
    statusOutput.textContent = error.message;
    statusOutput.dataset.state = "error";
  }
});
