import "./i18n.js";
import { initializeTheme } from "./theme.js";

await initializeTheme().catch(() => {});
const devices = [
  { name: "microphone", button: "testMicrophone", status: "microphoneStatus", settings: { audio: true } },
  { name: "camera", button: "testCamera", status: "cameraStatus", settings: { video: true } },
];
const buttons = devices.map(device => document.getElementById(device.button));
for (const [index, device] of devices.entries()) {
  const status = document.getElementById(device.status);
  const button = buttons[index];
  button.addEventListener("click", async () => {
    for (const control of buttons) control.disabled = true;
    status.textContent = "Zugriff wird geprüft…";
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(device.settings);
      status.textContent = "Gerät ist verfügbar";
    } catch (error) {
      status.textContent = error.name === "NotAllowedError" ? "Zugriff wurde nicht erlaubt"
        : error.name === "NotFoundError" ? "Kein Gerät gefunden" : "Gerät konnte nicht geöffnet werden";
    } finally {
      for (const track of stream?.getTracks() || []) track.stop();
      for (const control of buttons) control.disabled = false;
      if (document.hasFocus() && document.activeElement === document.body) button.focus();
    }
  });
}
