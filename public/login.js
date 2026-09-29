// Progressive enhancement for the password splash: submit over fetch so a wrong
// password shows an inline message instead of navigating to a JSON body. The
// form still posts natively if this script fails to load.
const form = document.querySelector("form");
const input = document.querySelector("#password");
const button = document.querySelector("button");
const error = document.querySelector(".error");

// The `.error` node is rendered by the server's inline splash. Guard anyway: a
// missing node must not throw *after* preventDefault, or submitting goes silent.
const setError = (message) => {
  if (error) error.textContent = message;
};

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("");
  button.disabled = true;
  try {
    const response = await fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: input.value }),
    });
    if (response.redirected) {
      window.location.href = response.url;
      return;
    }
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      setError(retry ? `Too many attempts. Try again in ${retry}s.` : "Too many attempts.");
    } else if (response.ok) {
      window.location.href = "/";
      return;
    } else {
      setError("Invalid credentials.");
    }
  } catch {
    setError("Unable to reach the server.");
  }
  button.disabled = false;
  input.select();
});

input?.focus();