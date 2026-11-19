
const pairButton = document.getElementById("pairButton");
const phoneInput = document.getElementById("phoneNumber");
const codeResult = document.getElementById("codeResult");
const pairCode = document.getElementById("pairCode");
const pairMessage = document.getElementById("pairMessage");
const copyButton = document.getElementById("copyButton");

pairButton.addEventListener("click", async () => {
  const number = phoneInput.value.replace(/\D/g, "");

  if (number.length < 10 || number.length > 15) {
    pairMessage.textContent =
      "Please enter a valid international phone number.";
    return;
  }

  pairButton.disabled = true;
  pairButton.textContent = "GENERATING CODE...";

  try {
    const response = await fetch("/api/pair", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ number })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Pairing failed.");
    }

    pairCode.textContent = data.code;
    codeResult.hidden = false;
    pairMessage.textContent =
      "Enter this code in WhatsApp Linked Devices.";

  } catch (error) {
    pairMessage.textContent = error.message;
  } finally {
    pairButton.disabled = false;
    pairButton.innerHTML =
      'GENERATE PAIRING CODE <span>→</span>';
  }
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(
      pairCode.textContent
    );
    copyButton.textContent = "COPIED!";
  } catch {
    copyButton.textContent = "COPY FAILED";
  }
});

async function updateStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();

    const online = data.status === "online";

    document.getElementById("navStatus").textContent =
      online ? "ONLINE" : data.status.toUpperCase();

    document.getElementById("connectionBadge").textContent =
      online ? "ONLINE" : data.status.toUpperCase();

    document.getElementById("connectionBadge").style.color =
      online ? "#75e6ae" : "#ff7777";

    document.querySelector(".status-dot").style.background =
      online ? "#75e6ae" : "#ff6464";

  } catch {
    document.getElementById("navStatus").textContent =
      "SERVER UNAVAILABLE";
  }
}

updateStatus();
setInterval(updateStatus, 5000);
