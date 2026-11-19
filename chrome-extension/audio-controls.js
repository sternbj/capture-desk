export function captureAudioState(state, channel) {
  const microphone = channel === "microphone", key = microphone ? "microphone" : "sourceAudio";
  const selected = Boolean(state.settings?.[microphone ? "microphone" : "systemAudio"]);
  const muted = state[`${key}Muted`];
  return {
    available: state.audio?.[`${key}Available`] ?? state[`${key}Available`] ?? selected,
    enabled: typeof muted === "boolean" ? !muted : state.audio?.[`${key}Enabled`] ?? state[`${key}Enabled`] ?? selected,
  };
}

export function fillMicrophoneDevices(select, devices = [], selected = "") {
  select.replaceChildren(new Option("Standardmikrofon", ""));
  const seen = new Set([""]);
  for (const device of devices) {
    if (typeof device.deviceId !== "string" || seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    select.add(new Option(device.label || `Mikrofon ${seen.size - 1}`, device.deviceId));
  }
  if (selected && !seen.has(selected)) select.add(new Option("Aktuelles Mikrofon", selected));
  select.value = selected;
}
